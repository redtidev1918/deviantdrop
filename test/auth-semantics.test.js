import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleUpdate } from '../src/index.js';
import { CookieStore, WEB_SESSION_STATUS } from '../src/auth/cookie-store.js';
import { AuthNotifier } from '../src/auth/auth-notifier.js';
import { renderArtworkCaption } from '../src/rendering/caption.js';

function freshCookies(seed = null) {
  const store = new CookieStore({ path: join(mkdtempSync(join(tmpdir(), 'dd-sem-')), 'cookies.json') });
  if (seed) store.set(seed);
  return store;
}

const admin = (text) => ({ message: { from: { id: 42 }, chat: { id: 42, type: 'private' }, message_id: 5, text } });

// 记录所有 Telegram 调用，返回最后一条消息文本。
function stubTelegram(homeResponse) {
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    if (url === 'https://www.deviantart.com/') return homeResponse();
    calls.push({ method: url.split('/').pop(), body: JSON.parse(init.body) });
    return Response.json({ ok: true, result: { message_id: 1 } });
  };
  return {
    calls,
    lastText: () => calls.at(-1)?.body?.text ?? "",
    allText: () => calls.map((call) => call.body?.text || "").join("\n----\n"),
  };
}

test('/status 的 OAuth 状态来自 OAuth 自己，不来自网页探针', async (t) => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  // 网页探针失败（网络/5xx）→ 扩展能力只能是 unknown，绝不能让 OAuth 显示成 unknown。
  const telegram = stubTelegram(() => new Response('busy', { status: 503 }));
  const env = {
    BOT_TOKEN: '111:secret',
    WEBHOOK_SECRET: 'secret',
    ADMIN_IDS: '42',
    credentialStore: { getState: () => ({ state: 'valid', hasToken: true, updatedAt: 'v' }), getRefreshToken: () => 'rt' },
    cookieStore: freshCookies('auth=a; auth_secure=b; userinfo=c'),
  };

  await handleUpdate(admin('/status'), env);

  const text = telegram.allText();
  assert.match(text, /OAuth API: ✅ valid/);
  assert.match(text, /Multi-image web expansion: unknown/);
  // 旧实现把 API 状态取自 web 探针，会出现这种耦合；此处必须不成立
  assert.doesNotMatch(text, /DeviantArt API: unknown/);
});

test('/status 在扩展会话过期时说明影响范围与恢复方式', async (t) => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  const telegram = stubTelegram(() => new Response('{"isLoggedIn":false}'));
  const env = {
    BOT_TOKEN: '111:secret',
    WEBHOOK_SECRET: 'secret',
    ADMIN_IDS: '42',
    credentialStore: { getState: () => ({ state: 'valid', hasToken: true, updatedAt: 'v' }), getRefreshToken: () => 'rt' },
    cookieStore: freshCookies('auth=a; auth_secure=b; userinfo=c'),
  };

  await handleUpdate(admin('/status'), env);

  const text = telegram.allText();
  assert.match(text, /Multi-image web expansion: ⚠️ expired/);
  assert.match(text, /单图与官方 API 可获取内容不受影响/);
  assert.match(text, /\/cookie/);
  // 不得把网页会话说成成熟内容的前置条件
  assert.doesNotMatch(text, /成熟多图需要重新网页登录/);
});

test('扩展会话缺失时 /status 不把它描述成成熟内容不可用', async (t) => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  const telegram = stubTelegram(() => new Response('{"isLoggedIn":true}'));
  const env = {
    BOT_TOKEN: '111:secret',
    WEBHOOK_SECRET: 'secret',
    ADMIN_IDS: '42',
    credentialStore: { getState: () => ({ state: 'valid', hasToken: true, updatedAt: 'v' }), getRefreshToken: () => 'rt' },
  };

  await handleUpdate(admin('/status'), env);

  const text = telegram.allText();
  assert.match(text, /Multi-image web expansion: missing/);
  assert.match(text, /普通作品与单图不受影响/);
});

test('caption 把「附加页缺失」与「只有打码预览」分开表达', () => {
  const skipped = renderArtworkCaption({ title: 'T', mediaCount: 3 }, { skippedPages: true }).text;
  assert.match(skipped, /部分附加图片暂时无法获取，请在原站查看/);
  assert.doesNotMatch(skipped, /成熟|登录|Cookie/);

  const preview = renderArtworkCaption({ title: 'T' }, { blurredPreview: true }).text;
  assert.match(preview, /仅能获取打码预览，请在原站查看/);
  assert.doesNotMatch(preview, /登录已失效/);
});

test('扩展会话失效通知说明 OAuth 仍在工作，且只影响附加页', async () => {
  const cache = new Map();
  const sent = [];
  const notifier = new AuthNotifier({
    cacheGet: async (ns, key) => cache.get(`${ns}:${key}`) ?? null,
    cacheSet: async (ns, key, value) => { if (value) cache.set(`${ns}:${key}`, value); else cache.delete(`${ns}:${key}`); },
    sendTelegram: async (method, body) => sent.push(body),
    adminIds: ['42'],
    loginUrl: 'https://bot.example/auth/deviantart/cookies?t=one-time',
  });

  await notifier.notifyInvalid('mature_loggedout', 'cookie');

  const text = sent[0].text;
  assert.match(text, /多图网页扩展会话已失效/);
  assert.match(text, /OAuth API 仍正常工作/);
  assert.match(text, /附加页/);
  assert.match(text, /\/cookie/);
  assert.doesNotMatch(text, /NSFW|成熟内容不可用/);
});

test('OAuth 失效通知说明成熟主图会退回网页结果', async () => {
  const cache = new Map();
  const sent = [];
  const notifier = new AuthNotifier({
    cacheGet: async (ns, key) => cache.get(`${ns}:${key}`) ?? null,
    cacheSet: async (ns, key, value) => { if (value) cache.set(`${ns}:${key}`, value); else cache.delete(`${ns}:${key}`); },
    sendTelegram: async (method, body) => sent.push(body),
    adminIds: ['42'],
    loginUrl: 'https://bot.example/auth/deviantart/start?t=one-time',
  });

  await notifier.notifyInvalid('refresh token invalid', 'oauth');
  assert.match(sent[0].text, /OAuth 授权已失效/);
  assert.match(sent[0].text, /成熟作品的主图会退回网页/);
});

test('扩展会话状态常量覆盖四态，且 missing 与 expired 语义不同', () => {
  assert.deepEqual(Object.values(WEB_SESSION_STATUS).sort(), ['expired', 'missing', 'unknown', 'valid']);
});
