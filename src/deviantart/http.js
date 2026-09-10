import { NetworkError, NotFoundError, PermissionDeniedError, RateLimitError } from '../auth/errors.js';

export const DEVIANTART_ORIGIN = 'https://www.deviantart.com/';
export const DA_HEADERS = {
  'Accept-Encoding': 'gzip, br',
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  'Accept-Language': 'en-US,en;q=0.9',
};

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function fetchDeviantArt(url, init = {}) {
  let response;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      response = await fetch(url, { ...init, signal: init.signal || AbortSignal.timeout(15_000) });
    } catch (error) {
      if (attempt === 2) throw new NetworkError('无法连接 DeviantArt，请稍后重试', { cause: error });
      await sleep(2 ** attempt * 1000);
      continue;
    }
    if (![429, 500, 503].includes(response.status) || attempt === 2) return response;
    const retryAfter = Number(response.headers.get('Retry-After'));
    response.body?.cancel();
    await sleep(Math.min(retryAfter > 0 ? retryAfter : 2 ** attempt, 5) * 1000);
  }
  return response;
}

export async function fetchDeviantArtJson(url, init) {
  const response = await fetchDeviantArt(url, init);
  throwForDeviantArtStatus(response);
  const data = await response.json().catch(() => null);
  if (!data || typeof data !== 'object') throw new Error('DeviantArt 返回了无效数据');
  return data;
}

export function throwForDeviantArtStatus(response) {
  if (response.ok) return;
  response.body?.cancel();
  if (response.status === 404) throw new NotFoundError('作品不存在、已删除或链接无效');
  if ([401, 403].includes(response.status)) throw new PermissionDeniedError();
  if (response.status === 429) throw new RateLimitError();
  if (response.status >= 500) throw new NetworkError('DeviantArt 服务暂时不可用，请稍后重试');
  throw new Error(`DeviantArt 请求失败（HTTP ${response.status}）`);
}

export function getCookies(headers) {
  const values = typeof headers.getSetCookie === 'function'
    ? headers.getSetCookie()
    : [headers.get('Set-Cookie')].filter(Boolean);
  return values.map((value) => value.split(';', 1)[0]).join('; ');
}

export function homepageLoggedIn(html) {
  return /\\?"isLoggedIn\\?"\s*:\s*true/.test(html);
}
