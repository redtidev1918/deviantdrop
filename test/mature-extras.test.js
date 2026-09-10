import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isMatureLoggedOut, shouldSkipMatureExtras } from '../src/index.js';
import { normalizeArtwork } from '../src/deviantart/media-normalizer.js';

function multiMatureDeviation(extraUrls) {
  return {
    deviationId: '1',
    isMature: true,
    isMultiMedia: true,
    media: { baseUri: 'https://cdn.test/main.jpg', token: 'm' },
    extended: { additionalMedia: extraUrls.map((url) => ({ media: { baseUri: url, token: 'x' } })) },
  };
}

test('成熟作品：响应未授权附加页时才跳过（与主图无关）', () => {
  assert.equal(shouldSkipMatureExtras({ isMature: true, expansionAuthorized: false, raw: [{ media: {} }] }), true);
});

test('成熟作品：响应已授权附加页时不跳过', () => {
  assert.equal(shouldSkipMatureExtras({ isMature: true, expansionAuthorized: true, raw: [{ media: {} }] }), false);
});

test('非成熟作品：从不因扩展会话跳过', () => {
  assert.equal(shouldSkipMatureExtras({ isMature: false, expansionAuthorized: false, raw: [{ media: {} }] }), false);
});

test('成熟但没有附加页：没东西可跳', () => {
  assert.equal(shouldSkipMatureExtras({ isMature: true, expansionAuthorized: false, raw: [] }), false);
  assert.equal(shouldSkipMatureExtras({ isMature: true, expansionAuthorized: false, raw: null }), false);
});

test('已授权响应里混入打码附加页：只跳过打码那一页', () => {
  const artwork = normalizeArtwork(multiMatureDeviation([
    'https://cdn.test/page2.jpg',
    'https://cdn.test/blur_page3.jpg',
  ]), { expansionAuthorized: true });
  assert.equal(artwork.media.length, 2);
  assert.equal(artwork.media[1].url, 'https://cdn.test/page2.jpg?token=x');
  assert.equal(artwork.skippedMedia, 1);
});

test('未授权响应：附加页整体计入 skippedMedia，主图仍原样返回', () => {
  const artwork = normalizeArtwork(multiMatureDeviation([
    'https://cdn.test/page2.jpg',
    'https://cdn.test/page3.jpg',
  ]), { expansionAuthorized: false });
  assert.equal(artwork.media.length, 1);
  assert.equal(artwork.media[0].url, 'https://cdn.test/main.jpg?token=m');
  assert.equal(artwork.skippedMedia, 2);
});

test('普通多图作品在无扩展会话时依然完整', () => {
  const deviation = { ...multiMatureDeviation(['https://cdn.test/page2.jpg']), isMature: false };
  const artwork = normalizeArtwork(deviation, { expansionAuthorized: false });
  assert.equal(artwork.media.length, 2);
  assert.equal(artwork.skippedMedia, 0);
});

test('mature_loggedout 是「本次响应拒绝」的信号（用于恢复网页会话，不用于拒绝作品）', () => {
  assert.equal(isMatureLoggedOut({ isMature: true, isBlocked: true, blockReasons: ['mature_filter', 'mature_loggedout'] }), true);
  assert.equal(isMatureLoggedOut({ isMature: true, blockReasons: ['mature_filter'] }), false);
});
