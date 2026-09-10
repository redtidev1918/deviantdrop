import { renderArtworkCaption, openButtonMarkup, sourceLineText } from '../rendering/caption.js';
import { planDelivery } from './delivery-planner.js';
import { telegram, telegramForm } from './api.js';
import {
  PHOTO_MAX_BYTES, MEDIA_FIELDS, MIME_BY_EXTENSION,
  compressPhoto, detectFile, downloadMedia, isTooBigError,
} from './media-io.js';

function notesEnabled(env, message) {
  const mode = String(env?.CAPTION_NOTES || 'auto').trim().toLowerCase();
  if (mode === 'always' || /^(1|true|yes)$/.test(mode)) return true;
  if (mode === 'never' || /^(0|false|no|off)$/.test(mode)) return false;
  return message?.chat?.type === 'private';
}

function reply(message) {
  return {
    reply_parameters: { message_id: message.message_id, allow_sending_without_reply: true },
    ...(message.message_thread_id ? { message_thread_id: message.message_thread_id } : {}),
  };
}

export async function sendSourceLine(message, env, sourceUrl) {
  if (!sourceUrl) return;
  const { text, entities } = sourceLineText(sourceUrl);
  await telegram(env, 'sendMessage', {
    chat_id: message.chat.id,
    text,
    entities,
    link_preview_options: { is_disabled: true },
    ...reply(message),
  });
}

export async function sendArtworkPlan(media, message, env, { upload = false, onStatus = null, cap = null } = {}) {
  const units = planDelivery(media);
  const showNotes = notesEnabled(env, message);
  const caption = renderArtworkCaption(
    { title: cap?.title, author: cap?.author, mediaCount: cap?.mediaCount },
    cap?.status || {},
    { showNotes },
  ).text.slice(0, 1024);
  const results = [];

  for (const unit of units) {
    const primary = unit.primary;
    const unitCaption = primary ? caption : '';
    if (upload) results.push(...await uploadUnit(unit, message, env, unitCaption, primary, onStatus, cap));
    else results.push(...await urlUnit(unit, message, env, unitCaption, primary, cap));
  }
  return results.flat(Infinity);
}

async function urlUnit(unit, message, env, caption, primary, cap) {
  if (unit.type === 'album') {
    const result = await telegram(env, 'sendMediaGroup', {
      chat_id: message.chat.id,
      media: unit.items.map((item, index) => ({
        type: item.kind,
        media: item.url,
        ...(index === 0 && caption ? { caption } : {}),
      })),
      ...reply(message),
    });
    return Array.isArray(result) ? result : [result];
  }
  const item = unit.type === 'single' ? unit.items[0] : unit.item;
  const fields = MEDIA_FIELDS[item.kind];
  const markup = primary ? openButtonMarkup(cap?.sourceUrl) : undefined;
  try {
    const result = await telegram(env, fields[0], {
      chat_id: message.chat.id,
      [fields[1]]: item.url,
      ...(caption ? { caption } : {}),
      ...(markup ? { reply_markup: markup } : {}),
      ...reply(message),
    });
    return [result];
  } catch (error) {
    if (item.kind === 'photo' && isTooBigError(error)) {
      const result = await telegram(env, MEDIA_FIELDS.document[0], {
        chat_id: message.chat.id,
        [MEDIA_FIELDS.document[1]]: item.url,
        ...(caption ? { caption } : {}),
        ...(markup ? { reply_markup: markup } : {}),
        ...reply(message),
      });
      return [result];
    }
    throw error;
  }
}

async function uploadUnit(unit, message, env, caption, primary, onStatus, cap) {
  const entries = [];
  const documents = [];

  for (let i = 0; i < unit.items.length; i += 1) {
    const item = unit.items[i];
    const downloaded = await downloadMedia(item, onStatus, `第 ${i + 1}/${unit.items.length} 张`);
    let { bytes, extension } = downloaded;
    if (downloaded.usedFallback) extension = 'jpg';
    if (item.kind === 'photo' && bytes.length > PHOTO_MAX_BYTES) {
      const compressed = await compressPhoto(bytes);
      if (compressed) { bytes = compressed; extension = 'jpg'; }
      else { documents.push({ item: { kind: 'document' }, bytes, extension: guessExt(extension, item.kind) }); continue; }
    }
    entries.push({ item, bytes, extension });
  }

  const results = [];
  if (unit.type === 'album' && entries.length >= 2) {
    onStatus?.('正在发送相册…');
    const sent = await telegramForm(env, 'sendMediaGroup', () => {
      const form = baseForm(message);
      form.set('media', JSON.stringify(entries.map((entry, i) => ({
        type: entry.item.kind,
        media: `attach://file${i}`,
        ...(i === 0 && caption ? { caption } : {}),
      }))));
      entries.forEach((entry, i) => form.set(`file${i}`, new Blob([entry.bytes], { type: MIME_BY_EXTENSION[entry.extension] || 'application/octet-stream' }), `file${i}.${entry.extension}`));
      return form;
    });
    results.push(...(Array.isArray(sent) ? sent : [sent]));
  } else if (entries.length === 1) {
    results.push(await uploadSingle(entries[0], message, env, caption, primary, cap, onStatus));
  }
  for (let d = 0; d < documents.length; d += 1) {
    const doc = documents[d];
    results.push(await uploadSingle(
      { item: { kind: 'document' }, bytes: doc.bytes, extension: doc.extension },
      message, env, d === 0 && entries.length === 0 && primary ? caption : '', d === 0 && entries.length === 0 && primary, cap, onStatus, 'document',
    ));
  }
  return results;
}

async function uploadSingle(entry, message, env, caption, primary, cap, onStatus, forceKind = null) {
  const kind = forceKind || entry.item.kind;
  const [method, field] = MEDIA_FIELDS[kind];
  const markup = primary ? openButtonMarkup(cap?.sourceUrl) : undefined;
  const makeForm = (methodField = field, fileName = field) => {
    const form = baseForm(message);
    if (caption) form.set('caption', caption);
    if (markup) form.set('reply_markup', JSON.stringify(markup));
    form.set(methodField, new Blob([entry.bytes], { type: MIME_BY_EXTENSION[entry.extension] || 'application/octet-stream' }), `${fileName}.${entry.extension}`);
    return form;
  };
  onStatus?.('正在发送…');
  try {
    return await telegramForm(env, method, () => makeForm());
  } catch (error) {
    if (kind === 'photo' && isTooBigError(error)) {
      return telegramForm(env, MEDIA_FIELDS.document[0], () => makeForm('document', 'document'));
    }
    throw error;
  }
}

function baseForm(message) {
  const form = new FormData();
  form.set('chat_id', String(message.chat.id));
  form.set('reply_parameters', JSON.stringify({ message_id: message.message_id, allow_sending_without_reply: true }));
  if (message.message_thread_id) form.set('message_thread_id', String(message.message_thread_id));
  return form;
}

function guessExt(extension, kind) {
  return extension || { photo: 'jpg', video: 'mp4', animation: 'gif', document: 'bin' }[kind] || 'bin';
}

export async function sendFileIdPlan(files, message, env, cap) {
  const units = planDelivery(files.map((file) => ({ kind: file.kind, file_id: file.file_id })));
  const caption = renderArtworkCaption(cap, cap.status || {}, { showNotes: notesEnabled(env, message) }).text.slice(0, 1024);
  for (const unit of units) {
    const unitCaption = unit.primary ? caption : '';
    if (unit.type === 'album') {
      await telegram(env, 'sendMediaGroup', {
        chat_id: message.chat.id,
        media: unit.items.map((item, i) => ({ type: item.kind, media: item.file_id || item.url, ...(i === 0 && unitCaption ? { caption: unitCaption } : {}) })),
        ...reply(message),
      });
    } else {
      const item = unit.type === 'single' ? unit.items[0] : unit.item;
      const kind = item.kind;
      const value = item.file_id || item.url;
      const [method, field] = MEDIA_FIELDS[kind];
      const markup = unit.primary ? openButtonMarkup(cap.sourceUrl) : undefined;
      await telegram(env, method, {
        chat_id: message.chat.id,
        [field]: value,
        ...(unitCaption ? { caption: unitCaption } : {}),
        ...(markup ? { reply_markup: markup } : {}),
        ...reply(message),
      });
    }
  }
}

export function filesFromResults(results) {
  return results.map(detectFile).filter(Boolean);
}
