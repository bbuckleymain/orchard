// The colours of the cover, for the lyrics in fullscreen: up to three vivid, light tints of what the cover is made of.
// The approach is FollowTheLyrics': cluster the pixels in OKLab, favour big and colourful clusters, keep their hues apart,
// then lift each one to a lightness and chroma that read well on a dark backdrop.

const Palette = (() => {
  const K = 6, CHROMA_MIN = 0.032, SHARE_MIN = 0.012, HUE_GAP = 28, TEXT_L = [0.64, 0.88], TEXT_C = [0.11, 0.25];
  const DEEP_L = [0.30, 0.48], DEEP_C = [0.09, 0.2];      // the same colours, darker, for text on a light backdrop
  const FALLBACK = [[244, 247, 255], [214, 228, 255], [255, 240, 228]], DEEP_FALLBACK = [[6, 49, 79], [26, 90, 140], [70, 60, 130]];

  const toLinear = v => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  const fromLinear = v => { v = Math.min(1, Math.max(0, v)); return Math.round(255 * (v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055)); };

  function toOklab(r, g, b) {
    const lr = toLinear(r / 255), lg = toLinear(g / 255), lb = toLinear(b / 255);
    const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
    const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
    const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
    return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
  }
  function oklabToLinear(L, a, b) {
    const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3, m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3, s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
    return [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s];
  }
  // A colour of this lightness and hue, with as much of the wanted chroma as fits in sRGB.
  function lchToRgb(L, C, hue) {
    const h = hue * Math.PI / 180;
    let lin;
    for (let i = 0; i < 40; i++) {
      lin = oklabToLinear(L, C * Math.cos(h), C * Math.sin(h));
      if (lin.every(v => v >= -0.0005 && v <= 1.0005)) break;
      C *= 0.95;
    }
    return lin.map(fromLinear);
  }
  const hueGap = (a, b) => { const d = Math.abs(a - b) % 360; return Math.min(d, 360 - d); };

  // Deterministic k-means on [L*0.6, a, b]: the first centre is the first pixel, each next one the farthest from those so far.
  function cluster(pts, k, iters = 12) {
    const centres = [pts[0].slice()];
    const dist = p => centres.reduce((best, c) => Math.min(best, (p[0] - c[0]) ** 2 + (p[1] - c[1]) ** 2 + (p[2] - c[2]) ** 2), Infinity);
    while (centres.length < k) {
      let far = pts[0], farD = -1;
      for (const p of pts) { const d = dist(p); if (d > farD) { farD = d; far = p; } }
      if (farD <= 1e-9) break;
      centres.push(far.slice());
    }
    const label = new Array(pts.length).fill(0);
    for (let it = 0; it < iters; it++) {
      pts.forEach((p, i) => {
        let best = 0, bd = Infinity;
        centres.forEach((c, j) => { const d = (p[0] - c[0]) ** 2 + (p[1] - c[1]) ** 2 + (p[2] - c[2]) ** 2; if (d < bd) { bd = d; best = j; } });
        label[i] = best;
      });
      centres.forEach((c, j) => {
        let n = 0, s = [0, 0, 0];
        pts.forEach((p, i) => { if (label[i] === j) { n++; s[0] += p[0]; s[1] += p[1]; s[2] += p[2]; } });
        if (n) centres[j] = s.map(v => v / n);
      });
    }
    return { centres, label };
  }

  // pixels: RGBA bytes (a canvas' getImageData().data). Returns up to three [r, g, b], the main colour first.
  function fromPixels(data, deep = false) {
    const [lo, hi] = deep ? DEEP_L : TEXT_L, [cLo, cHi] = deep ? DEEP_C : TEXT_C, fallback = deep ? DEEP_FALLBACK : FALLBACK;
    const labs = [];
    for (let i = 0; i + 3 < data.length; i += 4) if (data[i + 3] > 200) labs.push(toOklab(data[i], data[i + 1], data[i + 2]));
    if (!labs.length) return fallback;
    const { centres, label } = cluster(labs.map(([L, a, b]) => [L * 0.6, a, b]), K);
    const fams = centres.map((_, j) => {
      const idx = []; labs.forEach((p, i) => { if (label[i] === j) idx.push(i); });
      if (!idx.length) return null;
      const chroma = i => Math.hypot(labs[i][1], labs[i][2]);
      const top = idx.sort((a, b) => chroma(a) - chroma(b)).slice(idx.length >> 1);   // the more colourful half of the cluster
      const m = [0, 1, 2].map(c => top.reduce((s, i) => s + labs[i][c], 0) / top.length);
      return { share: idx.length / labs.length, L: m[0], C: Math.hypot(m[1], m[2]), h: (Math.atan2(m[2], m[1]) * 180 / Math.PI + 360) % 360 };
    }).filter(f => f && f.C >= CHROMA_MIN && f.share >= SHARE_MIN);
    if (!fams.length) return fallback;
    const score = f => f.share ** 0.55 * f.C ** 1.15 * (f.L < 0.28 ? 0.45 : 1) * (f.h >= 35 && f.h <= 80 && f.C < 0.11 ? 0.55 : 1);   // dark and muddy yellow-browns count for less
    fams.sort((a, b) => score(b) - score(a));
    const chosen = [fams[0]];
    for (const f of fams.slice(1)) if (chosen.length < 3 && chosen.every(c => hueGap(f.h, c.h) >= HUE_GAP)) chosen.push(f);
    return chosen.map(f => {
      const pref = lo + (hi - lo) * Math.min(1, Math.max(0, (f.L - 0.25) / 0.6));
      return lchToRgb(pref, Math.min(cHi, Math.max(cLo, f.C * 1.35)), f.h);
    });
  }

  // From a loaded <img> (its server must allow canvas reads); null when the browser won't give the pixels.
  function fromImage(img, deep = false, size = 40) {
    try {
      const c = document.createElement("canvas");
      c.width = c.height = size;
      const g = c.getContext("2d", { willReadFrequently: true });
      g.drawImage(img, 0, 0, size, size);
      return fromPixels(g.getImageData(0, 0, size, size).data, deep);
    } catch { return null; }
  }

  return { fromPixels, fromImage, FALLBACK, DEEP_FALLBACK };
})();

if (typeof module !== "undefined") module.exports = Palette;
