import { WEB_SESSION_STATUS } from '../auth/cookie-store.js';
import { DA_HEADERS, DEVIANTART_ORIGIN, fetchDeviantArtJson } from './http.js';
import { getWebSession, currentWebStatus, rawCookie } from './web-session.js';
import { normalizeArtwork, isBlurredUrl, isMatureLoggedOut, kindOfUrl, mimeForKind, titleWithAuthor } from './media-normalizer.js';
import { parseDeviantArtTarget, resolveTargetUsername } from './targets.js';
import { officialApiGet, pickOfficialMediaUrl, resolveDeviationUuid, normalizeOfficialArtwork } from './official-api.js';
import { hmac } from './crypto.js';

export { parseDeviantArtTarget } from './targets.js';
export { titleWithAuthor } from './media-normalizer.js';

// 认证分工（本文件是唯一决策点）：
//   OAuth（官方 API）  = 内容访问主认证层：mature 主图、metadata、download/content、无人值守续期。
//   Web 扩展会话       = 可选增强：官方 API 不提供的 deviation.extended.additionalMedia（多图第 2…N 页）。
// 因此：Cookie 缺失/过期只会让「附加页」降级，绝不影响 mature 主图。
export class DeviantArtAdapter {
  constructor({ cacheGet = async () => null, cacheSet = async () => {} } = {}) {
    this.cacheGet = cacheGet;
    this.cacheSet = cacheSet;
  }

  async getArtwork(sourceUrl, env, sessionMemo = {}) {
    const url = new URL(sourceUrl);
    const target = parseDeviantArtTarget(url);
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

        // 扩展能力只由「本次响应」决定，不看任何缓存的会话状态：
        // 一个可用但状态未知的 Cookie 不该丢页，一个状态为 valid 的旧 Cookie 也不该假装能取。
        const expansionAuthorized = !isMatureLoggedOut(deviation);
        if (session.cookies && !expansionAuthorized) {
          const previous = currentWebStatus(env);
          env.cookieStore?.markStatus?.(WEB_SESSION_STATUS.EXPIRED);
          if (sessionKey) await this.cacheSet('da', sessionKey, null, 1);
          sessionMemo.cookieRevision = rawCookie(env);
          sessionMemo.session = null;
          await env.authNotifier?.notifyInvalid('mature_loggedout', 'cookie');
          console.error(new Date().toISOString(), '[auth:web]', `扩展会话 ${previous} -> expired reason=mature_loggedout`);
          if (attempt === 0) continue; // 用匿名会话重取一次：主图仍要拿到
        }

        const artwork = normalizeArtwork(deviation, { sourceUrl: url.href, expansionAuthorized });
        if (artwork.mature) await this.resolveMatureMain(env, artwork, { target, url, expansionAuthorized });
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

  // 成熟主图：OAuth 优先，且不以任何会话状态为前提。
  // OAuth 拿不到时才回落到网页结果；网页也未授权时明确标记为「仅预览」。
  async resolveMatureMain(env, artwork, { target, url, expansionAuthorized }) {
    const hasOAuth = !!(env.credentialStore ? env.credentialStore.getRefreshToken() : env.DA_REFRESH_TOKEN);
    if (hasOAuth && await this.preferOfficialMain(env, artwork, { target, url })) {
      artwork.mainSource = 'oauth';
      return;
    }
    // 没有 OAuth 时才看网页结果：未授权（或本身就是打码文件）就只是预览。
    if (expansionAuthorized !== true || isBlurredUrl(artwork.media[0].url)) artwork.media[0].originalAvailable = false;
  }

  // 用官方 API 替换主图。uuid 优先用网页 DTO 给的；缺失时（例如被 block 的响应）
  // 再走一次 uuid 解析，这样「只有 OAuth、没有 Cookie」也能拿到未打码主图。
  async preferOfficialMain(env, artwork, { target, url }) {
    const uuid = artwork.uuid || await this.resolveUuid(target, url, env);
    if (!uuid) return false;
    try {
      const deviation = await officialApiGet(env, `deviation/${uuid}`);
      const original = await pickOfficialMediaUrl(env, deviation, uuid, preferOriginal(env));
      if (!original) return false;
      const kind = kindOfUrl(original);
      artwork.media[0] = {
        kind,
        url: original,
        fallbackUrl: artwork.media[0]?.fallbackUrl || null,
        mimeType: mimeForKind(kind),
        originalAvailable: true,
      };
      return true;
    } catch (error) {
      // 官方 API 失败（网络/额度/凭据）不能拖垮整个作品：保留网页结果继续发。
      // 但要留下日志，否则官方路径的实现 bug 会被静默降级成「只有预览」。
      console.error(new Date().toISOString(), '[da]', 'OAuth 主图替换失败，沿用网页结果:', error instanceof Error ? error.message : String(error));
      return false;
    }
  }

  async resolveUuid(target, url, env) {
    try {
      return await resolveDeviationUuid(target, url, env, {
        cacheGet: this.cacheGet,
        cacheSet: this.cacheSet,
        guardedFetch: this.guardedFetch.bind(this),
      });
    } catch {
      return null;
    }
  }

  async getOfficialArtwork(sourceUrl, env) {
    const url = new URL(sourceUrl);
    const target = parseDeviantArtTarget(url);
    const uuid = await this.resolveUuid(target, url, env);
    if (!uuid) throw new Error('无法把这个作品映射到 DeviantArt 官方 API 的 UUID，请稍后重试。');
    const deviation = await officialApiGet(env, `deviation/${uuid}`);
    const original = await pickOfficialMediaUrl(env, deviation, uuid, preferOriginal(env));
    if (!original) throw new Error('作品没有可用的公开媒体');
    const artwork = normalizeOfficialArtwork({ ...deviation, content: { src: original } }, { sourceUrl: url.href });
    artwork.titleLabel = titleWithAuthor(artwork);
    artwork.accessStatus = this.accessStatus(artwork);
    return artwork;
  }

  accessStatus(artwork) {
    if (!artwork.mature) return 'public';
    return artwork.media[0]?.originalAvailable ? 'mature' : 'mature-preview';
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

function preferOriginal(env) {
  return /^(1|true|yes)$/i.test(String(env.PREFER_ORIGINAL || ''));
}
