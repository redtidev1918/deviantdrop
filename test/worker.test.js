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
  // 成熟内容：明确报错而不是返回打码/400 的地址
  assert.throws(
    () => extractDeviantArtMedia({ title: "NSFW", isMature: true, media: { baseUri: "https://images.wixmp.com/x.jpg" } }),
    /需登录查看的成熟内容/,
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
  // caption 只含标题/作者，不含裸 URL；单视频来源走 inline 按钮（webhook JSON 路径）。
  assert.match(mediaCalls[0].body.caption, /🎨 作品/);
  assert.match(mediaCalls[0].body.caption, /👤 artist/);
  assert.doesNotMatch(mediaCalls[0].body.caption, /https?:\/\//);
  const btn = mediaCalls[0].body.reply_markup?.inline_keyboard?.[0]?.[0];
  assert.ok(btn && /deviantart\.com\/artist\/art\/work-123456/.test(btn.url), "单视频应有指向作品页的 inline 按钮");
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

  assert.match(errorMessage, /没有找到这个 DeviantArt 作品/);
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
  // 单图来源走 inline 按钮，caption 无裸 URL / entity。
  assert.doesNotMatch(captionMedia[0].body.caption || "", /https?:\/\//);
  const cBtn = captionMedia[0].body.reply_markup?.inline_keyboard?.[0]?.[0];
  assert.ok(cBtn && /deviantart\.com\/artist\/art\/work-123/.test(cBtn.url), "单图应有指向作品页的 inline 按钮");

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
      // 网页出口被封（连接失败）：级联应落到官方 API 路径
      throw new Error("无法连接 DeviantArt，请稍后重试");
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
  // 官方 API fallback 也用统一渲染：单图来源走 inline 按钮，caption 无裸 URL。
  const oBtn = mediaCalls[0].body.reply_markup?.inline_keyboard?.[0]?.[0];
  assert.ok(oBtn && /deviantart\.com\/loish\/art\/underwater-913624585/.test(oBtn.url), "官方 fallback 应有指向作品页的 inline 按钮");
  assert.doesNotMatch(mediaCalls[0].body.caption, /https?:\/\//, "caption 不应包含裸 URL");
});

test("explains that fav.me short links need a canonical page URL", async (t) => {
  const originalFetch = globalThis.fetch;
  let notice;
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    if (url === "https://www.deviantart.com/") {
      // 网页出口被封（连接失败）：级联应落到官方 API 路径
      throw new Error("无法连接 DeviantArt，请稍后重试");
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
  assert.match(notice, /无法自动解析作者信息/);
});

test("reuses the Telegram file_id for repeated links", async (t) => {
  const originalFetch = globalThis.fetch;
  let initCalls = 0;
  const sends = [];
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
      const body = JSON.parse(init.body);
      sends.push(body);
      // 返回带 photo 的 file_id，供记住并复用
      return Response.json({ ok: true, result: { message_id: 99, photo: [{ file_id: "PHOTO_1" }] } });
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
  t.after(installFakeCache());
  t.after(() => { globalThis.fetch = originalFetch; });

  const env = { BOT_TOKEN: "111:secret", WEBHOOK_SECRET: "secret" };
  const link = "https://www.deviantart.com/artist/art/work-777777";
  const msg = (id) => ({ from: { id: 42 }, chat: { id: 800, type: "private" }, message_id: id, text: link });

  await postMessage(env, 501, msg(50));
  await postMessage(env, 502, msg(51));

  assert.equal(initCalls, 1); // 第二次不再走 DA
  assert.equal(sends.filter((s) => s.photo === "PHOTO_1").length, 1); // 第二次用 file_id 重发
  assert.equal(sends.filter((s) => typeof s.photo === "string" && s.photo.startsWith("https://")).length, 1); // 第一次用 URL 发送
});

test("falls back to document for oversized photos and reuses its file_id", async (t) => {
  const originalFetch = globalThis.fetch;
  let initCalls = 0;
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    if (url === "https://www.deviantart.com/") {
      return new Response("window.__CSRF_TOKEN__ = 'csrf'");
    }
    if (url.includes("/_puppy/dadeviation/init")) {
      initCalls += 1;
      return Response.json({ deviation: { title: "大图", media: { baseUri: "https://images.wixmp.com/big.jpg", token: "t" } } });
    }
    if (url.includes("api.telegram.org")) {
      const method = url.split("/").pop();
      const body = JSON.parse(init.body);
      calls.push({ method, body });
      if (method === "sendPhoto") {
        return Response.json({ ok: false, description: "Bad Request: file is too big", error_code: 400 });
      }
      return Response.json({ ok: true, result: { message_id: 5, document: { file_id: "DOC_1" } } });
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
  t.after(installFakeCache());
  t.after(() => { globalThis.fetch = originalFetch; });

  const env = { BOT_TOKEN: "111:secret", WEBHOOK_SECRET: "secret" };
  const link = "https://www.deviantart.com/artist/art/huge-888888888";
  const msg = (id) => ({ from: { id: 42 }, chat: { id: 810, type: "private" }, message_id: id, text: link });

  await postMessage(env, 601, msg(60));
  await postMessage(env, 602, msg(61));

  assert.equal(initCalls, 1); // 第二次走 file_id
  const documents = calls.filter((c) => c.method === "sendDocument");
  assert.equal(documents.length, 2); // 第一次文档URL + 第二次文档file_id
  assert.equal(documents[1].body.document, "DOC_1");
  assert.equal(calls.filter((c) => c.method === "sendPhoto").length, 1); // 第一次尝试照片被拒
});

test("sends additional media of a multimedia deviation", async (t) => {
  const originalFetch = globalThis.fetch;
  let initCalls = 0;
  const sends = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    if (url === "https://www.deviantart.com/") {
      return new Response("window.__CSRF_TOKEN__ = 'csrf'");
    }
    if (url.includes("/_puppy/dadeviation/init")) {
      initCalls += 1;
      return Response.json({
        deviation: {
          title: "组图",
          isMultiMedia: true,
          media: { baseUri: "https://images.wixmp.com/main.jpg", token: "t1" },
          extended: {
            additionalMedia: [
              { fileId: 2, media: { baseUri: "https://images.wixmp.com/extra2.jpg", token: "t2" } },
              { fileId: 3, media: { baseUri: "https://images.wixmp.com/extra3.png", token: "t3" } },
            ],
          },
        },
      });
    }
    if (url.includes("api.telegram.org")) {
      sends.push({ url, body: JSON.parse(init.body) });
      return Response.json({ ok: true, result: { message_id: 9 } });
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
  t.after(installFakeCache());
  t.after(() => { globalThis.fetch = originalFetch; });

  const env = { BOT_TOKEN: "111:secret", WEBHOOK_SECRET: "secret" };
  await postMessage(env, 701, {
    from: { id: 42 }, chat: { id: 900, type: "private" }, message_id: 70,
    text: "https://www.deviantart.com/artist/art/group-999999999",
  });

  const group = sends.find((s) => s.url.endsWith("sendMediaGroup"));
  assert.equal(initCalls, 1);
  assert.ok(group, "应使用 sendMediaGroup 相册发送");
  assert.equal(group.body.media.length, 3); // 主图 + 2 张附加图
  assert.match(group.body.media[0].caption, /组图/);
  assert.equal(group.body.media[1].caption, undefined); // 只有第一张带 caption
});

test("poll uploads a photo/video album, preserves group topic, and replays all file IDs", async (t) => {
  const { handleUpdate } = await import('../src/index.js');
  const originalFetch = globalThis.fetch;
  t.after(installFakeCache());
  t.after(() => { globalThis.fetch = originalFetch; });
  const sends = [];
  let downloads = 0;
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    if (url === 'https://www.deviantart.com/') return new Response("window.__CSRF_TOKEN__ = 'csrf'");
    if (url.includes('/_puppy/dadeviation/init')) return Response.json({ deviation: {
      title: 'album', isMultiMedia: true,
      media: { baseUri: 'https://images.wixmp.com/main.jpg', token: 't' },
      extended: { additionalMedia: [{ media: { baseUri: 'https://images.wixmp.com/second.mp4', token: 't' } }] },
    } });
    if (url.includes('images.wixmp.com')) { downloads++; return new Response('file-bytes'); }
    if (url.includes('api.telegram.org')) {
      const body = init.body instanceof FormData ? Object.fromEntries(init.body) : JSON.parse(init.body);
      sends.push({ method: url.split('/').pop(), body });
      if (url.endsWith('/sendMediaGroup')) {
        const media = typeof body.media === 'string' ? JSON.parse(body.media) : body.media;
        assert.deepEqual(media.map(x => x.type), ['photo', 'video']);
        assert.equal(String(body.message_thread_id), '77');
        // 相册（sendMediaGroup）不支持内联按钮，caption 也不放 entity（multipart offset bug）；
        // 来源由发送后补发的一条 sendMessage 文本（text_link）承载。
        assert.equal(body.reply_markup, undefined, "相册不应带 reply_markup");
        assert.ok(!media[0].caption_entities, "相册首图 caption 不应带 entity");
        if (init.body instanceof FormData) {
          assert.equal(media[0].media, 'attach://file0');
          assert.equal(await body.file0.text(), 'file-bytes');
          assert.equal(await body.file1.text(), 'file-bytes');
        } else assert.deepEqual(media.map(x => x.media), ['PHOTO', 'VIDEO']);
        return Response.json({ ok: true, result: [{ photo: [{ file_id: 'PHOTO' }] }, { video: { file_id: 'VIDEO' } }] });
      }
      return Response.json({ ok: true, result: { message_id: 90 } });
    }
    throw new Error(`Unexpected ${url}`);
  };
  const env = { BOT_TOKEN: '111:secret', WEBHOOK_SECRET: 'secret' };
  const message = { message_id: 20, chat: { id: -900, type: 'supergroup' }, message_thread_id: 77,
    text: 'https://www.deviantart.com/artist/art/album-777777', from: { id: 42 } };
  await handleUpdate({ update_id: 9001, message }, env);
  await handleUpdate({ update_id: 9002, message }, env);
  assert.equal(sends.filter(x => x.body.text?.includes("处理失败")).length, 0, JSON.stringify(sends));
  assert.equal(downloads, 2);
  assert.equal(sends.filter(x => x.method === 'sendMediaGroup').length, 2);
  assert.equal(sends.filter(x => x.method === 'sendPhoto').length, 0);
  assert.equal(sends.filter(x => x.body.text?.includes('处理失败')).length, 0);
  // 相册发完后补发一条可点来源文本（JSON sendMessage + text_link entity）。
  const srcLine = sends.filter(x => x.method === 'sendMessage' && x.body.entities?.some(e => e.type === 'text_link' && /album-777777/.test(e.url)));
  assert.equal(srcLine.length, 2, "每次相册发送都应补发一条来源文本");
});

test('poll single photo falls back on Telegram size error and channel posts are handled', async (t) => {
  const { handleUpdate } = await import('../src/index.js');
  const originalFetch = globalThis.fetch;
  t.after(installFakeCache());
  t.after(() => { globalThis.fetch = originalFetch; });
  const methods = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    if (url === 'https://www.deviantart.com/') return new Response("window.__CSRF_TOKEN__ = 'csrf'");
    if (url.includes('/_puppy/dadeviation/init')) return Response.json({ deviation: {
      title: 'single', media: { baseUri: 'https://images.wixmp.com/single.jpg', token: 't' },
    } });
    if (url.includes('images.wixmp.com')) return new Response('photo-bytes');
    const method = url.split('/').pop();
    methods.push(method);
    if (method === 'sendPhoto') return Response.json({ ok: false, description: 'Bad Request: file of size 15535898 bytes is too big for a photo; the maximum size is 10485760 bytes' }, { status: 400 });
    if (method === 'sendDocument') {
      assert.equal(await init.body.get('document').text(), 'photo-bytes');
      return Response.json({ ok: true, result: { document: { file_id: 'DOC' } } });
    }
    return Response.json({ ok: true, result: { message_id: 91 } });
  };
  await handleUpdate({ update_id: 9100, channel_post: {
    chat: { id: -1009, type: 'channel' }, message_id: 1,
    text: 'https://www.deviantart.com/artist/art/single-888777',
  } }, { BOT_TOKEN: '111:secret', WEBHOOK_SECRET: 'secret' });
  assert.equal(methods.filter(x => x === 'sendPhoto').length, 1);
  assert.equal(methods.filter(x => x === 'sendDocument').length, 1);
});

test('poll compresses a real oversized image before upload', async (t) => {
  const sharp = (await import('sharp')).default;
  const { handleUpdate } = await import('../src/index.js');
  const originalFetch = globalThis.fetch;
  t.after(installFakeCache());
  t.after(() => { globalThis.fetch = originalFetch; });
  const bytes = await sharp({ create: { width: 2048, height: 2048, channels: 3, background: '#123456' } }).png({ compressionLevel: 0 }).toBuffer();
  assert.ok(bytes.length > 10 * 1024 * 1024);
  let uploaded = false;
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    if (url === 'https://www.deviantart.com/') return new Response("window.__CSRF_TOKEN__ = 'csrf'");
    if (url.includes('/_puppy/dadeviation/init')) return Response.json({ deviation: {
      title: 'large', media: { baseUri: 'https://images.wixmp.com/large.png', token: 't' },
    } });
    if (url.includes('images.wixmp.com')) return new Response(bytes);
    if (url.endsWith('/sendPhoto')) {
      const photo = init.body.get('photo');
      assert.ok(photo.size < 10 * 1024 * 1024);
      assert.equal((await sharp(Buffer.from(await photo.arrayBuffer())).metadata()).format, 'jpeg');
      uploaded = true;
    }
    return Response.json({ ok: true, result: { message_id: 92 } });
  };
  await handleUpdate({ message: { chat: { id: 777, type: 'private' }, message_id: 1,
    text: 'https://www.deviantart.com/artist/art/large-999888' } }, { BOT_TOKEN: '111:secret', WEBHOOK_SECRET: 'secret' });
  assert.equal(uploaded, true);
});

test("splits media beyond 10 into multiple albums", async (t) => {
  const originalFetch = globalThis.fetch;
  const sends = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    if (url === "https://www.deviantart.com/") return new Response("window.__CSRF_TOKEN__ = 'csrf'");
    if (url.includes("/_puppy/dadeviation/init")) {
      const pages = Array.from({ length: 10 }, (_, i) => ({
        media: { baseUri: `https://images.wixmp.com/p${i + 1}.jpg`, token: `t${i + 1}` },
      }));
      return Response.json({
        deviation: {
          title: "多页",
          isMultiMedia: true,
          media: { baseUri: "https://images.wixmp.com/main.jpg", token: "t0" },
          extended: { additionalMedia: pages },
        },
      });
    }
    if (url.includes("api.telegram.org")) {
      sends.push({ url, body: JSON.parse(init.body) });
      return Response.json({ ok: true, result: [{ message_id: 1 }] });
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
  t.after(installFakeCache());
  t.after(() => { globalThis.fetch = originalFetch; });

  const env = { BOT_TOKEN: "111:secret", WEBHOOK_SECRET: "secret" };
  await postMessage(env, 801, {
    from: { id: 42 }, chat: { id: 920, type: "private" }, message_id: 80,
    text: "https://www.deviantart.com/artist/art/multi-999999999",
  });

  const groups = sends.filter((s) => s.url.endsWith("sendMediaGroup"));
  assert.equal(groups.length, 1); // 10 张相册 + 1 张单图
  assert.equal(groups[0].body.media.length, 10);
  assert.equal(sends.filter(s=>s.url.endsWith("sendPhoto")).length, 1);
  assert.ok(groups.every(s=>!s.body.reply_markup));
});

test("/status 与 /login：管理员可用、/status 不泄漏 secret、非管理员被拒", async (t) => {
  const { handleUpdate } = await import("../src/index.js");
  const originalFetch = globalThis.fetch;
  t.after(installFakeCache());
  t.after(() => { globalThis.fetch = originalFetch; });
  const sends = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u.includes("api.telegram.org")) {
      sends.push({ method: u.split("/").pop(), body: JSON.parse(init.body) });
      return Response.json({ ok: true, result: { message_id: 1 } });
    }
    throw new Error("unexpected " + u);
  };

  const fakeStore = {
    getState: () => ({ state: "valid", hasToken: true, updatedAt: "x" }),
    getRefreshToken: () => "secret-refresh-token-123",
  };
  const fakeCookieStore = { available: () => true, getCookies: () => "auth=cookie-secret" };
  const fakeAuthFlow = { configured: () => true, issueLoginToken: () => "one-time-abc" };
  const env = {
    BOT_TOKEN: "111:secret", WEBHOOK_SECRET: "secret",
    ADMIN_IDS: "42", PUBLIC_BASE_URL: "https://bot.example.com",
    credentialStore: fakeStore, cookieStore: fakeCookieStore, authFlow: fakeAuthFlow,
    telepress: { mode: "large-gallery" },
  };

  // 管理员 /status
  await handleUpdate({ update_id: 1, message: { message_id: 1, from: { id: 42 }, chat: { id: 42, type: "private" }, text: "/status" } }, env);
  const status = sends.find((s) => s.method === "sendMessage")?.body.text || "";
  assert.match(status, /DeviantDrop Status/);
  assert.match(status, /OAuth: valid/);
  assert.match(status, /TelePress: large-gallery/);
  assert.doesNotMatch(status, /secret-refresh-token|cookie-secret|111:secret/, "/status 不得泄漏任何凭据");

  // 管理员 /login：返回带一次性链接的按钮
  await handleUpdate({ update_id: 2, message: { message_id: 2, from: { id: 42 }, chat: { id: 42, type: "private" }, text: "/login" } }, env);
  const loginMsg = sends[sends.length - 1].body;
  assert.match(loginMsg.reply_markup.inline_keyboard[0][0].url, /^https:\/\/bot\.example\.com\/auth\/deviantart\/start\?t=one-time-abc$/);

  // 非管理员：被拒绝
  await handleUpdate({ update_id: 3, message: { message_id: 3, from: { id: 99 }, chat: { id: 99, type: "private" }, text: "/status" } }, env);
  const denied = sends[sends.length - 1].body.text;
  assert.match(denied, /仅 Bot 所有者可用/);
});

test('admin login is denied without configured admins and in public groups',async t=>{
 const {handleUpdate}=await import('../src/index.js');const original=globalThis.fetch;t.after(()=>globalThis.fetch=original);t.after(installFakeCache());const sends=[];
 globalThis.fetch=async(url,init)=>{sends.push(JSON.parse(init.body));return Response.json({ok:true,result:{message_id:1}});};
 const env={BOT_TOKEN:'111:secret',WEBHOOK_SECRET:'secret',PUBLIC_BASE_URL:'https://bot.example',authFlow:{configured:()=>true,issueLoginToken:()=>{throw new Error('Must not issue');}}};
 await handleUpdate({message:{from:{id:42},chat:{id:42,type:'private'},message_id:1,text:'/login'}},env);
 assert.match(sends.at(-1).text,/管理命令未启用/);
 await handleUpdate({message:{from:{id:42},chat:{id:-42,type:'supergroup'},message_id:1,text:'/login'}},{...env,ADMIN_IDS:'42'});
 assert.match(sends.at(-1).text,/私聊/);
 assert.ok(sends.every(s=>!s.reply_markup));
});

test('TelePress large-gallery hook publishes once, and failure leaves Telegram delivery intact',async t=>{
 const {handleUpdate}=await import('../src/index.js');const {TelePress}=await import('../src/publishing/telepress.js');const original=globalThis.fetch;t.after(()=>globalThis.fetch=original);t.after(installFakeCache());
 let publications=0,albums=0;const replies=[];let fail=false;
 globalThis.fetch=async(input,init={})=>{
  const url=String(input);
  if(url==='https://www.deviantart.com/')return new Response("window.__CSRF_TOKEN__ = 'csrf'");
  if(url.includes('/_puppy/dadeviation/init'))return Response.json({deviation:{title:'gallery',isMultiMedia:true,media:{baseUri:'https://images.wixmp.com/main.jpg',token:'t'},extended:{additionalMedia:Array.from({length:10},(_,i)=>({media:{baseUri:`https://images.wixmp.com/${i}.jpg`,token:'t'}}))}}});
  if(url.includes('images.wixmp.com'))return new Response('image',{headers:{'Content-Type':'image/jpeg'}});
  if(url.includes('telepress.example')){publications++;return fail?new Response('error',{status:503}):Response.json({url:'https://telegra.ph/gallery'});}
  const method=url.split('/').pop();
  const body=init.body instanceof FormData?Object.fromEntries(init.body):JSON.parse(init.body);
  replies.push(body);
  if(method==='sendMediaGroup'){albums++;return Response.json({ok:true,result:Array.from({length:10},()=>({photo:[{file_id:'id'}]}))});}
  return Response.json({ok:true,result:{message_id:1,photo:[{file_id:'id'}]}});
 };
 const mem=new Map();const client=new TelePress({url:'https://telepress.example',mode:'large-gallery',cacheGet:async(ns,k)=>mem.get(k),cacheSet:async(ns,k,v)=>mem.set(k,v)});
 const env={BOT_TOKEN:'111:secret',WEBHOOK_SECRET:'secret',telepress:client};
 const msg={from:{id:42},chat:{id:987,type:'private'},message_id:1,text:'https://www.deviantart.com/artist/art/gallery-7654321'};
 await handleUpdate({message:msg},env);await handleUpdate({message:msg},env);
 assert.equal(publications,1);assert.equal(albums,2);
 // TelePress 画廊入口作为可点击 text_link 文本消息发送；相册自身不带按钮（sendMediaGroup 静默丢弃）。
 assert.ok(replies.some(r=>r.text?.includes('在 Telegraph 查看全部') && r.entities?.[0]?.url==='https://telegra.ph/gallery'));
 // 相册发送后补发了可点来源文本（text_link 指向作品页）。
 assert.ok(replies.some(r=>r.entities?.some(e=>e.type==='text_link' && /gallery-7654321/.test(e.url))),'相册应补发来源文本');
 fail=true;mem.clear();await handleUpdate({message:{...msg,chat:{id:986,type:'private'}}},env);
 assert.equal(albums,3);assert.ok(!replies.some(r=>r.text?.includes('处理失败')));
});

test('cookie update replaces a cached authenticated session without restarting',async t=>{
 const {handleUpdate}=await import('../src/index.js');const original=globalThis.fetch;t.after(()=>globalThis.fetch=original);t.after(installFakeCache());
 let cookie='auth=old';const homes=[];const initCookies=[];
 globalThis.fetch=async(input,init={})=>{
  const url=String(input);
  if(url==='https://www.deviantart.com/'){homes.push(new Headers(init.headers).get('Cookie'));return new Response("window.__CSRF_TOKEN__ = 'csrf'");}
  if(url.includes('/_puppy/dadeviation/init')){initCookies.push(new Headers(init.headers).get('Cookie'));return Response.json({deviation:{title:'cookie',media:{baseUri:'https://images.wixmp.com/a.jpg',token:'t'}}});}
  if(url.includes('images.wixmp.com'))return new Response('image');
  return Response.json({ok:true,result:{message_id:1}});
 };
 const env={BOT_TOKEN:'111:secret',WEBHOOK_SECRET:'secret',cookieStore:{getCookies:()=>cookie}};
 const message=id=>({chat:{id:789,type:'private'},message_id:1,text:`https://www.deviantart.com/artist/art/cookie-${id}`});
 await handleUpdate({message:message(1)},env);cookie='auth=new';await handleUpdate({message:message(2)},env);
 assert.deepEqual(homes,['auth=old','auth=new']);assert.deepEqual(initCookies,homes);
});

test('ALLOWED_USER_IDS 白名单不是管理员：未配 ADMIN_IDS 时 /status 被拒', async t => {
  const { handleUpdate } = await import("../src/index.js");
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  t.after(installFakeCache());
  const sends = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u.includes("api.telegram.org")) { sends.push({ body: JSON.parse(init.body) }); return Response.json({ ok: true, result: { message_id: 1 } }); }
    throw new Error("unexpected " + u);
  };
  const env = {
    BOT_TOKEN: "111:secret", WEBHOOK_SECRET: "secret",
    ALLOWED_USER_IDS: "42", // 普通使用者白名单
    PUBLIC_BASE_URL: "https://bot.example",
    authFlow: { configured: () => true, issueLoginToken: () => { throw new Error("must not issue"); } },
  };
  // 即使 from=42 在白名单里，没有 ADMIN_IDS 也不能用管理命令
  await handleUpdate({ update_id: 1, message: { message_id: 1, from: { id: 42 }, chat: { id: 42, type: "private" }, text: "/status" } }, env);
  assert.match(sends.at(-1).body.text, /管理命令未启用/);
  assert.ok(!sends.at(-1).body.reply_markup, "不得泄露任何管理入口");
});
