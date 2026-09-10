// Telegram delivery capability boundary. DeviantArt media is planned once;
// URL upload, multipart upload, and file_id replay all execute the same plan.
// Contiguous photo/video runs become albums, so a GIF cannot silently reorder
// non-adjacent pages.

export const ALBUM_KINDS = new Set(['photo', 'video']);
export const ALBUM_LIMIT = 10;

export function planDelivery(items = []) {
  const units = [];
  let run = [];
  const flush = () => {
    for (let i = 0; i < run.length; i += ALBUM_LIMIT) {
      const slice = run.slice(i, i + ALBUM_LIMIT);
      units.push({
        type: slice.length === 1 ? 'single' : 'album',
        primary: false,
        items: slice,
      });
    }
    run = [];
  };

  items.forEach((input, index) => {
    const item = { ...input, sourceIndex: index };
    if (ALBUM_KINDS.has(item.kind)) {
      run.push(item);
      return;
    }
    flush();
    units.push({ type: 'standalone', primary: false, item, items: [item] });
  });
  flush();

  if (units.length) units[0].primary = true;
  return units;
}

export function planFileIds(files = []) {
  return planDelivery(files.map((file) => ({ kind: file.kind, file })));
}
