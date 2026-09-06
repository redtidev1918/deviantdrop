import test from "node:test";
import assert from "node:assert/strict";
import {
  renderArtworkCaption,
  sourceLinkEntity,
  openButtonMarkup,
  sourceLineText,
  buildCapFromMedia,
} from "../src/rendering/caption.js";

test("caption 不含裸 URL，来源通过 text_link entity 承载", () => {
  const { text } = renderArtworkCaption(
    { title: "Heavy Mama Hunt", author: "Mrjoel", sourceUrl: "https://www.deviantart.com/mrjoel/art/x-1376900771" },
    {},
  );
  assert.doesNotMatch(text, /https?:\/\//, "caption 文本里不应出现裸 URL");
  assert.match(text, /来源：DeviantArt/);
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
  assert.match(text, /来源：DeviantArt/);
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

test("openButtonMarkup：单媒体有来源按钮，无来源时为 undefined", () => {
  const markup = openButtonMarkup("https://www.deviantart.com/x");
  assert.ok(markup?.inline_keyboard?.[0]?.[0]);
  assert.equal(markup.inline_keyboard[0][0].text, "在 DeviantArt 打开");
  assert.equal(markup.inline_keyboard[0][0].url, "https://www.deviantart.com/x");
  assert.equal(openButtonMarkup(null), undefined);
  assert.equal(openButtonMarkup(""), undefined);
});

test("sourceLineText：文本消息里的可点击来源行带 text_link", () => {
  const { text, entities } = sourceLineText("https://www.deviantart.com/x");
  assert.match(text, /DeviantArt/);
  assert.equal(entities.length, 1);
  assert.equal(entities[0].type, "text_link");
  assert.equal(text.slice(entities[0].offset, entities[0].offset + entities[0].length), "DeviantArt");
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
