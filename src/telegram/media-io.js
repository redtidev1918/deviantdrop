import { DA_HEADERS, DEVIANTART_ORIGIN } from '../deviantart/http.js';

export const PHOTO_MAX_BYTES = 10 * 1024 * 1024;

export const MEDIA_FIELDS = {
  photo: ['sendPhoto', 'photo'],
  video: ['sendVideo', 'video'],
  animation: ['sendAnimation', 'animation'],
  document: ['sendDocument', 'document'],
};

export const MIME_BY_EXTENSION = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp',
  gif: 'image/gif', mp4: 'video/mp4', m4v: 'video/mp4',
};

export async function downloadMedia(item, onStatus = null, label = '媒体下载') {
  let response = await guardedFetch(item.url, {
    headers: { ...DA_HEADERS, Referer: DEVIANTART_ORIGIN },
    signal: AbortSignal.timeout(180_000),
  }, label);
  let usedFallback = false;
  if (!response.ok) {
    response.body?.cancel();
    if ((response.status === 403 || response.status === 429) && item.fallbackUrl && item.fallbackUrl !== item.url) {
      response = await guardedFetch(item.fallbackUrl, {
        headers: { ...DA_HEADERS, Referer: DEVIANTART_ORIGIN },
        signal: AbortSignal.timeout(120_000),
      }, '展示图下载');
      if (!response.ok) {
        response.body?.cancel();
        throw quotaOrMediaError(response.status);
      }
      usedFallback = true;
    } else {
      throw quotaOrMediaError(response.status);
    }
  }
  const chunks = [];
  const reader = response.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  return { bytes: concatBytes(chunks), extension: guessExtension(usedFallback ? item.fallbackUrl : item.url, item.kind), usedFallback };
}

export async function compressPhoto(bytes) {
  try {
    const sharp = (await import('sharp')).default;
    const meta = await sharp(bytes, { failOnError: 'none' }).metadata();
    if (!meta.width || !meta.height) return null;
    for (const quality of [85, 75, 65, 55, 45]) {
      const out = await sharp(bytes, { failOnError: 'none' }).rotate().flatten({ background: '#fff' }).jpeg({ quality, progressive: true }).toBuffer();
      if (out.length <= PHOTO_MAX_BYTES) return out;
    }
    return null;
  } catch {
    return null;
  }
}

export function detectFile(result) {
  if (!result) return null;
  if (result.document?.file_id) return { kind: 'document', file_id: result.document.file_id };
  if (result.video?.file_id) return { kind: 'video', file_id: result.video.file_id };
  if (result.animation?.file_id) return { kind: 'animation', file_id: result.animation.file_id };
  if (Array.isArray(result.photo) && result.photo.length) {
    return { kind: 'photo', file_id: result.photo.at(-1)?.file_id || result.photo[0]?.file_id };
  }
  return null;
}

export function isTooBigError(error) {
  return /file (?:is|of size .* is) too big|image is too big|too large|PHOTO_INVALID_DIMENSIONS/i.test(error?.message || String(error));
}

export function quotaOrMediaError(status) {
  if (status === 403 || status === 429) return new Error('原图下载被 DeviantArt 限制：免费账号每日原图下载有限额，今天可能已用尽');
  return new Error(`媒体下载失败（HTTP ${status}）`);
}

async function guardedFetch(url, init, label) {
  try { return await fetch(url, init); }
  catch (error) { throw new Error(`${label}连接失败或超时，请稍后再试`, { cause: error }); }
}

function concatBytes(chunks) {
  const size = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const out = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.byteLength; }
  return out;
}

export function guessExtension(mediaUrl, kind) {
  const leaf = new URL(mediaUrl).pathname.split('/').pop() || '';
  const ext = leaf.includes('.') ? leaf.split('.').pop().toLowerCase() : '';
  if (/^[a-z0-9]{2,5}$/.test(ext)) return ext;
  return { photo: 'jpg', video: 'mp4', animation: 'gif' }[kind] || 'bin';
}
