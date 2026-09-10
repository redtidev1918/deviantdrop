import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleUpdate } from '../src/index.js';
import { CookieStore } from '../src/auth/cookie-store.js';

function freshStore() {
  return new CookieStore({ path: join(mkdtempSync(join(tmpdir(), 'dd-cookie-')), 'cookies.json') });
}

function stubTelegram(calls) {
  return async (input, init = {}) => {
    const url = String(input);
    if (url === 'https://www.deviantart.com/') {
      return new Response('{"isLoggedIn":true}', { headers: { 'Content-Type': 'text/html' } });
    }
    calls.push({ method: url.split('/').pop(), body: JSON.parse(init.body) });
    return Response.json({ ok: true, result: { message_id: 1 } });
  };
}

const adminMessage = (text, extra = {}) => ({
  message: { from: { id: 42 }, chat: { id: 42, type: 'private' }, message_id: 7, text, ...extra },
});

test('/cookie saves the pasted web session, verifies it, and deletes the secret message', async (t) => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  const calls = [];
  globalThis.fetch = stubTelegram(calls);

  const cookieStore = freshStore();
  const env = { BOT_TOKEN: '111:secret', WEBHOOK_SECRET: 'secret', ADMIN_IDS: '42', cookieStore };

  await handleUpdate(adminMessage('/cookie auth=abc; auth_secure=def; userinfo=ghi'), env);

  assert.equal(cookieStore.getCookies(), 'auth=abc; auth_secure=def; userinfo=ghi');
  assert.equal(cookieStore.getState().state, 'valid');
  assert.ok(calls.some((call) => call.method === 'deleteMessage' && call.body.message_id === 7), 'should try to delete the message holding the secret');
  assert.match(calls.at(-1).body.text, /网页会话已更新并验证有效/);
});

test('/cookie rejects a malformed value and keeps the old session', async (t) => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  const calls = [];
  globalThis.fetch = stubTelegram(calls);

  const cookieStore = freshStore();
  cookieStore.set('auth=old; auth_secure=old; userinfo=old');
  const env = { BOT_TOKEN: '111:secret', WEBHOOK_SECRET: 'secret', ADMIN_IDS: '42', cookieStore };

  await handleUpdate(adminMessage('/cookie not-a-cookie'), env);

  assert.match(calls.at(-1).body.text, /Cookie 格式无效/);
  assert.equal(cookieStore.getCookies(), 'auth=old; auth_secure=old; userinfo=old');
  assert.ok(!calls.some((call) => call.method === 'deleteMessage'));
});

test('/cookie without arguments explains how to copy the header', async (t) => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  const calls = [];
  globalThis.fetch = stubTelegram(calls);

  const env = { BOT_TOKEN: '111:secret', WEBHOOK_SECRET: 'secret', ADMIN_IDS: '42', cookieStore: freshStore() };

  await handleUpdate(adminMessage('/cookie'), env);

  assert.match(calls.at(-1).body.text, /DevTools/);
  assert.match(calls.at(-1).body.text, /\/cookie auth=/);
});

test('/cookie is refused without a CookieStore and for non-admins', async (t) => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  const calls = [];
  globalThis.fetch = stubTelegram(calls);

  const env = { BOT_TOKEN: '111:secret', WEBHOOK_SECRET: 'secret', ADMIN_IDS: '42' };
  await handleUpdate(adminMessage('/cookie auth=a; auth_secure=b; userinfo=c'), env);
  assert.match(calls.at(-1).body.text, /没有 CookieStore/);

  await handleUpdate({ message: { from: { id: 99 }, chat: { id: 99, type: 'private' }, message_id: 8, text: '/cookie auth=a; auth_secure=b; userinfo=c' } }, { ...env, cookieStore: freshStore() });
  assert.match(calls.at(-1).body.text, /仅 Bot 所有者可用/);
});
