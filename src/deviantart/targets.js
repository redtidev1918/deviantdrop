import { DA_HEADERS } from './http.js';

export function parseDeviantArtTarget(url) {
  if (url.hostname === 'fav.me') {
    const code = url.pathname.split('/').filter(Boolean)[0]?.replace(/^d/i, '');
    if (!code || !/^[0-9a-z]+$/i.test(code)) throw new Error('无效的 fav.me 链接');
    return { id: base36ToBigInt(code).toString(10) };
  }
  const parts = url.pathname.split('/').filter(Boolean);
  if (parts[0] === 'view' && parts[1]) return { id: parts[1] };
  if (parts[0] === 'view.php' && url.searchParams.get('id')) return { id: url.searchParams.get('id') };
  const id = parts.at(-1)?.match(/(?:^|-)(\d+)$/)?.[1];
  if (!id) throw new Error('无法从 DeviantArt 链接识别作品 ID');
  const subdomain = url.hostname.endsWith('.deviantart.com') && !['www', 'm'].includes(url.hostname.split('.')[0])
    ? url.hostname.split('.')[0]
    : null;
  return { id, username: subdomain || parts[0] };
}

export async function resolveTargetUsername(url) {
  try {
    const response = await fetch(url, {
      headers: { ...DA_HEADERS, Accept: 'text/html' },
      signal: AbortSignal.timeout(8_000),
    });
    const finalUrl = response.url || url.href;
    response.body?.cancel();
    const parts = new URL(finalUrl).pathname.split('/').filter(Boolean);
    return parts.length >= 3 && parts[1] === 'art' ? parts[0] : parts[0] || null;
  } catch {
    return null;
  }
}

function base36ToBigInt(value) {
  let result = 0n;
  for (const char of value.toLowerCase()) result = result * 36n + BigInt(parseInt(char, 36));
  return result;
}
