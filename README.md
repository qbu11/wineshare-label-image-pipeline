# wineshare-label-image-pipeline

Byte-compatible extraction of the image canonicalization ("compression")
pipeline used by the **WineShare** WeChat mini-program's photo-based wine-label
recognition — packaged so a model benchmark can feed candidate models exactly
the bytes the production pipeline would produce.

中文说明见 [README.zh-CN.md](./README.zh-CN.md).

## Why this exists

The mini program does **not** rely on the client to produce model-ready
images. The client uploads the (already platform-compressed) photo; the server
then runs a deterministic [sharp](https://sharp.pixelplumbing.com/) pass
(`sanitizerVersion: "sharp-v1"`) that is the last thing to touch the pixels
before the vision model sees them. Any benchmark that wants its results to
transfer to the mini program must apply the *same* pass to its eval images.

This repo is a dependency-minimal, line-for-line port of that server pass,
plus the surrounding recognition contract needed for full benchmark parity.

## The production pipeline

```
device camera / album
  └─ wx.chooseMedia({ count: 1, mediaType: ['image'], sourceType, camera: 'back' })
       · no sizeType → WeChat default ['original','compressed']
       · WeChat may compress/convert (HEIC→JPEG) — platform-dependent, NOT reproducible
  └─ client validation (miniprogram/pages/camera + utils/api.ts)
       · magic bytes: JPEG or PNG (WebP accepted server-side only)
       · size ≤ 6 MiB · width/height ≤ 12000 px each · width×height ≤ 24 MP
       · oversized images are REJECTED, never downscaled
  └─ raw upload (PUT, sha256-checked) → object storage (quarantine)
  └─ server sanitize ──► THIS REPO ◄──  apps/api/src/uploads/image-processor.ts
       · sharp rotate()  (EXIF auto-orientation baked into pixels)
       · resize fit 'inside' 2048×2048, withoutEnlargement, fastShrinkOnLoad
       · re-encode: JPEG q88 mozjpeg · PNG level 9 palette:false · WebP q88
       · verify: single frame, no EXIF/XMP/IPTC/ICC/orientation residue
       · stored as canonical object; sha256 recorded
  └─ recognition worker (apps/worker)
       · reads canonical bytes, sha256-verified
       · base64 inline_data → Gemini-compatible generateContent endpoint (GEYI relay)
       · prompt "gemini-recognition-v1", no sampling overrides
```

### Pinned constants

| Constant | Value | Source |
| --- | --- | --- |
| `CANONICAL_MAX_DIMENSION` | `2048` | longest side, `fit: 'inside'` |
| JPEG quality | `88` (`mozjpeg: true`) | re-encode |
| PNG compression | `level 9`, `palette: false` | lossless re-encode |
| WebP quality | `88` | re-encode |
| Client input gate | `6 MiB`, `12000 px`, `24 MP` | mini program |
| Server input gate | `8 MiB`, `24 MP` | `WINE_LABEL_MAX_SIZE_BYTES` |
| sharp version | `0.35.3` (pinned, not `^`) | byte parity |

Even images already ≤ 2048 px are **re-encoded** (orientation baked, metadata
stripped, quality reset). A benchmark that skips canonicalization for small
images is not testing production inputs.

## Install & use

Requires Node.js ≥ 20.9. `sharp` is pinned to `0.35.3` (the exact version the
WineShare server resolves); the bundled libvips makes output deterministic per
platform.

```bash
npm install        # or: pnpm install / yarn
npm run build

# single file
node dist/cli.js photo.jpg
# → photo.canonical.jpg + manifest line

# batch an eval set
node dist/cli.js eval-set/*.jpg --out-dir eval-set-canonical --json manifest.json --continue-on-error
```

Programmatic use:

```ts
import { canonicalizeImage } from 'wineshare-label-image-pipeline';

const canonical = await canonicalizeImage(buffer);
// { bytes, contentType, sizeBytes, sha256, width, height }
```

## Byte parity notes

- Same input bytes + same sharp version ⇒ same output bytes (and same sha256)
  on the same platform/libvips build. Pixel values are identical across
  platforms; rare corner cases in encoder tie-breaking can differ across
  libvips architectures — pin the benchmark runner's platform if you diff raw
  bytes across machines.
- `sharp.cache({files:0, items:20, memory:32})` and `sharp.concurrency(1)`
  are performance-only settings, mirrored from the server.
- `ignoreIcc: true` means pixel values are **not** color-managed into a
  working space; the ICC profile is dropped. Wide-gamut (Display P3) iPhone
  photos keep their raw values.

## Recognition contract (for benchmark parity)

Preprocessing alone is not enough. The WineShare worker sends the canonical
image to the model like this (apps/worker/src/ai/vision-gemini.client.ts):

- **Endpoint**: `${GEYI_API_BASE_URL}/v1beta/models/${model}:streamGenerateContent?alt=sse`
  (Gemini-compatible relay; auth header `x-goog-api-key`). Non-streaming
  `:generateContent` is accepted by the same runtime and yields the same
  answers.
- **Body**: one user content, two parts — the prompt text, then
  `{ inline_data: { mime_type, data: <base64 of canonical bytes> } }`.
- **Prompt** (exact text, `PROMPT_VERSION = "gemini-recognition-v1"`):

  ```
  Identify the wine from this wine-label photo.
  Return exactly one JSON object — one continuous JSON string, no markdown, no code fences, no explanation, no other text.
  Keys exactly: name, nameZh, cuvee, vintage, country, region, subRegion, producer, grapes, alcoholDegree, wineType, appellation.
  name, nameZh, cuvee, country, region, subRegion, producer, appellation: JSON string or null.
  vintage: integer from 1000 through 9999, or null.
  grapes: JSON array of strings, [] when unknown.
  alcoholDegree: JSON number from 0 through 100, or null.
  wineType: exactly one of red, white, rose, sparkling, dessert, fortified, orange, other, or null.
  Use null for every unknown value; do not invent facts that are not visible on the label.
  ```

- **Sampling**: none. No temperature/top-p/top-k overrides — model defaults apply.
- **Timeouts/fallback** (production behavior, affects *which model answers*):
  total `GEYI_RECOGNITION_TIMEOUT_MS` = 30 s. With `GEYI_RECOGNITION_FALLBACK_MODEL`
  configured, the primary gets ⌊30 × 2/3⌋ = 20 s and the fallback gets the
  remaining 10 s. Fallback fires only on `UPSTREAM_TIMEOUT`,
  `UPSTREAM_RATE_LIMITED`, `UPSTREAM_UNAVAILABLE`, `UPSTREAM_INVALID_RESPONSE`
  — never on auth failure or content rejection.
- **Response handling**: SSE text parts are concatenated (thought parts
  excluded); code fences are stripped; the result must parse as one JSON
  object with exactly the keys above (`null` for unknowns, empty array for
  unknown grapes). Grading should compare against that schema, not raw text.

## Beyond compression: parity checklist

Items that silently break benchmark→mini-program transfer if ignored:

1. **The WeChat client hop is not deterministic.** `wx.chooseMedia` without
   `sizeType` uses the platform default and WeChat may compress/convert
   (notably HEIC→JPEG on iPhone) before upload. Characterize it by collecting
   real-device uploads, and keep eval originals as JPEG/PNG ≤ 6 MiB / 24 MP /
   12000 px so they pass the same client gate.
2. **Oversized inputs are rejected, not resized.** Anything above the limits
   never reaches the model in production; exclude or pre-crop such eval items.
3. **Orientation.** Label photos shot in portrait are EXIF-rotated; this
   pipeline bakes that. Benchmark images must carry the same EXIF state as the
   production capture (or go through this pipeline, which normalizes it).
4. **Prompt & schema** (above). Recognition quality is prompt-sensitive;
   "richness" scores especially. Freeze the exact prompt for comparability.
5. **Sampling defaults.** No overrides are sent. If a benchmark sets
   temperature, results no longer match production behavior.
6. **Which model actually answered.** Under fallback, a production answer may
   come from the fallback model. Benchmarks should record model identity per
   call and mirror the 20 s/10 s split when measuring latency-sensitive
   behavior.
7. **Provider-side preprocessing.** The relay/model may cap or tile image
   tokens server-side. Same endpoint + same model keeps this identical; a
   different deployment of the "same" model may not be.
8. **Color management.** `ignoreIcc` keeps raw pixel values. If your eval set
   mixes sRGB and Display P3 captures, expect color shifts versus what a
   color-managed viewer shows — production behaves the same way, so don't
   "fix" it in the benchmark.

## Repository layout

- `src/canonicalize.ts` — the ported `ImageProcessor.sanitize` pipeline
- `src/constants.ts` — pinned production constants
- `src/cli.ts` — `wineshare-canonicalize` CLI (single + batch + JSON manifest)
- `src/canonicalize.test.ts` — node:test suite covering resize, orientation,
  determinism, container sniffing, and budget gates

## License

MIT
