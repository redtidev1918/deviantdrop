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
// opts.showNotes=false 时省略技术性 ⚠️ 提示（压缩/打码/原图不可用/转文件）：
// 这些对运营者排查有用，对群里看图的人是噪音，群聊默认不显示（见 index.js 的 captionNotesEnabled）。
export function renderArtworkCaption(meta = {}, status = {}, { showNotes = true } = {}) {
  const lines = [];
  const title = (meta.title || "DeviantArt 作品").trim();
  lines.push(`🎨 ${title}`);
  if (meta.author) lines.push(`👤 ${meta.author}`);
  if (Number.isInteger(meta.mediaCount) && meta.mediaCount > 1) {
    lines.push(`🖼 ${meta.mediaCount} 个媒体`);
  }
  if (showNotes) {
    const notes = [];
    if (status.compressed) notes.push("部分图片超过 10MB，已压缩发送");
    if (status.blurredPreview) notes.push("部分成熟内容无法获取未打码画面，请在原站查看");
    if (status.previewOnly) notes.push("原图暂不可用，已使用高清展示图");
    if (status.docFallback) notes.push("图片过大，已作为文件发送");
    if (notes.length) lines.push(`⚠️ ${notes.join("；")}`);
  }
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
