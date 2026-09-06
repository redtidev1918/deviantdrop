import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldSkipMatureExtras } from '../src/index.js';

test('成熟多图作品：无网页登录 Cookie 时跳过附加页（匿名/仅 OAuth 拿不到未打码）', () => {
  assert.equal(shouldSkipMatureExtras({ isMature: true, hasWebCookie: false, raw: [{ media: {} }] }), true);
});

test('成熟多图作品：有网页登录 Cookie 时不跳过（附加页可未打码）', () => {
  assert.equal(shouldSkipMatureExtras({ isMature: true, hasWebCookie: true, raw: [{ media: {} }] }), false);
});

test('非成熟作品：不跳过（正常多图走既有解析）', () => {
  assert.equal(shouldSkipMatureExtras({ isMature: false, hasWebCookie: false, raw: [{ media: {} }] }), false);
});

test('成熟但没有附加页：不跳过（没东西可跳）', () => {
  assert.equal(shouldSkipMatureExtras({ isMature: true, hasWebCookie: false, raw: [] }), false);
  assert.equal(shouldSkipMatureExtras({ isMature: true, hasWebCookie: false, raw: null }), false);
});
