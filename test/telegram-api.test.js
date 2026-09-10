import test from 'node:test';
import assert from 'node:assert/strict';
import { registerCommands } from '../src/telegram/api.js';

test('registerCommands sets global and admin private command scopes', async () => {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(init.body) });
    return Response.json({ ok: true, result: true });
  };
  try {
    await registerCommands({ BOT_TOKEN: '123:test' }, ['42']);
    assert.equal(calls.length, 2);
    assert.match(calls[0].url, /setMyCommands$/);
    assert.deepEqual(calls[0].body.commands.map((command) => command.command), ['start', 'help', 'about']);
    assert.deepEqual(calls[1].body.scope, { type: 'chat', chat_id: 42 });
    assert.deepEqual(calls[1].body.commands.map((command) => command.command), ['start', 'help', 'about', 'login', 'cookie', 'status']);
  } finally {
    globalThis.fetch = original;
  }
});

test('registerCommands failure does not throw during startup', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ ok: false, description: 'boom' });
  try {
    await registerCommands({ BOT_TOKEN: '123:test' }, []);
  } finally {
    globalThis.fetch = original;
  }
});
