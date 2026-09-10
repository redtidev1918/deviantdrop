import test from 'node:test';
import assert from 'node:assert/strict';
import { planDelivery } from '../src/telegram/delivery-planner.js';
import { normalizeArtwork, isMatureLoggedOut } from '../src/deviantart/media-normalizer.js';

const media = (kind, n) => ({ kind, url: `https://example.test/${kind}-${n}`, fallbackUrl: null });

test('two photos and a GIF become one album plus one standalone animation', () => {
  const plan = planDelivery([media('photo', 1), media('photo', 2), media('animation', 1)]);
  assert.deepEqual(plan.map((unit) => ({ type: unit.type, kinds: unit.items.map((item) => item.kind), primary: unit.primary })), [
    { type: 'album', kinds: ['photo', 'photo'], primary: true },
    { type: 'standalone', kinds: ['animation'], primary: false },
  ]);
});

test('photo and video remain together; eleven album items split with caption only on the first unit', () => {
  const items = Array.from({ length: 11 }, (_, i) => media(i === 10 ? 'video' : 'photo', i));
  const plan = planDelivery(items);
  assert.equal(plan[0].items.length, 10);
  assert.equal(plan[1].items.length, 1);
  assert.equal(plan[0].primary, true);
  assert.equal(plan[1].primary, false);
});

test('mature_loggedout is explicit web expiry and mature extras remain unavailable', () => {
  const deviation = {
    isMature: true,
    isBlocked: true,
    isMultiMedia: true,
    blockReasons: ['mature_filter', 'mature_loggedout'],
    media: { baseUri: 'https://cdn.test/blur.jpg', token: 'blur' },
    extended: { additionalMedia: [{ media: { baseUri: 'https://cdn.test/extra.png', token: 'x' } }] },
  };
  assert.equal(isMatureLoggedOut(deviation), true);
  const artwork = normalizeArtwork(deviation, { sourceUrl: 'https://www.deviantart.com/a/art/x-1', webStatus: 'expired' });
  assert.equal(artwork.media.length, 1);
  assert.equal(artwork.skippedMedia, 1);
  assert.equal(artwork.accessStatus, 'mature_loggedout');
});
