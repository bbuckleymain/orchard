// Cover colours for the fullscreen lyrics (ui/palette.js).
const test = require("node:test");
const assert = require("node:assert/strict");
const Palette = require("../ui/palette.js");

const image = parts => {                           // parts: [[r, g, b], share]; a 20x20 picture
  const px = [];
  for (const [rgb, n] of parts) for (let i = 0; i < n; i++) px.push(...rgb, 255);
  return Uint8ClampedArray.from(px);
};
const hueOf = ([r, g, b]) => { const mx = Math.max(r, g, b), mn = Math.min(r, g, b); if (mx === mn) return -1;
  const d = mx - mn; const h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4; return (h * 60 + 360) % 360; };

test("a mostly red cover gives a light tint of red", () => {
  const [main] = Palette.fromPixels(image([[[200, 20, 30], 340], [[240, 240, 240], 60]]));
  const h = hueOf(main);
  assert.ok(h < 25 || h > 335, `hue ${h}`);
  assert.ok(Math.min(...main) >= 90 && Math.max(...main) >= 200, `a light colour, got ${main}`);   // readable on a dark backdrop
});

test("a grey cover falls back to near-white tints", () => {
  assert.deepEqual(Palette.fromPixels(image([[[120, 120, 120], 400]])), Palette.FALLBACK);
});

test("two colourful areas give two colours whose hues are apart", () => {
  const out = Palette.fromPixels(image([[[20, 80, 220], 220], [[230, 40, 40], 180]]));
  assert.ok(out.length >= 2);
  const d = Math.abs(hueOf(out[0]) - hueOf(out[1]));
  assert.ok(Math.min(d, 360 - d) >= 28);
});

test("no opaque pixels gives the fallback", () => {
  assert.deepEqual(Palette.fromPixels(Uint8ClampedArray.from([1, 2, 3, 0, 4, 5, 6, 0])), Palette.FALLBACK);
});

test("the deep tints are darker than the light ones, in the same hue", () => {
  const px = image([[[200, 20, 30], 340], [[240, 240, 240], 60]]);
  const [light] = Palette.fromPixels(px), [deep] = Palette.fromPixels(px, true);
  assert.ok(Math.max(...deep) < Math.max(...light));
  const d = Math.abs(hueOf(light) - hueOf(deep));
  assert.ok(Math.min(d, 360 - d) < 20, `hues ${hueOf(light)} and ${hueOf(deep)}`);
  assert.deepEqual(Palette.fromPixels(image([[[120, 120, 120], 400]]), true), Palette.DEEP_FALLBACK);
});
