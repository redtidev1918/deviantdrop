import { AuthRevokedError, AuthError, NetworkError, RateLimitError } from './errors.js';

let states = new WeakMap();
export function clearOAuthAccessToken(env) {
  if (env) states.delete(env.credentialStore || env);
  else states = new WeakMap();
}

export async function getOfficialToken(env) {
  const key = env.credentialStore || env;
  let state = states.get(key);
  if (!state) { state = {}; states.set(key, state); }
  const version = env.credentialStore?.getState().updatedAt;
  if (state.token && state.expires > Date.now() && state.version === version) return state.token;
  // One refresh exchange at a time; concurrent HTTP + poll cannot rotate the same token twice.
  if (state.pending) return state.pending;
  state.pending = refresh(env, state);
  try { return await state.pending; } finally { state.pending = null; }
}

async function refresh(env, state) {
  const store = env.credentialStore;
  const oldToken = store ? store.getRefreshToken() : (state.invalid ? null : state.refreshToken || await env.loadRefreshToken?.() || env.DA_REFRESH_TOKEN);
  const body = new URLSearchParams({ client_id: env.CLIENT_ID || '', grant_type: oldToken ? 'refresh_token' : 'client_credentials' });
  if (env.CLIENT_SECRET) body.set('client_secret', env.CLIENT_SECRET);
  if (oldToken) body.set('refresh_token', oldToken);
  let response;
  try {
    response = await fetch('https://www.deviantart.com/oauth2/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body, signal: AbortSignal.timeout(15000),
    });
  } catch { throw new NetworkError('DeviantArt OAuth 连接失败', { stage: 'oauth' }); }
  const data = await response.json().catch(() => null);
  if (oldToken && store && store.getRefreshToken() !== oldToken) {
    // A new web login won while the old refresh request was in flight. Never overwrite it.
    return refresh(env, state);
  }
  if (!response.ok || !data?.access_token) {
    const invalid = /invalid[ _]grant|refresh[ _]token.*invalid/i.test(`${data?.error || ''} ${data?.error_description || ''}`);
    if (oldToken && invalid) {
      state.invalid = true; state.token = null; state.refreshToken = null;
      store?.invalidate();
      await env.clearRefreshToken?.();
      await env.authNotifier?.notifyInvalid('refresh token invalid');
      throw new AuthRevokedError();
    }
    if (response.status === 429) throw new RateLimitError();
    if (response.status >= 500) throw new NetworkError('DeviantArt OAuth 暂时不可用');
    throw new AuthError('DeviantArt OAuth 凭据被拒绝');
  }
  if (data.refresh_token) {
    if (store) store.save(data.refresh_token);
    else await env.saveRefreshToken?.(data.refresh_token);
    state.refreshToken = data.refresh_token;
  }
  state.token = data.access_token;
  state.version = store?.getState().updatedAt;
  state.expires = Date.now() + Math.max(0, Number(data.expires_in || 3600) - 60) * 1000;
  return data.access_token;
}
