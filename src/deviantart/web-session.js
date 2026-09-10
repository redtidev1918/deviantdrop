import { WEB_SESSION_STATUS } from '../auth/cookie-store.js';
import { DEVIANTART_ORIGIN, DA_HEADERS, fetchDeviantArt, getCookies, homepageLoggedIn } from './http.js';

const SESSION_TTL_SECONDS = 90;
const PROBE_TTL_SECONDS = 60;

export function currentCookie(env) {
  if (env.cookieStore) {
    if (typeof env.cookieStore.getState === 'function' && env.cookieStore.getState().state === WEB_SESSION_STATUS.EXPIRED) return null;
    return env.cookieStore.getCookies();
  }
  return env.DA_COOKIES || null;
}

export function rawCookie(env) {
  return env.cookieStore ? env.cookieStore.getCookies() : (env.DA_COOKIES || null);
}

export function currentWebStatus(env) {
  if (env.cookieStore) {
    if (typeof env.cookieStore.getState !== 'function') return env.cookieStore.getCookies() ? WEB_SESSION_STATUS.UNKNOWN : WEB_SESSION_STATUS.MISSING;
    const state = env.cookieStore.getState();
    return state.hasCookie ? state.state : WEB_SESSION_STATUS.MISSING;
  }
  return env.DA_COOKIES ? WEB_SESSION_STATUS.UNKNOWN : WEB_SESSION_STATUS.MISSING;
}

export async function probeWebSession(env, { force = false, cacheGet = async () => null, cacheSet = async () => {} } = {}) {
  if (env.cookieStore) {
    const state = env.cookieStore.getState();
    if (!state.hasCookie) return WEB_SESSION_STATUS.MISSING;
    if (!force && (state.state === WEB_SESSION_STATUS.EXPIRED || state.state === WEB_SESSION_STATUS.VALID)) return state.state;
  }
  const cookies = rawCookie(env);
  if (!cookies) return WEB_SESSION_STATUS.MISSING;
  const cacheKey = `web:probe:${cookies.length}:${hashString(cookies)}`;
  if (!force) {
    const cached = await cacheGet('da', cacheKey);
    if (cached?.state) return cached.state;
  }
  let status;
  try {
    const response = await fetchDeviantArt(DEVIANTART_ORIGIN, {
      headers: { Accept: 'text/html', ...DA_HEADERS, Cookie: cookies },
    });
    if (response.status === 401 || /\/users\/login(?:[/?]|$)/.test(response.url || '')) {
      status = WEB_SESSION_STATUS.EXPIRED;
    } else {
      const html = await response.text();
      if (homepageLoggedIn(html)) status = WEB_SESSION_STATUS.VALID;
      else if (/\\?"isLoggedIn\\?"\s*:\s*false/.test(html)) status = WEB_SESSION_STATUS.EXPIRED;
      else status = WEB_SESSION_STATUS.UNKNOWN;
    }
  } catch {
    return WEB_SESSION_STATUS.UNKNOWN;
  }
  if (status === WEB_SESSION_STATUS.VALID || status === WEB_SESSION_STATUS.EXPIRED) {
    env.cookieStore?.markStatus?.(status);
    await cacheSet('da', cacheKey, { state: status, checkedAt: Date.now() }, PROBE_TTL_SECONDS);
  }
  return status;
}

export async function getWebSession(env, memo = {}, { cacheGet = async () => null, cacheSet = async () => {}, sessionKey = null } = {}) {
  const cookies = currentCookie(env);
  if (memo.cookieRevision !== cookies) {
    memo.session = null;
    memo.cookieRevision = cookies;
  }
  if (memo.session) return memo.session;

  const cacheKey = cookies ? (sessionKey ? `session:${sessionKey}` : `session:${hashString(cookies)}`) : 'session:anonymous';
  const cached = await cacheGet('da', cacheKey);
  if (cached?.csrf) {
    memo.session = cached;
    return cached;
  }

  const headers = { Accept: 'text/html', ...DA_HEADERS };
  if (cookies) headers.Cookie = cookies;
  const home = await fetchDeviantArt(DEVIANTART_ORIGIN, { headers });
  if (cookies && (home.status === 401 || /\/users\/login(?:[/?]|$)/.test(home.url || ''))) {
    home.body?.cancel();
    if (env.cookieStore) {
      env.cookieStore.markStatus(WEB_SESSION_STATUS.EXPIRED);
      await env.authNotifier?.notifyInvalid('login_redirect', 'cookie');
    }
    return getWebSession(env, memo, { cacheGet, cacheSet });
  }
  const html = await home.text();
  if (cookies) {
    const loggedIn = homepageLoggedIn(html);
    const loggedOutMarker = /\\?"isLoggedIn\\?"\s*:\s*false/.test(html);
    if (loggedIn) env.cookieStore?.markStatus?.(WEB_SESSION_STATUS.VALID);
    if (loggedOutMarker) {
      env.cookieStore?.markStatus?.(WEB_SESSION_STATUS.EXPIRED);
      await env.authNotifier?.notifyInvalid('homepage_logged_out', 'cookie');
    }
  }
  const csrf = html.match(/window\.__CSRF_TOKEN__\s*=\s*["']([^"']+)["']/)?.[1];
  if (!csrf) throw new Error('DeviantArt 页面结构可能已变化，无法读取 CSRF token');
  const session = { csrf, cookies: cookies || getCookies(home.headers) };
  await cacheSet('da', cacheKey, session, SESSION_TTL_SECONDS);
  memo.session = session;
  return session;
}

function hashString(value) {
  let hash = 5381;
  for (let i = 0; i < value.length; i += 1) hash = ((hash << 5) + hash + value.charCodeAt(i)) | 0;
  return `h${(hash >>> 0).toString(36)}`;
}
