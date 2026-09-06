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

// —— 双通道兜底（国内 VPS：clash 挂了 API 回退直连；媒体直连挂了回退代理）——
const mockAgents = () => ({ proxyAgent: { tag: 'proxy' }, directAgent: { tag: 'direct' } });
const connectError = (code) => {
  const err = new Error(`connect ${code}`);
  err.cause = { code };
  return err;
};
const json = (obj) => new Response(JSON.stringify(obj), { headers: { 'content-type': 'application/json' } });

test('media CDN (wixmp) prefers direct and falls back to proxy on connect failure', async () => {
  const { proxyAgent, directAgent } = mockAgents();
  const seen = [];
  const nativeFetch = async (_input, init) => {
    seen.push(init.dispatcher.tag);
    if (init.dispatcher === directAgent) throw connectError('ECONNREFUSED');
    return json({ via: 'proxy' });
  };
  const fetch = createProxyFetch(proxyAgent, directAgent, nativeFetch);
  const res = await fetch('https://images-wixmp-ed30a86b8c4ca887773594c2.wixmp.com/f/x/p.png');
  assert.equal((await res.json()).via, 'proxy');
  assert.deepEqual(seen, ['direct', 'proxy']);
});

test('API host (telegram) prefers proxy and falls back to direct on connect failure', async () => {
  const { proxyAgent, directAgent } = mockAgents();
  const seen = [];
  const nativeFetch = async (_input, init) => {
    seen.push(init.dispatcher.tag);
    if (init.dispatcher === proxyAgent) throw connectError('ECONNREFUSED');
    return json({ via: 'direct' });
  };
  const fetch = createProxyFetch(proxyAgent, directAgent, nativeFetch);
  const res = await fetch('https://api.telegram.org/bot123/getMe');
  assert.equal((await res.json()).via, 'direct');
  assert.deepEqual(seen, ['proxy', 'direct']);
});

test('HTTP error responses do not trigger fallback (agent chosen once)', async () => {
  const { proxyAgent, directAgent } = mockAgents();
  const seen = [];
  const nativeFetch = async (_input, init) => {
    seen.push(init.dispatcher.tag);
    return new Response('forbidden', { status: 403 });
  };
  const fetch = createProxyFetch(proxyAgent, directAgent, nativeFetch);
  const res = await fetch('https://api.telegram.org/bot123/getMe');
  assert.equal(res.status, 403);
  assert.deepEqual(seen, ['proxy']);
});

test('aborted request does not trigger fallback even on connect error', async () => {
  const { proxyAgent, directAgent } = mockAgents();
  const seen = [];
  const controller = new AbortController();
  controller.abort();
  const nativeFetch = async (_input, init) => {
    seen.push(init.dispatcher.tag);
    throw connectError('ECONNREFUSED');
  };
  const fetch = createProxyFetch(proxyAgent, directAgent, nativeFetch);
  await assert.rejects(fetch('https://api.telegram.org/x', { signal: controller.signal }));
  assert.deepEqual(seen, ['proxy']);
});

test('non-connect error does not trigger fallback', async () => {
  const { proxyAgent, directAgent } = mockAgents();
  const seen = [];
  const nativeFetch = async (_input, init) => {
    seen.push(init.dispatcher.tag);
    throw new Error('some other failure');
  };
  const fetch = createProxyFetch(proxyAgent, directAgent, nativeFetch);
  await assert.rejects(fetch('https://api.telegram.org/x'), /some other failure/);
  assert.deepEqual(seen, ['proxy']);
});
