import test from 'node:test';
import assert from 'node:assert/strict';
import { probeWebSession } from '../src/deviantart/web-session.js';
import { WEB_SESSION_STATUS } from '../src/auth/cookie-store.js';

function cookieEnv(extra = {}) {
  const marks = [];
  return {
    marks,
    env: {
      DA_COOKIES: null,
      cookieStore: {
        getState: () => ({ hasCookie: true, state: WEB_SESSION_STATUS.UNKNOWN }),
        getCookies: () => 'auth=web',
        markStatus: (state) => marks.push(state),
      },
      ...extra,
    },
  };
}

test('explicit logged-out homepage marks web session expired', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response('{"isLoggedIn":false}', { status: 200 });
  try {
    const { env, marks } = cookieEnv();
    assert.equal(await probeWebSession(env, { force: true }), WEB_SESSION_STATUS.EXPIRED);
    assert.deepEqual(marks, [WEB_SESSION_STATUS.EXPIRED]);
  } finally {
    globalThis.fetch = original;
  }
});

test('network failure is unknown and never expires the stored session', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('timeout'); };
  try {
    const { env, marks } = cookieEnv();
    assert.equal(await probeWebSession(env, { force: true }), WEB_SESSION_STATUS.UNKNOWN);
    assert.deepEqual(marks, []);
  } finally {
    globalThis.fetch = original;
  }
});

test('5xx and WAF responses stay unknown', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response('busy', { status: 503 });
  try {
    const { env, marks } = cookieEnv();
    assert.equal(await probeWebSession(env, { force: true }), WEB_SESSION_STATUS.UNKNOWN);
    assert.deepEqual(marks, []);
  } finally {
    globalThis.fetch = original;
  }
});
