import assert from 'node:assert/strict';
import { test } from 'node:test';

import sharp from 'sharp';
import type { JpegOptions } from 'sharp';

import {
  canonicalizeImage,
  detectContentTypeFromMagic,
  ImageCanonicalizationError,
} from './canonicalize.js';
import { CANONICAL_MAX_DIMENSION, JPEG_QUALITY, PNG_COMPRESSION_LEVEL, WEBP_QUALITY } from './constants.js';

async function makeJpeg(width: number, height: number, options: JpegOptions & { orientation?: number } = {}) {
  const { orientation, ...jpegOptions } = options;
  let pipeline = sharp({
    create: { width, height, channels: 3, background: { r: 120, g: 40, b: 60 } },
  }).jpeg({ quality: 95, ...jpegOptions });
  if (orientation) pipeline = pipeline.withMetadata({ orientation });
  return pipeline.toBuffer();
}

test('large JPEG is shrunk inside 2048 on the long edge, aspect ratio kept', async () => {
  const raw = await makeJpeg(4000, 3000);
  const canonical = await canonicalizeImage(raw);
  assert.equal(canonical.contentType, 'image/jpeg');
  assert.equal(canonical.width, CANONICAL_MAX_DIMENSION);
  assert.equal(canonical.height, 1536);
  assert.ok(canonical.sizeBytes <= raw.byteLength);
});

test('images already within 2048 are not upscaled but are re-encoded', async () => {
  const raw = await makeJpeg(1200, 900);
  const canonical = await canonicalizeImage(raw);
  assert.equal(canonical.width, 1200);
  assert.equal(canonical.height, 900);
  assert.equal(canonical.contentType, 'image/jpeg');
});

test('canonicalization is deterministic for identical input', async () => {
  const raw = await makeJpeg(3000, 3000);
  const first = await canonicalizeImage(raw);
  const second = await canonicalizeImage(raw);
  assert.equal(first.sha256, second.sha256);
});

test('EXIF orientation is applied (rotate) before resize', async () => {
  // 3000x2000 landscape pixels with orientation=6 -> displayed 2000x3000 portrait.
  const raw = await makeJpeg(3000, 2000, { orientation: 6 });
  const canonical = await canonicalizeImage(raw);
  assert.ok(canonical.height > canonical.width);
  assert.equal(canonical.height, CANONICAL_MAX_DIMENSION);
  assert.equal(canonical.width, Math.round((2000 / 3000) * CANONICAL_MAX_DIMENSION));
});

test('canonical JPEG carries no EXIF/ICC/orientation residue', async () => {
  const raw = await makeJpeg(3000, 2000, { orientation: 6 });
  const canonical = await canonicalizeImage(raw);
  const metadata = await sharp(canonical.bytes).metadata();
  assert.equal(metadata.format, 'jpeg');
  assert.equal(metadata.orientation, undefined);
  assert.equal(metadata.exif, undefined);
  assert.equal(metadata.icc, undefined);
});

test('PNG input stays PNG with lossless settings', async () => {
  const raw = await sharp({
    create: { width: 2500, height: 1000, channels: 3, background: { r: 10, g: 200, b: 100 } },
  }).png({ compressionLevel: 6 }).toBuffer();
  const canonical = await canonicalizeImage(raw);
  assert.equal(canonical.contentType, 'image/png');
  assert.equal(canonical.width, CANONICAL_MAX_DIMENSION);
  assert.equal(canonical.height, Math.round((1000 / 2500) * CANONICAL_MAX_DIMENSION));
  const metadata = await sharp(canonical.bytes).metadata();
  assert.equal(metadata.format, 'png');
});

test('WebP input stays WebP', async () => {
  const raw = await sharp({
    create: { width: 3000, height: 3000, channels: 3, background: { r: 1, g: 2, b: 3 } },
  }).webp({ quality: 90 }).toBuffer();
  const canonical = await canonicalizeImage(raw);
  assert.equal(canonical.contentType, 'image/webp');
  assert.equal(canonical.width, CANONICAL_MAX_DIMENSION);
  assert.equal(canonical.height, CANONICAL_MAX_DIMENSION);
});

test('spoofed container magic fails closed', async () => {
  // RIFF/WEBP magic prepended to a JPEG payload: sniffing says WebP, decoding fails.
  const jpeg = await makeJpeg(800, 600);
  const spoofed = Buffer.concat([Buffer.from('RIFF....WEBP', 'ascii'), jpeg]);
  assert.equal(detectContentTypeFromMagic(spoofed), 'image/webp');
  await assert.rejects(
    () => canonicalizeImage(spoofed),
    (error: unknown) => error instanceof ImageCanonicalizationError,
  );
});

test('unsupported container is rejected by magic bytes', async () => {
  await assert.rejects(
    () => canonicalizeImage(Buffer.from('not an image at all')),
    (error: unknown) => error instanceof ImageCanonicalizationError && error.code === 'UNSUPPORTED_IMAGE_TYPE',
  );
});

test('byte budget is enforced at the input gate', async () => {
  const raw = await makeJpeg(800, 600);
  await assert.rejects(
    () => canonicalizeImage(raw, { maxBytes: 1024 }),
    (error: unknown) => error instanceof ImageCanonicalizationError && error.code === 'IMAGE_TOO_LARGE',
  );
});

test('constants stay pinned to the production values', () => {
  assert.equal(JPEG_QUALITY, 88);
  assert.equal(WEBP_QUALITY, 88);
  assert.equal(PNG_COMPRESSION_LEVEL, 9);
  assert.equal(CANONICAL_MAX_DIMENSION, 2048);
});
