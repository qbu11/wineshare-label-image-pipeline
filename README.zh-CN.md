# wineshare-label-image-pipeline

从 **WineShare** 微信小程序「拍照识酒」功能中提取的、**逐字节一致**的图片规范化
（"压缩"）管线——独立打包，供模型 benchmark 使用，保证评测图片与生产管线喂给
模型的字节完全一致。

## 为什么需要它

小程序端**并不负责**产出模型可用的图片。客户端把照片（已经过微信平台压缩）原样
上传，服务端再用 [sharp](https://sharp.pixelplumbing.com/) 做一次确定性的规范化
（`sanitizerVersion: "sharp-v1"`），这是像素在到达视觉模型前被触碰的**最后一站**。
任何想让评测结果直接复用到小程序的 benchmark，都必须对评测图片做**同一次**规范化。

本仓库是该服务端处理的最小依赖、逐行移植版本，并附带完整的识别契约说明。

## 生产管线

```
手机相机 / 相册
  └─ wx.chooseMedia({ count: 1, mediaType: ['image'], sourceType, camera: 'back' })
       · 未传 sizeType → 微信默认 ['original','compressed']
       · 微信可能自行压缩/转换格式（iPhone 上 HEIC→JPEG）——平台相关，不可复现
  └─ 客户端校验（miniprogram/pages/camera + utils/api.ts）
       · magic bytes：仅 JPEG / PNG（WebP 仅服务端接受）
       · ≤ 6 MiB · 宽/高 ≤ 12000 px · 宽×高 ≤ 24 MP
       · 超限图片直接拒绝，不会缩图
  └─ 原图上传（PUT，sha256 校验）→ 对象存储（隔离区）
  └─ 服务端 sanitize ──► 本仓库 ◄──  apps/api/src/uploads/image-processor.ts
       · sharp rotate()（EXIF 方向烘焙进像素）
       · resize fit 'inside' 2048×2048，不放大，fastShrinkOnLoad
       · 重编码：JPEG q88 mozjpeg · PNG level 9 palette:false · WebP q88
       · 校验：单帧、无 EXIF/XMP/IPTC/ICC/orientation 残留
       · 存为 canonical 对象，记录 sha256
  └─ 识别 worker（apps/worker）
       · 读取 canonical 字节并校验 sha256
       · base64 inline_data → Gemini 兼容 generateContent 端点（GEYI 中转）
       · 提示词 "gemini-recognition-v1"，无采样参数覆盖
```

### 固定常量

| 常量 | 值 | 说明 |
| --- | --- | --- |
| `CANONICAL_MAX_DIMENSION` | `2048` | 长边上限，`fit: 'inside'` |
| JPEG 质量 | `88`（`mozjpeg: true`） | 重编码 |
| PNG 压缩 | `level 9`，`palette: false` | 无损重编码 |
| WebP 质量 | `88` | 重编码 |
| 客户端输入门禁 | `6 MiB`、`12000 px`、`24 MP` | 小程序 |
| 服务端输入门禁 | `8 MiB`、`24 MP` | `WINE_LABEL_MAX_SIZE_BYTES` |
| sharp 版本 | `0.35.3`（精确锁定，不用 `^`） | 字节一致性 |

注意：**即使图片本身 ≤ 2048 px 也会被重编码**（烘焙方向、剥离元数据、重置质量）。
benchmark 若对小图跳过规范化，测的就不是生产输入。

## 安装与使用

需要 Node.js ≥ 20.9。`sharp` 锁定为 `0.35.3`（WineShare 服务端实际解析版本），
其内置 libvips 保证同一平台上输出确定。

```bash
npm install        # 或 pnpm / yarn
npm run build

# 单张
node dist/cli.js photo.jpg
# → photo.canonical.jpg + 输出清单

# 批量处理评测集
node dist/cli.js eval-set/*.jpg --out-dir eval-set-canonical --json manifest.json --continue-on-error
```

编程方式调用：

```ts
import { canonicalizeImage } from 'wineshare-label-image-pipeline';

const canonical = await canonicalizeImage(buffer);
// { bytes, contentType, sizeBytes, sha256, width, height }
```

## 字节一致性说明

- 相同输入字节 + 相同 sharp 版本 ⇒ 相同输出字节（及相同 sha256）——在同一
  平台/libvips 构建下成立。像素值跨平台一致；编码器个别角落行为可能随
  libvips 架构有微小差异——如需跨机器比对原始字节，请固定 benchmark 运行平台。
- `sharp.cache({files:0, items:20, memory:32})` 与 `sharp.concurrency(1)` 仅影响
  性能，已从服务端原样保留。
- `ignoreIcc: true` 表示像素值**不做色彩空间管理**，ICC 配置被丢弃。iPhone 的
  广色域（Display P3）照片保留原始像素值。

## 识别契约（benchmark 对齐用）

仅对齐压缩还不够。WineShare worker 这样把 canonical 图片发给模型
（apps/worker/src/ai/vision-gemini.client.ts）：

- **端点**：`${GEYI_API_BASE_URL}/v1beta/models/${model}:streamGenerateContent?alt=sse`
  （Gemini 兼容中转；鉴权头 `x-goog-api-key`）。同一运行时也接受非流式
  `:generateContent`，回答一致。
- **请求体**：一条 user content、两个 part——提示词文本 + `{ inline_data:
  { mime_type, data: <canonical 字节的 base64> } }`。
- **提示词**（原文，`PROMPT_VERSION = "gemini-recognition-v1"`）：

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

- **采样**：无。不覆盖 temperature/top-p/top-k——使用模型默认值。
- **超时/回退**（生产行为，决定"实际由哪个模型回答"）：总计
  `GEYI_RECOGNITION_TIMEOUT_MS` = 30 秒。配置 `GEYI_RECOGNITION_FALLBACK_MODEL` 后，
  主模型分到 ⌊30 × 2/3⌋ = 20 秒，回退模型分到剩余 10 秒。仅当
  `UPSTREAM_TIMEOUT` / `UPSTREAM_RATE_LIMITED` / `UPSTREAM_UNAVAILABLE` /
  `UPSTREAM_INVALID_RESPONSE` 时回退——鉴权失败和内容拒绝不回退。
- **响应处理**：SSE 文本 part 拼接（排除思考 part）；剥离代码围栏；结果必须解析为
  只含上述键的单个 JSON 对象（未知字段为 `null`，未知葡萄为 `[]`）。评测打分应基于
  该 schema 解析后的字段，而不是原始文本。

## 除压缩外：对齐清单

以下任何一项被忽略，都会让 benchmark 结果无法复用到小程序：

1. **微信客户端一跳不确定**。`wx.chooseMedia` 未传 `sizeType` 时使用平台默认，
   微信可能在上传前压缩/转换格式（尤其 iPhone 的 HEIC→JPEG）。建议采集真机上传
   样本刻画这一跳；评测原图请保持 JPEG/PNG、≤ 6 MiB / 24 MP / 12000 px，以通过
   与客户端相同的门禁。
2. **超限输入是被拒绝而非缩图**。超过限制的图在生产中永远到不了模型；评测集中
   这类样本应剔除或预先裁剪。
3. **方向**。竖拍的酒标照片带 EXIF 旋转；本管线会烘焙方向。评测图片的 EXIF 状态
   应与生产拍摄一致（或统一走本管线做规范化）。
4. **提示词与 schema**（见上）。识别质量对提示词敏感，"回答丰富度"尤其如此。
   对比评测必须冻结同一提示词。
5. **采样默认值**。生产不下发任何覆盖参数。benchmark 一旦设置 temperature，
   结果即与生产行为脱钩。
6. **实际回答的是哪个模型**。回退开启时，生产环境的一条回答可能来自回退模型。
   benchmark 应逐条记录模型身份；测量延迟敏感行为时应复刻 20 s/10 s 的分配。
7. **供应端预处理**。中转/模型服务端可能按 token 上限截断或分块（tiling）图片。
   端点+模型一致则两边一致；"同一个模型"的不同部署未必一致。
8. **色彩管理**。`ignoreIcc` 保留原始像素值。若评测集混有 sRGB 与 Display P3 拍摄
   的样本，颜色与色彩管理查看器会有差异——生产行为相同，benchmark 不要"修正"它。

## 仓库结构

- `src/canonicalize.ts` — 移植自 `ImageProcessor.sanitize` 的核心管线
- `src/constants.ts` — 锁定的生产常量
- `src/cli.ts` — `wineshare-canonicalize` CLI（单张/批量/JSON 清单）
- `src/canonicalize.test.ts` — node:test 测试：缩放、EXIF 方向、确定性、容器嗅探、限额门禁

## License

MIT
