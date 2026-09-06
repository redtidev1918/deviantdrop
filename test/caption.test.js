import test from "node:test";
import assert from "node:assert/strict";
import {
  renderArtworkCaption,
  openButtonMarkup,
  sourceLineText,
  buildCapFromMedia,
} from "../src/rendering/caption.js";

test("媒体 caption 只含标题/作者/数量/状态，不含任何链接或来源行", () => {
  const { text } = renderArtworkCaption(
    { title: "Heavy Mama Hunt", author: "Mrjoel" },
    {},
  );
  assert.match(text, /🎨 Heavy Mama Hunt/);
  assert.match(text, /👤 Mrjoel/);
  assert.doesNotMatch(text, /https?:\/\//, "caption 文本里不应出现裸 URL");
  assert.doesNotMatch(text, /DeviantArt 打开|来源/, "caption 不应含来源行（来源改由按钮/补发文本承载）");
});

test("caption 排版：标题/作者/数量分行，warning 独立成行不粘连", () => {
  const { text } = renderArtworkCaption(
    { title: "T", author: "A", mediaCount: 6 },
    { compressed: true, previewOnly: true },
  );
  assert.match(text, /🎨 T/);
  assert.match(text, /👤 A/);
  assert.match(text, /🖼 6 个媒体/);
  // warning 是单独一行（⚠️），不贴在标题后面
  assert.match(text, /⚠️ 部分图片超过 10MB，已压缩发送；原图暂不可用，已使用高清展示图/);
});

test("openButtonMarkup：单媒体 inline 按钮，无来源时为 undefined", () => {
  const markup = openButtonMarkup("https://www.deviantart.com/x");
  assert.ok(markup?.inline_keyboard?.[0]?.[0]);
  assert.equal(markup.inline_keyboard[0][0].url, "https://www.deviantart.com/x");
  assert.match(markup.inline_keyboard[0][0].text, /在 DeviantArt 打开/);
  assert.equal(openButtonMarkup(null), undefined);
  assert.equal(openButtonMarkup(""), undefined);
});

test("sourceLineText：相册补发文本带 text_link，offset 按 UTF-16 切中 DeviantArt", () => {
  const { text, entities } = sourceLineText("https://www.deviantart.com/x");
  assert.ok(text.includes("DeviantArt"));
  assert.equal(entities.length, 1);
  assert.equal(entities[0].type, "text_link");
  assert.equal(entities[0].url, "https://www.deviantart.com/x");
  // 🔗 是单个代理对 emoji；UTF-16 slice 仍应精确切中 "DeviantArt"
  assert.equal(text.slice(entities[0].offset, entities[0].offset + entities[0].length), "DeviantArt");
  assert.deepEqual(sourceLineText(""), { text: "", entities: [] });
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

test("长标题 caption 截断到 1024 以内", () => {
  const { text } = renderArtworkCaption({ title: "😀".repeat(1000) });
  assert.ok(text.length <= 1024);
});

test("技术性 ⚠️ 提示：showNotes=true 显示，false 省略", () => {
  const status = { compressed: true, previewOnly: true };
  const withNotes = renderArtworkCaption({ title: "T", author: "A" }, status, { showNotes: true }).text;
  const withoutNotes = renderArtworkCaption({ title: "T", author: "A" }, status, { showNotes: false }).text;
  assert.match(withNotes, /⚠️/);
  assert.match(withNotes, /已压缩发送/);
  assert.doesNotMatch(withoutNotes, /⚠️/);
  assert.doesNotMatch(withoutNotes, /已压缩发送/);
  assert.doesNotMatch(withoutNotes, /原图暂不可用/);
  // 标题/作者仍保留
  assert.match(withoutNotes, /🎨 T/);
  assert.match(withoutNotes, /👤 A/);
});
