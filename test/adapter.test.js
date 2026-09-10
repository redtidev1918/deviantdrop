import test from 'node:test';
import assert from 'node:assert/strict';
import { DeviantArtAdapter } from '../src/deviantart/adapter.js';
import { WEB_SESSION_STATUS } from '../src/auth/cookie-store.js';

// OAuth 可用（有 refresh token）但网页扩展会话已失效：
// 主图必须由官方 API 换回未打码版本，附加页才降级。
function matureEnv({ cookies, notifications = [], marks = [] }) {
  return {
    WEBHOOK_SECRET: 'secret',
    CLIENT_ID: 'client-id',
    CLIENT_SECRET: 'client-secret',
    credentialStore: { getRefreshToken: () => 'refresh-token', getState: () => ({ state: 'valid', hasToken: true, updatedAt: 'v1' }), reload: () => {}, invalidate: () => true },
    cookieStore: {
      getCookies: () => cookies.value,
      getState: () => ({ hasCookie: Boolean(cookies.value), state: cookies.value ? WEB_SESSION_STATUS.UNKNOWN : WEB_SESSION_STATUS.MISSING }),
      markStatus: (state) => { marks.push(state); cookies.value = ''; },
    },
    authNotifier: { notifyInvalid: async (reason, kind) => notifications.push([reason, kind]) },
  };
}

function stubFetch({ onPuppy, officialUrl = 'https://images-wixmp.test/original.jpg' }) {
  let puppyCalls = 0;
  const cookieHeaders = [];
  const officialCalls = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    if (url === 'https://www.deviantart.com/') return new Response("window.__CSRF_TOKEN__ = 'csrf'");
    if (url.includes('/oauth2/token')) return Response.json({ access_token: 'access-token', expires_in: 3600 });
    if (url.includes('/_puppy/dadeviation/init')) {
      puppyCalls += 1;
      cookieHeaders.push(new Headers(init.headers).get('Cookie'));
      return Response.json(onPuppy(puppyCalls));
    }
    if (url.includes('/api/v1/oauth2/')) {
      officialCalls.push(url);
      return Response.json({ deviationid: 'uuid-1', title: 'Mature', is_mature: true, content: { src: officialUrl } });
    }
    throw new Error(`unexpected ${url}`);
  };
  return { cookieHeaders, officialCalls, puppyCalls: () => puppyCalls };
}

test('mature_loggedout 只降级附加页：主图仍由 OAuth 取回未打码版本', async (t) => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  const cookies = { value: 'auth=valid' };
  const notifications = [];
  const marks = [];
  const env = matureEnv({ cookies, notifications, marks });
  const stub = stubFetch({
    onPuppy: () => ({
      deviation: {
        deviationId: '1',
        title: 'Mature multi',
        author: { username: 'artist' },
        isMature: true,
        isMultiMedia: true,
        isBlocked: true,
        blockReasons: ['mature_loggedout'],
        extended: {
          deviationUuid: 'uuid-1',
          additionalMedia: [
            { media: { baseUri: 'https://cdn.test/blur_page2.jpg' } },
            { media: { baseUri: 'https://cdn.test/blur_page3.jpg' } },
          ],
        },
        media: { baseUri: 'https://cdn.test/blur_main.jpg' },
      },
    }),
  });

  const artwork = await new DeviantArtAdapter().getArtwork('https://www.deviantart.com/artist/art/work-1', env, {});

  assert.equal(artwork.mature, true);
  assert.equal(artwork.mainSource, 'oauth');
  assert.equal(artwork.media[0].url, 'https://images-wixmp.test/original.jpg');
  assert.equal(artwork.media[0].originalAvailable, true);
  assert.equal(artwork.accessStatus, 'mature');
  // 网页会话失效只影响附加页能力，主图不受影响
  assert.equal(artwork.expansionAuthorized, false);
  assert.equal(artwork.skippedMedia, 2);
  // 凭据记账：标记过期、通知一次、匿名重试
  assert.deepEqual(marks, [WEB_SESSION_STATUS.EXPIRED]);
  assert.deepEqual(notifications, [['mature_loggedout', 'cookie']]);
  assert.equal(stub.cookieHeaders[0], 'auth=valid');
  assert.equal(stub.cookieHeaders[1], null);
  assert.equal(stub.officialCalls.length, 1);
});

test('扩展会话有效时不请求官方 API：附加页与主图都来自网页', async (t) => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  const cookies = { value: 'auth=valid' };
  const env = matureEnv({ cookies });
  const stub = stubFetch({
    onPuppy: () => ({
      deviation: {
        deviationId: '1',
        title: 'Mature multi',
        author: { username: 'artist' },
        isMature: true,
        isMultiMedia: true,
        media: { baseUri: 'https://cdn.test/main.jpg' },
        extended: {
          deviationUuid: 'uuid-1',
          additionalMedia: [{ media: { baseUri: 'https://cdn.test/page2.jpg' } }],
        },
      },
    }),
  });

  const artwork = await new DeviantArtAdapter().getArtwork('https://www.deviantart.com/artist/art/work-1', env, {});

  assert.equal(artwork.mainSource, 'oauth');
  assert.equal(artwork.expansionAuthorized, true);
  assert.equal(artwork.media.length, 2);
  assert.equal(artwork.skippedMedia, 0);
  assert.equal(stub.officialCalls.length, 1);
});

test('没有 OAuth 时成熟作品仍可发送：网页结果按响应标注是否只是预览', async (t) => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  const pieces = {
    deviation: {
      deviationId: '1',
      title: 'Mature single',
      author: { username: 'artist' },
      isMature: true,
      media: { baseUri: 'https://cdn.test/blur_only.jpg' },
    },
  };
  const stub = stubFetch({ onPuppy: () => pieces });
  const env = {
    WEBHOOK_SECRET: 'secret',
    DA_COOKIES: null,
    cookieStore: { getCookies: () => null, getState: () => ({ hasCookie: false, state: WEB_SESSION_STATUS.MISSING }) },
  };

  const artwork = await new DeviantArtAdapter().getArtwork('https://www.deviantart.com/artist/art/work-1', env, {});

  assert.equal(artwork.mainSource, 'web');
  assert.equal(artwork.media[0].originalAvailable, false);
  assert.equal(artwork.accessStatus, 'mature-preview');
  assert.equal(stub.officialCalls.length, 0);
});
