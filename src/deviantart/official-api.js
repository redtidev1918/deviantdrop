import { getOfficialToken, clearOAuthAccessToken } from '../auth/token.js';
import { AuthError, AuthRevokedError, NetworkError, NotFoundError, PermissionDeniedError, RateLimitError } from '../auth/errors.js';
import { DA_HEADERS } from './http.js';
import { pickDescriptorMedia, displayMediaUrl } from './media-normalizer.js';

export const DA_API_BASE = 'https://www.deviantart.com/api/v1/oauth2/';
const DA_MINOR_VERSION = '20240701';

export async function officialApiGet(env, path, retried = false) {
  const endpoint = new URL(path, DA_API_BASE);
  endpoint.searchParams.set('mature_content', 'true');
  const response = await fetch(endpoint, {
    headers: {
      Authorization: `Bearer ${await getOfficialToken(env)}`,
      ...DA_HEADERS,
      'dA-minor-version': DA_MINOR_VERSION,
    },
    signal: AbortSignal.timeout(20_000),
  }).catch((error) => { throw new NetworkError('DeviantArt 官方 API 连接失败', { cause: error }); });

  if (response.status === 401) {
    clearOAuthAccessToken(env);
    if (!retried) return officialApiGet(env, path, true);
    throw new AuthError('DeviantArt 拒绝了访问凭据');
  }
  if (response.status === 404) throw new NotFoundError('作品不存在、已删除或链接无效');
  if (response.status === 403) throw new PermissionDeniedError();
  if (response.status === 429) throw new RateLimitError();
  if (!response.ok) throw new Error(`DeviantArt 请求失败（HTTP ${response.status}）`);
  return response.json().catch(() => { throw new Error('DeviantArt 返回了无效数据'); });
}

export async function pickOfficialMediaUrl(env, deviation, uuid, wantOriginal = false) {
  const downloadable = deviation?.is_downloadable === true;
  if (wantOriginal && downloadable) {
    try {
      const download = await officialApiGet(env, `deviation/download/${uuid}`);
      if (download?.src) return download.src;
    } catch (error) {
      if (error instanceof AuthRevokedError) throw error;
    }
  }
  return deviation?.content?.src || deviation?.thumbs?.[0]?.src || deviation?.preview?.src || null;
}

export function normalizeOfficialArtwork(deviation, { sourceUrl } = {}) {
  const url = deviation?.content?.src || deviation?.thumbs?.[0]?.src || deviation?.preview?.src;
  if (!url) throw new Error('作品没有可用的公开媒体');
  const kind = /\.gif($|\?)/i.test(url) ? 'animation' : /\.mp4($|\?)/i.test(url) ? 'video' : 'photo';
  return {
    uuid: deviation.deviationid || null,
    title: deviation.title || 'DeviantArt',
    author: deviation.author?.username || null,
    sourceUrl,
    mature: deviation.is_mature === true,
    media: [{ kind, url, fallbackUrl: deviation.preview?.src || null, mimeType: kind === 'animation' ? 'image/gif' : kind === 'video' ? 'video/mp4' : 'image/jpeg', originalAvailable: !!deviation.content?.src }],
    skippedMedia: 0,
    webStatus: 'missing',
  };
}

export async function resolveDeviationUuid(target, url, env, { cacheGet, cacheSet, guardedFetch }) {
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(target.id)) return target.id;
  const cached = await cacheGet('uuid', `d:${target.id}`);
  if (cached) return cached;
  const candidates = archivePageCandidates(url, target.username);
  if (!candidates.length) throw new Error('这种旧式/短链链接暂无法解析（DeviantArt 已限制匿名转换）：请打开链接后把完整的作品页网址发给我。');
  for (const page of candidates) {
    const uuid = await archiveUuidFromPage(page, target.id, guardedFetch);
    if (uuid) {
      await cacheSet('uuid', `d:${target.id}`, uuid, 30 * 24 * 3600);
      return uuid;
    }
  }
  throw new NetworkError('暂无法解析该作品：archive.org 还没有它的页面快照（作品可能太新），请稍后再试。');
}

async function archiveUuidFromPage(pageUrl, numeric, guardedFetch) {
  const response = await guardedFetch(`https://web.archive.org/web/2/${pageUrl}`, {
    headers: DA_HEADERS, redirect: 'follow', signal: AbortSignal.timeout(30_000),
  }, 'archive.org 快照');
  if (response.status === 404) { response.body?.cancel(); return null; }
  if (!response.ok) { response.body?.cancel(); throw new NetworkError(`archive.org 快照请求失败（HTTP ${response.status}）`); }
  const html = await response.text();
  for (const text of [html, html.replaceAll('\\"', '"')]) {
    const needle = `"deviationExtended":{"${numeric}":{"deviationUuid":"`;
    const start = text.indexOf(needle);
    if (start >= 0) {
      const uuid = text.slice(start + needle.length, start + needle.length + 36);
      if (/^[0-9a-f-]{36}$/i.test(uuid)) return uuid;
    }
  }
  return null;
}

function archivePageCandidates(url, username) {
  const input = url.href.split('#')[0];
  const host = url.hostname.toLowerCase();
  const legacySubdomain = host.endsWith('.deviantart.com') && !['www', 'm', 'fav'].includes(host.split('.')[0]);
  const canonical = legacySubdomain ? `https://www.deviantart.com/${username}${url.pathname}` : null;
  return [input, canonical].filter(Boolean);
}
