import { createHash } from 'node:crypto';

import sharp from 'sharp';
import type { Metadata, OutputInfo, Sharp } from 'sharp';

import {
  CANONICAL_MAX_DIMENSION,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_PIXELS,
  JPEG_QUALITY,
  PNG_COMPRESSION_LEVEL,
  WEBP_QUALITY,
} from './constants.js';

export type SupportedImageContentType = 'image/jpeg' | 'image/png' | 'image/webp';

export interface CanonicalImage {
  readonly bytes: Buffer;
  readonly contentType: SupportedImageContentType;
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly width: number;
  readonly height: number;
}

export interface CanonicalizeOptions {
  /** Input/output byte budget. Default: 8 MiB (server hard cap; client uses 6 MiB). */
  readonly maxBytes?: number;
  /** Input/output pixel budget. Default: 24 MP. */
  readonly maxPixels?: number;
}

export type CanonicalizationErrorCode =
  | 'UNSUPPORTED_IMAGE_TYPE'
  | 'CONTAINER_MISMATCH'
  | 'MULTI_FRAME_IMAGE'
  | 'IMAGE_DIMENSIONS_EXCEEDED'
  | 'IMAGE_TOO_LARGE'
  | 'CANONICALIZATION_FAILED'
  | 'CANONICAL_INVARIANT_VIOLATED';

export class ImageCanonicalizationError extends Error {
  readonly code: CanonicalizationErrorCode;

  constructor(code: CanonicalizationErrorCode, message: string) {
    super(message);
    this.name = 'ImageCanonicalizationError';
    this.code = code;
  }
}

const CONTENT_TYPE_BY_FORMAT = {
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
} as const;

const EXTENSION_BY_CONTENT_TYPE = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
} as const;

// Same process-level settings as the WineShare API server. They only affect
// performance, not output bytes.
sharp.cache({ files: 0, items: 20, memory: 32 });
sharp.concurrency(1);

/** Container sniffing identical to the client's magic-byte detection. */
export function detectContentTypeFromMagic(raw: Buffer): SupportedImageContentType | null {
  const jpeg = raw.byteLength >= 3
    && raw[0] === 0xff
    && raw[1] === 0xd8
    && raw[2] === 0xff;
  const png = raw.byteLength >= 8
    && raw.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const webp = raw.byteLength >= 12
    && raw.subarray(0, 4).toString('ascii') === 'RIFF'
    && raw.subarray(8, 12).toString('ascii') === 'WEBP';
  if (jpeg) return 'image/jpeg';
  if (png) return 'image/png';
  if (webp) return 'image/webp';
  return null;
}

export function extensionForContentType(contentType: SupportedImageContentType): string {
  return EXTENSION_BY_CONTENT_TYPE[contentType];
}

/**
 * Deterministic image canonicalization, byte-for-byte ported from
 * `ImageProcessor.sanitize` in the WineShare API server (`sharp-v1`).
 *
 * Pipeline: magic-byte sniff -> container/format/page checks -> EXIF
 * auto-orientation (`rotate()`) -> longest-side 2048 `inside` resize
 * (never upscale, fast shrink on load) -> re-encode (JPEG q88 mozjpeg /
 * PNG level 9 non-palette / WebP q88) -> verify no metadata residue.
 */
export async function canonicalizeImage(
  raw: Buffer,
  options: CanonicalizeOptions = {},
): Promise<CanonicalImage> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxPixels = options.maxPixels ?? DEFAULT_MAX_PIXELS;

  const contentType = detectContentTypeFromMagic(raw);
  if (!contentType) {
    throw new ImageCanonicalizationError(
      'UNSUPPORTED_IMAGE_TYPE',
      'Only JPEG, PNG and WebP are supported (magic-byte check).',
    );
  }
  if (raw.byteLength > maxBytes) {
    throw new ImageCanonicalizationError(
      'IMAGE_TOO_LARGE',
      `Input is ${raw.byteLength} bytes, exceeding the ${maxBytes}-byte budget.`,
    );
  }

  const sharpInputOptions = {
    animated: true,
    failOn: 'warning',
    ignoreIcc: true,
    limitInputChannels: 4,
    limitInputPixels: maxPixels,
    sequentialRead: true,
    unlimited: false,
  } as const;

  let metadata: Metadata;
  let source: Sharp;
  try {
    source = sharp(raw, sharpInputOptions);
    metadata = await source.metadata();
  } catch {
    throw new ImageCanonicalizationError('CANONICALIZATION_FAILED', 'Image cannot be decoded.');
  }

  const detectedContentType = CONTENT_TYPE_BY_FORMAT[metadata.format as keyof typeof CONTENT_TYPE_BY_FORMAT];
  if (detectedContentType !== contentType) {
    throw new ImageCanonicalizationError(
      'CONTAINER_MISMATCH',
      `Container is ${contentType} but decoded format is ${String(metadata.format)}.`,
    );
  }
  if ((metadata.pages ?? 1) !== 1) {
    throw new ImageCanonicalizationError(
      'MULTI_FRAME_IMAGE',
      'Animated/multi-frame images are rejected by the product pipeline.',
    );
  }

  const sourceWidth = metadata.autoOrient.width;
  const sourceHeight = metadata.autoOrient.height;
  if (
    !Number.isSafeInteger(sourceWidth)
    || !Number.isSafeInteger(sourceHeight)
    || sourceWidth <= 0
    || sourceHeight <= 0
    || sourceWidth * sourceHeight > maxPixels
  ) {
    throw new ImageCanonicalizationError(
      'IMAGE_DIMENSIONS_EXCEEDED',
      `Dimensions ${String(sourceWidth)}x${String(sourceHeight)} exceed the ${maxPixels}-pixel budget.`,
    );
  }

  const oriented = source.rotate().resize({
    width: CANONICAL_MAX_DIMENSION,
    height: CANONICAL_MAX_DIMENSION,
    fit: 'inside',
    withoutEnlargement: true,
    fastShrinkOnLoad: true,
  });
  const encoded = contentType === 'image/jpeg'
    ? oriented.jpeg({ quality: JPEG_QUALITY, mozjpeg: true })
    : contentType === 'image/png'
      ? oriented.png({ compressionLevel: PNG_COMPRESSION_LEVEL, palette: false })
      : oriented.webp({ quality: WEBP_QUALITY });

  let result: { data: Buffer; info: OutputInfo };
  try {
    result = await encoded.toBuffer({ resolveWithObject: true });
  } catch {
    throw new ImageCanonicalizationError('CANONICALIZATION_FAILED', 'Re-encode failed.');
  }
  if (
    result.info.size !== result.data.byteLength
    || result.data.byteLength > maxBytes
    || result.info.width <= 0
    || result.info.height <= 0
    || result.info.width > CANONICAL_MAX_DIMENSION
    || result.info.height > CANONICAL_MAX_DIMENSION
    || result.info.width * result.info.height > maxPixels
  ) {
    throw new ImageCanonicalizationError(
      'CANONICAL_INVARIANT_VIOLATED',
      'Canonical output violates size/dimension invariants.',
    );
  }

  // Re-decode the canonical bytes and require a metadata-free single-frame
  // image of the same format — the same invariant the server enforces.
  let canonicalMetadata: Metadata;
  try {
    canonicalMetadata = await sharp(result.data, sharpInputOptions).metadata();
  } catch {
    throw new ImageCanonicalizationError('CANONICAL_INVARIANT_VIOLATED', 'Canonical output is not decodable.');
  }
  if (
    canonicalMetadata.format !== metadata.format
    || (canonicalMetadata.pages ?? 1) !== 1
    || canonicalMetadata.exif !== undefined
    || canonicalMetadata.xmp !== undefined
    || canonicalMetadata.iptc !== undefined
    || canonicalMetadata.icc !== undefined
    || canonicalMetadata.orientation !== undefined
  ) {
    throw new ImageCanonicalizationError(
      'CANONICAL_INVARIANT_VIOLATED',
      'Canonical output carries metadata residue (EXIF/XMP/IPTC/ICC/orientation).',
    );
  }

  return {
    bytes: result.data,
    contentType,
    sizeBytes: result.data.byteLength,
    sha256: createHash('sha256').update(result.data).digest('hex'),
    width: result.info.width,
    height: result.info.height,
  };
}
