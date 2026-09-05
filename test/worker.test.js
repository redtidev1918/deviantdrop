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
