import test from 'node:test';
import assert from 'node:assert/strict';
import { DeviantArtAdapter } from '../src/deviantart/adapter.js';
import { WEB_SESSION_STATUS } from '../src/auth/cookie-store.js';

test('mature_loggedout expires web session, notifies once, and retries anonymously', async () => {
  const marks = [];
  const notifications = [];
  const cookieHeaders = [];
  let cookies = 'auth=valid';
  const env = {
    WEBHOOK_SECRET: 'secret',
    cookieStore: {
      getCookies: () => cookies,
      getState: () => ({ hasCookie: Boolean(cookies), state: cookies ? WEB_SESSION_STATUS.UNKNOWN : WEB_SESSION_STATUS.MISSING }),
      markStatus: (state) => { marks.push(state); cookies = ''; },
    },
    authNotifier: { notifyInvalid: async (reason, kind) => notifications.push([reason, kind]) },
  };
  let initCalls = 0;
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    if (url === 'https://www.deviantart.com/') return new Response("window.__CSRF_TOKEN__ = 'csrf'");
    if (url.includes('/_puppy/dadeviation/init')) {
      initCalls += 1;
      cookieHeaders.push(new Headers(init.headers).get('Cookie'));
      return Response.json(initCalls === 1 ? { deviation: {
        deviationId: '1',
        title: 'Mature',
        author: { username: 'artist' },
        isMature: true,
        isBlocked: true,
        blockReasons: ['mature_loggedout'],
        media: { baseUri: 'https://cdn.test/blur.jpg' },
      } } : { deviation: {
        deviationId: '1',
        title: 'Mature',
        author: { username: 'artist' },
        isMature: true,
        isBlocked: true,
        blockReasons: [],
        media: { baseUri: 'https://cdn.test/preview.jpg' },
      } });
    }
    throw new Error(`unexpected ${url}`);
  };
  const artwork = await new DeviantArtAdapter().getArtwork('https://www.deviantart.com/artist/art/work-1', env, {});
  assert.equal(artwork.accessStatus, 'mature-preview');
  assert.equal(artwork.media[0].url, 'https://cdn.test/preview.jpg');
  assert.equal(cookieHeaders[0], 'auth=valid');
  assert.equal(cookieHeaders[1], null);
  assert.deepEqual(marks, [WEB_SESSION_STATUS.EXPIRED]);
  assert.deepEqual(notifications, [['mature_loggedout', 'cookie']]);
});
