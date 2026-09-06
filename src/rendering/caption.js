// 统一的作品 caption / 按钮渲染。
//
// 关键修复：过去 caption 把说明直接拼在裸 URL 后面（如
// "https://...1376900771（原图超过 10MB，已压缩）"），URL 与括号粘连会让 Telegram
// 识别出错误/不可点的链接。现在 caption 里不放任何裸 URL：来源链接通过 Telegram
// 的 text_link entity 挂在「DeviantArt」这几个字上，边界由 entity offset/length
// 精确控制；单媒体再配一个 inline「打开」按钮（相册 sendMediaGroup 不支持内联按钮）。

const CAPTION_LIMIT = 1024;

// 把作品元数据 + 状态说明渲染成 Telegram caption 文本（不含裸 URL）。
// 返回 { text }。text_link entity 由 buildSourceEntities 另行计算（multipart/JSON 通用）。
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
  // 来源行：「DeviantArt」这几个字会被 text_link entity 指向作品页（见 sourceLinkEntity）。
  const source = "\n\n🔗 来源：DeviantArt";
  const body = lines.join("\n").slice(0, CAPTION_LIMIT - source.length).replace(/[\uD800-\uDBFF]$/, "");
  return { text: body + source };
}

// 计算「DeviantArt」来源文字的 text_link entity（offset 按 UTF-16 code unit，Telegram 规范）。
export function sourceLinkEntity(captionText, sourceUrl) {
  if (!sourceUrl) return null;
  const label = "DeviantArt";
  const idx = captionText.lastIndexOf(label);
  if (idx < 0) return null;
  return { type: "text_link", offset: idx, length: label.length, url: sourceUrl };
}

// 单媒体的 inline 键盘（相册 sendMediaGroup 会静默丢弃，不要给相册用）。
export function openButtonMarkup(sourceUrl, extraButtons = []) {
  if (!sourceUrl) return undefined;
  const row = [{ text: "在 DeviantArt 打开", url: sourceUrl }, ...extraButtons];
  return { inline_keyboard: [row] };
}

// 纯文本消息（无媒体）里使用的可点击来源行，返回 { text, entities }。
// 用于相册补发的「打开」入口、状态消息等。
export function sourceLineText(sourceUrl) {
  if (!sourceUrl) return { text: "", entities: [] };
  const label = "DeviantArt";
  const text = `作品页（含其余画面 / 未打码原图）：${label}`;
  const offset = text.indexOf(label);
  return {
    text,
    entities: [{ type: "text_link", offset, length: label.length, url: sourceUrl }],
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

// Telegram 端点对 caption_entities 偏移的计数不一致（线上实测）：
//   - JSON 请求（sendMessage/sendPhoto by URL 等）按 UTF-16 code unit 校验；
//   - multipart 上传请求（sendPhoto/sendMediaGroup 带 attach:// 文件）按 Unicode code
//     point 校验。caption 含 emoji/中文时两者会差出偏移（如 107 vs 103），按 UTF-16 发
//     multipart 会报 "entity begins in a middle of a UTF-16 symbol"。
// multipart 发送前用本函数把 UTF-16 offset 换算成 code point offset。
export function toMultipartEntities(captionText, entities) {
  if (!entities?.length) return entities || [];
  return entities.map((entity) => {
    if (entity.offset == null) return entity;
    return { ...entity, offset: [...captionText.slice(0, entity.offset)].length };
  });
}
