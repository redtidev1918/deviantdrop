import { WEB_SESSION_STATUS } from '../auth/cookie-store.js';
import { DA_HEADERS, DEVIANTART_ORIGIN, fetchDeviantArtJson } from './http.js';
import { getWebSession, currentWebStatus, rawCookie } from './web-session.js';
import { normalizeArtwork, isMatureLoggedOut, titleWithAuthor } from './media-normalizer.js';
import { parseDeviantArtTarget, resolveTargetUsername } from './targets.js';
import { officialApiGet, pickOfficialMediaUrl, resolveDeviationUuid, normalizeOfficialArtwork } from './official-api.js';
import { hmac } from './crypto.js';

export { parseDeviantArtTarget } from './targets.js';
export { titleWithAuthor } from './media-normalizer.js';

export class DeviantArtAdapter {
  constructor({ cacheGet = async () => null, cacheSet = async () => {} } = {}) {
    this.cacheGet = cacheGet;
    this.cacheSet = cacheSet;
  }

  async getArtwork(sourceUrl, env, sessionMemo = {}) {
    const url = new URL(sourceUrl);
    let target = parseDeviantArtTarget(url);
    if (!target.username) target.username = await resolveTargetUsername(url);
    if (!target.username) throw new Error('这个短链（fav.me/view）无法自动解析作者信息：请打开链接后，把完整的作品页网址（deviantart.com/作者/art/…）发给我。');

    for (let attempt = 0; ; attempt += 1) {
      const cookieRevision = rawCookie(env);
      if (sessionMemo.cookieRevision !== cookieRevision) {
        sessionMemo.session = null;
        sessionMemo.cookieRevision = cookieRevision;
      }
      const sessionKey = cookieRevision ? await hmac(cookieRevision, env.WEBHOOK_SECRET) : null;
      const session = await getWebSession(env, sessionMemo, { cacheGet: this.cacheGet, cacheSet: this.cacheSet, sessionKey });
      try {
        const endpoint = new URL('/_puppy/dadeviation/init', DEVIANTART_ORIGIN);
        endpoint.searchParams.set('deviationid', target.id);
        endpoint.searchParams.set('username', target.username);
        endpoint.searchParams.set('type', 'art');
        endpoint.searchParams.set('include_session', 'false');
        endpoint.searchParams.set('csrf_token', session.csrf);
        endpoint.searchParams.set('mature_content', 'true');

        const data = await fetchDeviantArtJson(endpoint, {
          headers: {
            Accept: 'application/json',
            Referer: url.href,
            ...DA_HEADERS,
            ...(session.cookies ? { Cookie: session.cookies } : {}),
          },
        });
        const deviation = data.deviation;
        let webStatus = currentWebStatus(env);
        if (session.cookies && isMatureLoggedOut(deviation)) {
          env.cookieStore?.markStatus?.(WEB_SESSION_STATUS.EXPIRED);
          if (sessionKey) await this.cacheSet('da', sessionKey, null, 1);
          sessionMemo.cookieRevision = rawCookie(env);
          sessionMemo.session = null;
          await env.authNotifier?.notifyInvalid('mature_loggedout', 'cookie');
          console.error(new Date().toISOString(), '[auth:web]', `state ${webStatus} -> expired reason=mature_loggedout`);
          if (attempt === 0) continue;
          webStatus = WEB_SESSION_STATUS.EXPIRED;
        }

        const hasOAuth = !!(env.credentialStore ? env.credentialStore.getRefreshToken() : env.DA_REFRESH_TOKEN);
        const artwork = normalizeArtwork(deviation, {
          sourceUrl: url.href,
          webStatus: session.cookies ? webStatus : WEB_SESSION_STATUS.MISSING,
        });

        if (artwork.mature && webStatus === WEB_SESSION_STATUS.VALID) {
          console.error(new Date().toISOString(), '[auth:web]', 'mature content authorized by web session');
        } else if (artwork.mature && hasOAuth) {
          await this.overrideMatureMainWithOfficial(env, artwork);
        }
        artwork.titleLabel = titleWithAuthor(artwork);
        artwork.accessStatus = this.accessStatus(artwork);
        return artwork;
      } catch (error) {
        const text = error instanceof Error ? error.message : String(error);
        if (attempt === 0 && /HTTP 400/.test(text)) {
          sessionMemo.session = null;
          if (sessionKey) await this.cacheSet('da', sessionKey, null, 1);
          continue;
        }
        throw error;
      }
    }
  }

  async getOfficialArtwork(sourceUrl, env) {
    const url = new URL(sourceUrl);
    const target = parseDeviantArtTarget(url);
    const uuid = await resolveDeviationUuid(target, url, env, {
      cacheGet: this.cacheGet,
      cacheSet: this.cacheSet,
      guardedFetch: this.guardedFetch.bind(this),
    });
    const deviation = await officialApiGet(env, `deviation/${uuid}`);
    const original = await pickOfficialMediaUrl(env, deviation, uuid, /^(1|true|yes)$/i.test(String(env.PREFER_ORIGINAL || '')));
    if (!original) throw new Error('作品没有可用的公开媒体');
    const artwork = normalizeOfficialArtwork({ ...deviation, content: { src: original } }, { sourceUrl: url.href });
    artwork.titleLabel = titleWithAuthor(artwork);
    artwork.accessStatus = this.accessStatus(artwork);
    return artwork;
  }

  async overrideMatureMainWithOfficial(env, artwork) {
    if (!artwork.uuid) {
      artwork.media[0].originalAvailable = false;
      return;
    }
    try {
      const deviation = await officialApiGet(env, `deviation/${artwork.uuid}`);
      const original = await pickOfficialMediaUrl(env, deviation, artwork.uuid, /^(1|true|yes)$/i.test(String(env.PREFER_ORIGINAL || '')));
      if (original) {
        artwork.media[0] = {
          kind: /\.gif($|\?)/i.test(original) ? 'animation' : /\.mp4($|\?)/i.test(original) ? 'video' : 'photo',
          url: original,
          fallbackUrl: artwork.media[0]?.fallbackUrl || null,
          mimeType: /\.gif($|\?)/i.test(original) ? 'image/gif' : /\.mp4($|\?)/i.test(original) ? 'video/mp4' : 'image/jpeg',
          originalAvailable: true,
        };
      } else {
        artwork.media[0].originalAvailable = false;
      }
    } catch {
      artwork.media[0].originalAvailable = false;
    }
  }

  accessStatus(artwork) {
    if (!artwork.mature) return 'public';
    if (artwork.webStatus === WEB_SESSION_STATUS.VALID) return 'mature-web-authorized';
    return artwork.skippedMedia > 0 || artwork.media.some((m) => !m.originalAvailable) ? 'mature-preview' : 'mature-oauth';
  }

  async guardedFetch(url, init) {
    try {
      return await fetch(url, init);
    } catch (error) {
      const label = init?.label || 'DeviantArt';
      throw new Error(`${label}连接失败或超时，请稍后再试`, { cause: error });
    }
  }
}
