import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { Agent } from 'undici';
import { createProxyFetch } from '../src/network.js';

test('proxy fetch transmits native FormData as real multipart bytes', async () => {
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ type: req.headers['content-type'], body: Buffer.concat(chunks).toString() }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const agent = new Agent();
  try {
    const fetch = createProxyFetch(agent, agent);
    const form = new FormData();
    form.set('media', JSON.stringify([{ type: 'photo', media: 'attach://file0' }]));
    form.set('file0', new Blob(['image-bytes'], { type: 'image/jpeg' }), 'photo.jpg');
    const response = await fetch(new URL(`http://127.0.0.1:${server.address().port}/`), { method: 'POST', body: form });
    const data = await response.json();
    assert.match(data.type, /^multipart\/form-data; boundary=/);
    assert.match(data.body, /name="media"/);
    assert.match(data.body, /attach:\/\/file0/);
    assert.match(data.body, /filename="photo.jpg"/);
    assert.match(data.body, /image-bytes/);
  } finally {
    await agent.close();
    await new Promise(resolve => server.close(resolve));
  }
});
