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

test("the glow colour is the tint at full brightness and more saturated", () => {
  const [r, g, b] = Palette.glow([253, 123, 117]);            // a salmon red
  assert.equal(Math.max(r, g, b), 255);
  assert.ok(r === 255 && g < 123 && b < 117, `got ${[r, g, b]}`);
  assert.deepEqual(Palette.glow([200, 200, 205]), [236, 244, 255]);   // a grey tint glows near-white
});

test("themeVars gives the whole colour set, in the cover's hue, with light skies and dark text", () => {
  const cols = Palette.fromPixels(image([[[200, 20, 30], 340], [[240, 240, 240], 60]]));
  const v = Palette.themeVars(cols);
  for (const name of ["--sky-top", "--sky-mid", "--sky-low", "--aqua-1", "--aqua-2", "--aqua-3", "--text", "--muted", "--sel", "--grass", "--grass-deep", "--g1", "--g2", "--g4", "--card", "--card2"])
    assert.ok(v[name], name);
  const rgb = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
  const lum = c => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  const hue = hueOf(rgb(v["--aqua-2"]));
  assert.ok(hue < 25 || hue > 335, `hue ${hue}`);
  assert.ok(lum(rgb(v["--sky-low"])) > 200, "a light horizon");
  assert.ok(lum(rgb(v["--text"])) < 90, "dark text");
});
