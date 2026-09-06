// 统一的作品 caption / 来源渲染。
//
// 设计：媒体消息的 caption 只放标题/作者/数量/状态，**不放来源链接、不放 entity**。
// 来源用「一个可靠、可点击的入口」单独承载，且每个作品只有一个、绝不重复：
//   - 单图/单视频：inline 键盘按钮「🔗 在 DeviantArt 打开」。按钮在所有路径
//     （JSON 传 URL、file_id 重放、multipart 上传/文档降级）都可靠生效。
//   - 相册（多图）：Telegram 的 sendMediaGroup（无论 JSON 还是 multipart、无论顶层
//     还是条目级 reply_markup）都会静默丢弃按钮，所以相册发完后**补发一条 JSON
//     sendMessage 文本**，来源用 text_link 承载。
//     —— 必须是独立 JSON 文本消息：multipart 上传端点对自定义 caption_entities 的
//     offset/length 处理有 bug（按 code point 收、却按 UTF-16/字节存，含 emoji 时
//     高亮错位，实测 2026-09），而 JSON sendMessage 的 text_link entity（UTF-16）始终正确。

const CAPTION_LIMIT = 1024;

// 可点文字 / 按钮里的标签。
export const SOURCE_LABEL = "DeviantArt";
export const SOURCE_BUTTON_TEXT = "🔗 在 DeviantArt 打开";

// 媒体 caption（无来源、无 entity，避免 multipart offset bug）。返回 { text }。
export function renderArtworkCaption(meta = {}, status = {}) {
  const lines = [];
  const title = (meta.title || "DeviantArt 作品").trim();
  lines.push(`🎨 ${title}`);
  if (meta.author) lines.push(`👤 ${meta.author}`);
  if (Number.isInteger(meta.mediaCount) && meta.mediaCount > 1) {
    lines.push(`🖼 ${meta.mediaCount} 个媒体`);
  }
  const notes = [];
  if (status.compressed) notes.push("部分图片超过 10MB，已压缩发送");
  if (status.blurredPreview) notes.push("部分成熟内容无法获取未打码画面，请在原站查看");
  if (status.previewOnly) notes.push("原图暂不可用，已使用高清展示图");
  if (status.docFallback) notes.push("图片过大，已作为文件发送");
  if (notes.length) lines.push(`⚠️ ${notes.join("；")}`);
  const body = lines.join("\n").slice(0, CAPTION_LIMIT).replace(/[\uD800-\uDBFF]$/, "");
  return { text: body };
}

// 单媒体的 inline 键盘（仅单图/单视频用；相册会被静默丢弃，相册改走补发文本）。
// 也用于非媒体消息（如 Telegraph 兜底入口）。
export function openButtonMarkup(sourceUrl, extraButtons = []) {
  if (!sourceUrl) return undefined;
  const row = [{ text: SOURCE_BUTTON_TEXT, url: sourceUrl }, ...extraButtons];
  return { inline_keyboard: [row] };
}

// 相册用：补发的一条可点击来源文本（JSON sendMessage，text_link 按 UTF-16 始终正确）。
// 返回 { text, entities }。文本短，只含一个 emoji（🔗，单个代理对，无 offset 歧义）。
export function sourceLineText(sourceUrl) {
  if (!sourceUrl) return { text: "", entities: [] };
  const text = SOURCE_BUTTON_TEXT; // 「🔗 在 DeviantArt 打开」
  const idx = text.lastIndexOf(SOURCE_LABEL);
  return {
    text,
    entities: [{ type: "text_link", offset: idx, length: SOURCE_LABEL.length, url: sourceUrl }],
  };
}

// 把 resolveWebMedia 的 media 对象 + 作品页 URL 归一化成发送函数使用的 cap：
// { title, author, mediaCount, sourceUrl }。下载/压缩阶段的状态由发送函数内部重渲染。
export function buildCapFromMedia(media, sourceUrl) {
  // media.title 形如 "标题 — 作者"，拆回标题/作者；拆不出就整串当标题。
  let title = media?.title || "DeviantArt 作品";
  let author;
  const m = String(title).match(/^(.*?)\s+—\s+([^—]+)$/);
  if (m) { title = m[1].trim(); author = m[2].trim(); }
  const mediaCount = 1 + (media?.extras?.length || 0) + (media?.skippedExtras || 0);
  return {
    title, author, sourceUrl,
    mediaCount: mediaCount > 1 ? mediaCount : undefined,
    status: { ...(media?.status || {}) },
    text: null,
  };
}

// 用 cap 直接产出 { text, entities }（渲染 + entity 一次完成）。
export function renderCap(cap, statusOverride = {}) {
  const status = { ...(cap.status || {}), ...statusOverride };
  const { text } = renderArtworkCaption(
    { title: cap.title, author: cap.author, mediaCount: cap.mediaCount },
    status,
  );
  const entity = sourceLinkEntity(text, cap.sourceUrl);
  return { text, entities: entity ? [entity] : [] };
}

// Telegram MessageEntity 的 offset/length 在 JSON Bot API 请求里按 UTF-16 code unit；
// sourceLinkEntity 产出的正是标准 UTF-16 entity，JSON 请求（sendPhoto/sendMediaGroup 传 URL
// 或 file_id）原样发送。
//
// 但 multipart 上传端点（sendPhoto/sendMediaGroup/sendDocument 带 attach:// 文件，
// caption 走 form-data 字段）实测按 **Unicode code point** 解释 offset/length，服务端
// 再转回 UTF-16 存储。线上实测（2026-09，读回 sendDocument 的 caption_entities 验证）：
//   - 发 UTF-16 偏移：落在多字节字符中间 → 400 "entity begins in a middle of a
//     UTF-16 symbol at byte offset N"；
//   - 发 UTF-8 字节偏移：400 "ends after the end of the text"（字节数 > UTF-16 长度）；
//   - 发 code-point 偏移：200 接受，读回的 offset = 发送值 − 标签前代理对(emoji)数，
//     length = 标签码点数，切片正好是 "DeviantArt"。
// 所以 multipart 路径必须把 UTF-16 的 offset/length 换算成 code point。
// 若将来 Telegram 修复该差异，删掉此层即可，JSON 路径不受影响。
export function normalizeEntitiesForMultipart(text, entities) {
  if (!entities?.length) return entities || [];
  const cp = [...text];
  return entities.map((entity) => {
    if (entity.offset == null) return entity;
    // text.slice 按 UTF-16 单位切；再展开成 code point 计数。
    const beforeCp = [...text.slice(0, entity.offset)].length;
    const segmentCp = entity.length != null ? [...text.slice(entity.offset, entity.offset + entity.length)].length : null;
    return {
      ...entity,
      offset: beforeCp,
      length: segmentCp != null ? segmentCp : entity.length,
    };
  });
}
// 兼容别名（v1.5.1 之前的导出名，避免外部/历史引用破裂）。
export const toMultipartEntities = normalizeEntitiesForMultipart;
