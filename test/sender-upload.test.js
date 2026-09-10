import test from 'node:test';
import assert from 'node:assert/strict';
import { sendArtworkPlan } from '../src/telegram/sender.js';

test('multipart album does not silently drop a photo that cannot be compressed', async () => {
  const originalFetch = globalThis.fetch;
  const posts = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    if (url.startsWith('https://cdn.test/')) {
      return new Response(new Uint8Array(11 * 1024 * 1024), { headers: { 'Content-Type': 'image/jpeg' } });
    }
    const form = init.body;
    posts.push({
      method: url.split('/').pop(),
      fields: form instanceof FormData ? [...form.keys()] : [],
    });
    return Response.json({ ok: true, result: { document: { file_id: `doc-${posts.length}` } } });
  };
  try {
    const message = { message_id: 1, chat: { id: 9, type: 'private' } };
    const results = await sendArtworkPlan([
      { kind: 'photo', url: 'https://cdn.test/a.jpg' },
      { kind: 'photo', url: 'https://cdn.test/b.jpg' },
    ], message, { BOT_TOKEN: '123:test' }, { upload: true });
    assert.equal(results.length, 2);
    assert.deepEqual(posts.map((post) => post.method), ['sendDocument', 'sendDocument']);
    assert.ok(posts.every((post) => post.fields.includes('document')));
  } finally {
    globalThis.fetch = originalFetch;
  }
});
