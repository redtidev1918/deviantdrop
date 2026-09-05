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

  const mediaCalls = telegramCalls.filter((c) => /send(Photo|Video|Animation)$/.test(c.url));
  assert.equal(response.status, 200);
  assert.equal(homeCalls, 1);
  assert.equal(initCalls, 2);
  assert.equal(mediaCalls.length, 2);
  assert.match(mediaCalls[0].url, /sendVideo$/);
  assert.match(mediaCalls[0].body.caption, /作品 — artist/);
  const proxied = await worker.fetch(new Request(mediaCalls[0].body.video, {
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
      const text = JSON.parse(init.body).text;
      if (text) errorMessage = text; // 状态提示先于错误、删除消息无 text，只保留最后一次带正文的消息
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

  // 图片 + caption 带链接：照常解析并下载（“处理中”提示会自动删除）。
  const caption = await send({
    message_id: 2, from: { id: 42 }, chat: { id: 42, type: "private" },
    caption: "看看这幅 https://www.deviantart.com/artist/art/work-123",
    photo: [{ file_id: "f" }],
  });
  const captionMedia = caption.replies.filter((c) => /send(Photo|Video|Animation)$/.test(c.url));
  assert.equal(caption.downloads, 1);
  assert.equal(captionMedia.length, 1);
  assert.match(captionMedia[0].url, /sendPhoto$/);
  assert.match(captionMedia[0].body.caption, /deviantart\.com\/artist\/art\/work-123/);

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

// —— 加固测试：注入假的 Cloudflare Cache API（无 caches 时生产逻辑自动降级为关闭） ——

function installFakeCache() {
  const entries = new Map();
  const previous = globalThis.caches;
  globalThis.caches = {
    default: {
      async match(input) {
        const hit = entries.get(new URL(String(input)).href);
        if (!hit || hit.expires <= Date.now()) return undefined;
        return new Response(hit.body);
      },
      async put(input, response) {
        const maxAge = Number(response.headers.get("Cache-Control")?.match(/max-age=(\d+)/)?.[1] ?? 0);
        entries.set(new URL(String(input)).href, {
          body: await response.text(),
          expires: Date.now() + maxAge * 1000,
        });
      },
    },
  };
  return () => {
    if (previous === undefined) delete globalThis.caches;
    else globalThis.caches = previous;
  };
}

function installFetchHarness(calls) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    if (url === "https://www.deviantart.com/") {
      calls.home += 1;
      return new Response("window.__CSRF_TOKEN__ = 'csrf'");
    }
    if (url.includes("/_puppy/dadeviation/init")) {
      calls.init += 1;
      return Response.json({ deviation: { title: "作品", media: { baseUri: "https://images.wixmp.com/work.jpg" } } });
    }
    if (url.includes("api.telegram.org")) {
      calls.telegram.push({ url, body: JSON.parse(init.body) });
      return Response.json({ ok: true, result: {} });
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
  return () => { globalThis.fetch = originalFetch; };
}

function webhookEnv() {
  return { BOT_TOKEN: "111:secret", WEBHOOK_SECRET: "secret" };
}

function postMessage(env, updateId, message) {
  return worker.fetch(new Request("https://worker.test/webhook", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Telegram-Bot-Api-Secret-Token": "secret" },
    body: JSON.stringify({ update_id: updateId, message }),
  }), env);
}

test("reuses the DeviantArt session across messages", async (t) => {
  const calls = { home: 0, init: 0, telegram: [] };
  t.after(installFakeCache());
  t.after(installFetchHarness(calls));
  const env = webhookEnv();
  const base = { from: { id: 42 }, chat: { id: 500, type: "private" } };

  await postMessage(env, 101, { ...base, message_id: 1, text: "https://www.deviantart.com/artist/art/work-111" });
  await postMessage(env, 102, { ...base, message_id: 2, text: "https://www.deviantart.com/artist/art/work-222" });

  assert.equal(calls.home, 1); // 只请求了一次 DeviantArt 首页
  assert.equal(calls.init, 2);
  assert.equal(calls.telegram.filter((c) => /send(Photo|Video|Animation)$/.test(c.url)).length, 2);
});

test("skips duplicate updates and repeated album links", async (t) => {
  const calls = { home: 0, init: 0, telegram: [] };
  t.after(installFakeCache());
  t.after(installFetchHarness(calls));
  const env = webhookEnv();
  const chat = { id: 501, type: "private" };

  // 同一个 update_id 投递两次：只处理一次。
  const once = { from: { id: 42 }, chat, message_id: 10, text: "https://www.deviantart.com/artist/art/work-333" };
  const mediaOf = () => calls.telegram.filter((c) => /send(Photo|Video|Animation)$/.test(c.url)).length;
  await postMessage(env, 201, once);
  await postMessage(env, 201, once);
  assert.equal(calls.init, 1);
  assert.equal(mediaOf(), 1);

  // 同一相册的两张照片都带链接：只处理第一条。
  await postMessage(env, 202, {
    from: { id: 42 }, chat, message_id: 11,
    caption: "https://www.deviantart.com/artist/art/work-444", media_group_id: "album-1",
    photo: [{ file_id: "a" }],
  });
  await postMessage(env, 203, {
    from: { id: 42 }, chat, message_id: 12,
    caption: "https://www.deviantart.com/artist/art/work-555", media_group_id: "album-1",
    photo: [{ file_id: "b" }],
  });
  assert.equal(calls.init, 2);
  assert.equal(mediaOf(), 2);
});

test("limits how many links one chat may process per minute", async (t) => {
  const calls = { home: 0, init: 0, telegram: [] };
  t.after(installFakeCache());
  t.after(installFetchHarness(calls));
  const env = webhookEnv();
  const chat = { id: 502, type: "private" };

  for (let i = 0; i < 16; i += 1) {
    await postMessage(env, 300 + i, {
      from: { id: 42 }, chat, message_id: 20 + i,
      text: `https://www.deviantart.com/artist/art/work-${600 + i}`,
    });
  }

  assert.equal(calls.init, 15); // 前 15 个链接被处理
  const mediaCount = calls.telegram.filter((c) => /send(Photo|Video|Animation)$/.test(c.url)).length;
  assert.equal(mediaCount, 15); // 15 条媒体（另有若干自动删除的“处理中”状态提示）
  assert.match(calls.telegram.at(-1).body.text, /操作太快/);
  assert.equal(calls.telegram.at(-1).url.endsWith("sendMessage"), true);
});

test("resolves artwork via official API and archive.org UUID mapping", async (t) => {
  const originalFetch = globalThis.fetch;
  const calls = { token: 0, cdx: 0, snapshot: 0, deviation: 0, telegram: [] };
  const UUID = "4141C2B4-BCA1-2A3E-7241-3FCFB091BA69";
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    if (url === "https://www.deviantart.com/") {
      // 网页出口被封：级联应落到官方 API 路径
      return new Response("blocked", { status: 403 });
    }
    if (url.startsWith("https://www.deviantart.com/oauth2/token")) {
      calls.token += 1;
      return Response.json({ access_token: "tok", expires_in: 3600 });
    }
    if (url.startsWith("https://web.archive.org/cdx/search/cdx")) {
      calls.cdx += 1;
      return Response.json([["timestamp", "statuscode"], ["20260105154201", "200"]]);
    }
    if (url.includes("web.archive.org/web/")) {
      calls.snapshot += 1;
      return new Response(`window stuff \\"deviationExtended\\":{\\"913624585\\":{\\"deviationUuid\\":\\"${UUID}\\",\\"canUserAddToGroup\\":true} more`);
    }
    if (url.includes("/api/v1/oauth2/deviation/")) {
      calls.deviation += 1;
      return Response.json({
        title: "underwater",
        author: { username: "loish" },
        is_downloadable: false,
        content: { src: "https://images.wixmp.com/work.png" },
      });
    }
    if (url.includes("api.telegram.org")) {
      calls.telegram.push({ url, body: JSON.parse(init.body) });
      return Response.json({ ok: true, result: {} });
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
  t.after(installFakeCache());
  t.after(() => { globalThis.fetch = originalFetch; });

  const env = { BOT_TOKEN: "111:secret", WEBHOOK_SECRET: "secret", CLIENT_ID: "1", CLIENT_SECRET: "s" };
  const base = { from: { id: 42 }, chat: { id: 700, type: "private" } };
  const link = "https://www.deviantart.com/loish/art/underwater-913624585";
  await postMessage(env, 401, { ...base, message_id: 30, text: link });
  await postMessage(env, 402, { ...base, message_id: 31, text: link });

  assert.equal(calls.token, 1); // token 跨消息缓存
  assert.equal(calls.cdx, 0); // 免 CDX 索引，直接请求快照 replay
  assert.equal(calls.snapshot, 1); // uuid 已缓存，第二条相同链接不再查存档
  assert.equal(calls.deviation, 2);
  const mediaCalls = calls.telegram.filter((c) => /send(Photo|Video|Animation)$/.test(c.url));
  assert.equal(mediaCalls.length, 2);
  assert.match(mediaCalls[0].url, /sendPhoto$/);
  assert.match(mediaCalls[0].body.caption, /deviantart\.com\/loish\/art\/underwater-913624585/);
});

test("explains that fav.me short links need a canonical page URL on the official path", async (t) => {
  const originalFetch = globalThis.fetch;
  let notice;
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    if (url === "https://www.deviantart.com/") {
      // 网页出口被封：级联应落到官方 API 路径
      return new Response("blocked", { status: 403 });
    }
    if (url.startsWith("https://www.deviantart.com/oauth2/token")) {
      return Response.json({ access_token: "tok", expires_in: 3600 });
    }
    if (url.includes("api.telegram.org")) {
      notice = JSON.parse(init.body).text;
      return Response.json({ ok: true, result: {} });
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
  t.after(installFakeCache());
  t.after(() => { globalThis.fetch = originalFetch; });

  const env = { BOT_TOKEN: "111:secret", WEBHOOK_SECRET: "secret", CLIENT_ID: "1", CLIENT_SECRET: "s" };
  await postMessage(env, 403, {
    from: { id: 42 }, chat: { id: 701, type: "private" }, message_id: 40,
    text: "https://fav.me/dabc123",
  });
  assert.match(notice, /旧式\/短链/);
});
