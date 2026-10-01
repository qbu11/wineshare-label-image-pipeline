/**
 * Constants mirrored from the WineShare server
 * (`apps/api/src/uploads/image-processor.ts`, `packages/domain/src/upload.ts`).
 *
 * Do NOT tune these for benchmark convenience: any deviation makes the
 * preprocessed eval images differ from what the mini-program pipeline would
 * produce for the same photo.
 */
export const SANITIZER_VERSION = 'sharp-v1';

/** Longest side of the canonical image. `fit: 'inside'`, never upscaled. */
export const CANONICAL_MAX_DIMENSION = 2_048;

/** JPEG re-encode quality (`mozjpeg: true`). */
export const JPEG_QUALITY = 88;

/** WebP re-encode quality. */
export const WEBP_QUALITY = 88;

/** PNG zlib compression level. Lossless — only affects file size. */
export const PNG_COMPRESSION_LEVEL = 9;

/**
 * Server-side hard cap for WINE_LABEL uploads
 * (`WINE_LABEL_MAX_SIZE_BYTES`, 8 MiB). The mini-program client enforces a
 * stricter 6 MiB gate before upload, so images produced for the benchmark
 * should stay <= 6 MiB to reflect the real product path.
 */
export const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;

/** Server-side hard cap for WINE_LABEL pixels (24 MP). */
export const DEFAULT_MAX_PIXELS = 24_000_000;
