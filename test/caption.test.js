import test from "node:test";
import assert from "node:assert/strict";
import {
  renderArtworkCaption,
  sourceLinkEntity,
  openButtonMarkup,
  buildCapFromMedia,
  toMultipartEntities,
  normalizeEntitiesForMultipart,
} from "../src/rendering/caption.js";

test("caption 不含裸 URL，来源通过 text_link entity 承载", () => {
  const { text } = renderArtworkCaption(
    { title: "Heavy Mama Hunt", author: "Mrjoel", sourceUrl: "https://www.deviantart.com/mrjoel/art/x-1376900771" },
    {},
  );
  assert.doesNotMatch(text, /https?:\/\//, "caption 文本里不应出现裸 URL");
  assert.match(text, /在 DeviantArt 打开/);
  const entity = sourceLinkEntity(text, "https://www.deviantart.com/mrjoel/art/x-1376900771");
  assert.ok(entity);
  assert.equal(entity.type, "text_link");
  assert.equal(text.slice(entity.offset, entity.offset + entity.length), "DeviantArt");
});

test("caption 排版：标题/作者/数量分行，warning 独立成行不粘连", () => {
  const { text } = renderArtworkCaption(
    { title: "T", author: "A", mediaCount: 6 },
    { compressed: true, previewOnly: true },
  );
  assert.match(text, /🎨 T/);
  assert.match(text, /👤 A/);
  assert.match(text, /🖼 6 个媒体/);
  // warning 是单独一行（⚠️），不会贴在链接或标题后面
  assert.match(text, /⚠️ 部分图片超过 10MB，已压缩发送；原图暂不可用，已使用高清展示图/);
  assert.match(text, /在 DeviantArt 打开/);
});

test("text_link entity 的 offset 按 UTF-16 code unit 计算（emoji 安全）", () => {
  const sourceUrl = "https://www.deviantart.com/a/art/b-1";
  const { text } = renderArtworkCaption({ title: "画", author: "作者" }, {});
  const entity = sourceLinkEntity(text, sourceUrl);
  // 用 Telegram 的 UTF-16 语义校验：offset/length 切出来正好是 "DeviantArt"
  const segment = text.slice(entity.offset, entity.offset + entity.length);
  assert.equal(segment, "DeviantArt");
  assert.equal(entity.url, sourceUrl);
});

test("openButtonMarkup：有来源才生成按钮，无来源时为 undefined", () => {
  const markup = openButtonMarkup("https://www.deviantart.com/x");
  assert.ok(markup?.inline_keyboard?.[0]?.[0]);
  assert.equal(markup.inline_keyboard[0][0].text, "在 DeviantArt 打开");
  assert.equal(markup.inline_keyboard[0][0].url, "https://www.deviantart.com/x");
  assert.equal(openButtonMarkup(null), undefined);
  assert.equal(openButtonMarkup(""), undefined);
});

test("buildCapFromMedia：拆分 '标题 — 作者'，计算 mediaCount", () => {
  const cap = buildCapFromMedia(
    { title: "Heavy Mama Hunt — MrjoelPreggoArt", extras: [{}, {}], skippedExtras: 1 },
    "https://www.deviantart.com/x",
  );
  assert.equal(cap.title, "Heavy Mama Hunt");
  assert.equal(cap.author, "MrjoelPreggoArt");
  assert.equal(cap.mediaCount, 4); // 主图 + 2 extras + 1 skipped
  assert.equal(cap.sourceUrl, "https://www.deviantart.com/x");
});

 test('长标题仍保留完整来源 entity', () => {
 const {text}=renderArtworkCaption({title:'😀'.repeat(1000)});
 assert.ok(text.length<=1024);
 const entity=sourceLinkEntity(text,'https://www.deviantart.com/a/art/b-1');
 assert.equal(text.slice(entity.offset,entity.offset+entity.length),'DeviantArt');
 });

test("toMultipartEntities：UTF-16 offset 换算为 code point offset（multipart 端点语义）", () => {
  // 含多个 emoji（代理对）+ 中文状态行，验证换算后按 code point 仍精确切中标签。
  const { text } = renderArtworkCaption(
    { title: "画 Heavy Mama (2,3/19)", author: "作者", mediaCount: 2 },
    { compressed: true, blurredPreview: true },
  );
  const sourceUrl = "https://www.deviantart.com/x";
  const utf16 = sourceLinkEntity(text, sourceUrl);
  assert.equal(text.slice(utf16.offset, utf16.offset + utf16.length), "DeviantArt", "UTF-16 端切中标签");
  const mp = toMultipartEntities(text, [utf16]);
  // 标签前的 emoji/高位字符使 code point 偏移小于 UTF-16 偏移
  assert.ok(mp[0].offset < utf16.offset, "code point 偏移应小于 UTF-16 偏移");
  const cpText = [...text];
  assert.equal(cpText.slice(mp[0].offset, mp[0].offset + mp[0].length).join(""), "DeviantArt", "multipart 端切中标签");

  // ASCII 标题：可预期的具体偏移（行首 3 个 emoji → 差 3）。
  const ascii = renderArtworkCaption({ title: "Plain ASCII", author: "Author" }, {}).text;
  const asciiUtf16 = sourceLinkEntity(ascii, sourceUrl);
  const asciiMp = toMultipartEntities(ascii, [asciiUtf16]);
  assert.equal(asciiUtf16.offset - asciiMp[0].offset, 3, "3 个代理对 emoji 使 UTF-16 偏移多 3");
  const asciiCp = [...ascii];
  assert.equal(asciiCp.slice(asciiMp[0].offset, asciiMp[0].offset + asciiMp[0].length).join(""), "DeviantArt");
});

test("normalizeEntitiesForMultipart：offset 与 length 都按 code point 换算", () => {
  // 人为构造一个非 ASCII 文本段实体（如中文标签），验证 length 也换算
  const text = "🎨 标题！👤 作者 🔗 中文来源段末尾";
  const utf16 = { type: "text_link", offset: text.indexOf("中文来源段"), length: "中文来源段".length, url: "https://x" };
  assert.equal(utf16.offset, 15); // 2 个 emoji 代理对使 UTF-16 偏移大于 code point 偏移
  const mp = normalizeEntitiesForMultipart(text, [utf16]);
  assert.equal(mp[0].offset, [...text.slice(0, utf16.offset)].length, "offset 转 code point");
  assert.equal(mp[0].length, [...text.slice(utf16.offset, utf16.offset + utf16.length)].length, "length 转 code point");
  const seg = [...text].slice(mp[0].offset, mp[0].offset + mp[0].length).join("");
  assert.equal(seg, "中文来源段");
});

test("JSON 路径保持 UTF-16 entity（不经过 multipart 归一化）", () => {
  const { text } = renderArtworkCaption({ title: "Heavy Mama Hunt (2,3/19)", author: "MrjoelPreggoArt", mediaCount: 2 }, { compressed: true });
  const entity = sourceLinkEntity(text, "https://www.deviantart.com/x");
  // sourceLinkEntity 输出就是 UTF-16 标准 entity，JSON 请求应原样发送
  assert.equal(text.slice(entity.offset, entity.offset + entity.length), "DeviantArt");
  // 归一化只应由 multipart 路径调用，绝不能反向污染 JSON entity
  assert.notEqual(entity.offset, normalizeEntitiesForMultipart(text, [entity])[0].offset);
});
