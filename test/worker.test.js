import test from "node:test";
import assert from "node:assert/strict";
import worker, {
  extractDeviantArtMedia,
  extractDeviantArtUrls,
  parseDeviantArtTarget,
} from "../src/index.js";

test("parses plain, hidden, schemeless and multiple DeviantArt links", () => {
  const hiddenText = "先看 www.deviantart.com/bob/art/second-2，再点这里。";
  assert.deepEqual(
    extractDeviantArtUrls(hiddenText, [{
      type: "text_link",
      offset: hiddenText.indexOf("这里"),
      length: 2,
      url: "http://www.deviantart.com/alice/art/first-1#comments",
    }]),
    [
      "https://www.deviantart.com/bob/art/second-2",
      "https://www.deviantart.com/alice/art/first-1",
    ],
  );
  assert.deepEqual(extractDeviantArtUrls("https://fav.me/dabc https://fav.me/dabc"), ["https://fav.me/dabc"]);
  const entityText = "🙂 www.deviantart.com/cat/art/entity-3";
  assert.deepEqual(extractDeviantArtUrls(entityText, [{
    type: "url",
    offset: "🙂 ".length,
    length: "www.deviantart.com/cat/art/entity-3".length,
  }]), ["https://www.deviantart.com/cat/art/entity-3"]);
  assert.deepEqual(
    parseDeviantArtTarget(new URL("https://www.deviantart.com/loish/art/demo-913624585")),
    { id: "913624585", username: "loish" },
  );
  assert.deepEqual(
    parseDeviantArtTarget(new URL("https://loish.deviantart.com/art/demo-913624585")),
    { id: "913624585", username: "loish" },
  );
  assert.deepEqual(extractDeviantArtUrls("https://127.0.0.1/a.jpg https://pixiv.net/artworks/1"), []);
});

test("selects the highest-quality DeviantArt video", () => {
  assert.deepEqual(
    extractDeviantArtMedia({
      title: "Demo",
      author: { username: "artist" },
      media: {
        types: [
          { t: "video", q: "360p", b: "https://video.wixmp.com/low.mp4" },
          { t: "video", q: "1080p", b: "https://video.wixmp.com/high.mp4" },
        ],
      },
    }),
    { url: "https://video.wixmp.com/high.mp4", kind: "video", title: "Demo — artist" },
  );
  assert.equal(
    extractDeviantArtMedia({ title: "GIF", media: { baseUri: "https://images.wixmp.com/work.gif" } }).kind,
    "animation",
  );
  assert.equal(
    extractDeviantArtMedia({ title: "Image", media: { baseUri: "https://images.wixmp.com/work.jpg" } }).kind,
    "photo",
  );
});

test("resolves two links with one DeviantArt session and serves the signed proxy", async (t) => {
  const originalFetch = globalThis.fetch;
  const telegramCalls = [];
  let homeCalls = 0;
  let initCalls = 0;
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    if (url === "https://www.deviantart.com/") {
      homeCalls += 1;
      return new Response("window.__CSRF_TOKEN__ = 'csrf'", {
        headers: { "Set-Cookie": "session=abc; Path=/" },
      });
    }
    if (url.startsWith("https://www.deviantart.com/_puppy/dadeviation/init")) {
      initCalls += 1;
      assert.equal(new Headers(init.headers).get("Cookie"), "session=abc");
      return Response.json({
        deviation: {
          title: "作品",
          author: { username: "artist" },
          media: { types: [{ t: "video", q: "1080p", b: "https://video.wixmp.com/work.mp4" }] },
        },
      });
    }
    if (url.includes("api.telegram.org")) {
      telegramCalls.push({ url, body: JSON.parse(init.body) });
      return Response.json({ ok: true, result: {} });
    }
    if (url === "https://video.wixmp.com/work.mp4") {
      assert.equal(new Headers(init.headers).get("Referer"), "https://www.deviantart.com/");
      assert.equal(new Headers(init.headers).get("Range"), "bytes=0-4");
      return new Response("video", {
        status: 206,
        headers: { "Content-Type": "video/mp4", "Content-Range": "bytes 0-4/5" },
      });
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const env = { BOT_TOKEN: "token", WEBHOOK_SECRET: "secret" };
  const response = await worker.fetch(new Request("https://worker.test/webhook", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Telegram-Bot-Api-Secret-Token": "secret",
    },
    body: JSON.stringify({
      message: {
        message_id: 7,
        from: { id: 42 },
        chat: { id: 42 },
        text: "两个：https://www.deviantart.com/artist/art/work-123456 和 www.deviantart.com/artist/art/work-654321",
      },
    }),
  }), env);

  assert.equal(response.status, 200);
  assert.equal(homeCalls, 1);
  assert.equal(initCalls, 2);
  assert.equal(telegramCalls.length, 2);
  assert.match(telegramCalls[0].url, /sendVideo$/);
  assert.match(telegramCalls[0].body.caption, /作品 — artist/);
  const proxied = await worker.fetch(new Request(telegramCalls[0].body.video, {
    headers: { Range: "bytes=0-4" },
  }), env);
  assert.equal(proxied.status, 206);
  assert.equal(proxied.headers.get("Content-Type"), "video/mp4");
  assert.equal(proxied.headers.get("Content-Range"), "bytes 0-4/5");
  assert.equal(await proxied.text(), "video");
});

test("rejects webhook requests without Telegram's secret header", async () => {
  const response = await worker.fetch(new Request("https://worker.test/webhook", {
    method: "POST",
  }), { BOT_TOKEN: "token", WEBHOOK_SECRET: "secret" });
  assert.equal(response.status, 403);
});

test("reports a missing artwork to the user", async (t) => {
  const originalFetch = globalThis.fetch;
  let errorMessage;
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    if (url === "https://www.deviantart.com/") {
      return new Response("window.__CSRF_TOKEN__ = 'csrf'");
    }
    if (url.includes("/_puppy/dadeviation/init")) return new Response("missing", { status: 404 });
    if (url.includes("api.telegram.org")) {
      errorMessage = JSON.parse(init.body).text;
      return Response.json({ ok: true, result: {} });
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  await worker.fetch(new Request("https://worker.test/webhook", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Telegram-Bot-Api-Secret-Token": "secret",
    },
    body: JSON.stringify({
      message: {
        message_id: 8,
        from: { id: 42 },
        chat: { id: 42 },
        text: "https://www.deviantart.com/artist/art/missing-404",
      },
    }),
  }), { BOT_TOKEN: "token", WEBHOOK_SECRET: "secret" });

  assert.match(errorMessage, /作品不存在、已删除或链接无效/);
});

test("backs off and retries a DeviantArt 429", async (t) => {
  const originalFetch = globalThis.fetch;
  let homeCalls = 0;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url === "https://www.deviantart.com/") {
      homeCalls += 1;
      if (homeCalls === 1) return new Response("limited", { status: 429, headers: { "Retry-After": "0.001" } });
      return new Response("window.__CSRF_TOKEN__ = 'csrf'");
    }
    if (url.includes("/_puppy/dadeviation/init")) {
      return Response.json({ deviation: { media: { baseUri: "https://images.wixmp.com/work.jpg" } } });
    }
    if (url.includes("api.telegram.org")) return Response.json({ ok: true, result: {} });
    throw new Error(`unexpected fetch: ${url}`);
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  await worker.fetch(new Request("https://worker.test/webhook", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Telegram-Bot-Api-Secret-Token": "secret",
    },
    body: JSON.stringify({
      message: {
        message_id: 9,
        from: { id: 42 },
        chat: { id: 42 },
        text: "https://www.deviantart.com/artist/art/work-123",
      },
    }),
  }), { BOT_TOKEN: "token", WEBHOOK_SECRET: "secret" });

  assert.equal(homeCalls, 2);
});

test("answers /about, parses media captions, and ignores link-less or own-forwarded messages", async (t) => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  let initCalls = 0;
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    if (url === "https://www.deviantart.com/") {
      return new Response("window.__CSRF_TOKEN__ = 'csrf'");
    }
    if (url.includes("/_puppy/dadeviation/init")) {
      initCalls += 1;
      return Response.json({ deviation: { title: "作品", media: { baseUri: "https://images.wixmp.com/work.jpg" } } });
    }
    if (url.includes("api.telegram.org")) {
      calls.push({ url, body: JSON.parse(init.body) });
      return Response.json({ ok: true, result: {} });
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const env = { BOT_TOKEN: "111:secret", WEBHOOK_SECRET: "secret" };
  const send = async (message) => {
    const before = calls.length;
    const initBefore = initCalls;
    const response = await worker.fetch(new Request("https://worker.test/webhook", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Telegram-Bot-Api-Secret-Token": "secret" },
      body: JSON.stringify({ message }),
    }), env);
    assert.equal(response.status, 200);
    return { replies: calls.slice(before), downloads: initCalls - initBefore };
  };

  // /about：回复指向源码仓库。
  const about = await send({
    message_id: 1, from: { id: 42 }, chat: { id: 42, type: "private" }, text: "/about",
  });
  assert.equal(about.replies.length, 1);
  assert.match(about.replies[0].body.text, /github\.com\/redtidev1918\/deviantdrop/);

  // 图片 + caption 带链接：照常解析并下载。
  const caption = await send({
    message_id: 2, from: { id: 42 }, chat: { id: 42, type: "private" },
    caption: "看看这幅 https://www.deviantart.com/artist/art/work-123",
    photo: [{ file_id: "f" }],
  });
  assert.equal(caption.downloads, 1);
  assert.equal(caption.replies.length, 1);
  assert.match(caption.replies[0].url, /sendPhoto$/);
  assert.match(caption.replies[0].body.caption, /deviantart\.com\/artist\/art\/work-123/);

  // 无 caption 的图片：静默忽略。
  const plain = await send({
    message_id: 3, from: { id: 42 }, chat: { id: 42, type: "private" }, photo: [{ file_id: "f" }],
  });
  assert.equal(plain.replies.length, 0);

  // 转发自 Bot 自己的消息：即使带链接也忽略，不再重复下载。
  const ownForward = await send({
    message_id: 4, from: { id: 42 }, chat: { id: 42, type: "private" },
    text: "https://www.deviantart.com/artist/art/work-123",
    forward_origin: { type: "user", sender_user: { id: 111 } },
  });
  assert.equal(ownForward.replies.length, 0);
  assert.equal(ownForward.downloads, 0);

  // 私聊纯文字（无链接）：给用法提示；群聊闲聊：保持安静。
  const privateChat = await send({
    message_id: 5, from: { id: 42 }, chat: { id: 42, type: "private" }, text: "你好",
  });
  assert.equal(privateChat.replies.length, 1);
  assert.match(privateChat.replies[0].body.text, /没有找到/);
  const groupChat = await send({
    message_id: 6, from: { id: 43 }, chat: { id: -1, type: "group" }, text: "闲聊一下",
  });
  assert.equal(groupChat.replies.length, 0);
});
