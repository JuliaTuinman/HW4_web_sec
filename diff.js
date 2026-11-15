// diff.js - local, grid-based screenshot comparison.
//
// 2 screenshots decoded and scaled down to same size
// image is split into cells (square)
//
// Pixel is "different" when sum of R, G, B is above a threshold
// Cell is "changed" when more than a threshold of its pixels are different

export const DEFAULTS = {
  maxWidth: 1024,        // working width in pixels
  cellSize: 32,          // cell edge in working pixels
  pixelThreshold: 48,    // |dR|+|dG|+|dB| above this means the pixel is different
  cellThreshold: 0.02    // fraction of different pixels that marks a cell as changed
};

async function decode(dataUrl) {
  const blob = await (await fetch(dataUrl)).blob();
  return createImageBitmap(blob);
}

function pixels(bitmap, w, h) {
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, 0, 0, w, h);
  return ctx.getImageData(0, 0, w, h).data;
}

/**
 * Compares a "before" and "after" screenshot (as data URLs) and tells you what changed
 */
export async function compareScreenshots(beforeUrl, afterUrl, options = {}) {
  const opt = { ...DEFAULTS, ...options };
  const [a, b] = await Promise.all([decode(beforeUrl), decode(afterUrl)]);

  // A different size means the window was resized -> so a pixel comparison would mean nothing.
  if (a.width !== b.width || a.height !== b.height) {
    a.close(); b.close();
    return { comparable: false };
  }

  const scale = Math.min(1, opt.maxWidth / a.width);
  const w = Math.max(1, Math.round(a.width * scale));
  const h = Math.max(1, Math.round(a.height * scale));
  const pa = pixels(a, w, h);
  const pb = pixels(b, w, h);
  a.close(); b.close();

  return diffPixels(pa, pb, w, h, opt);
}

// The pure comparison step, kept separate from the image decoding/scaling
export function diffPixels(pa, pb, w, h, options = {}) {
  const opt = { ...DEFAULTS, ...options };
  const cs = opt.cellSize;
  const cols = Math.ceil(w / cs);
  const rows = Math.ceil(h / cs);
  const diffCount = new Uint32Array(cols * rows);

  for (let y = 0; y < h; y++) {
    const rowBase = Math.floor(y / cs) * cols;
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const d = Math.abs(pa[i] - pb[i]) +
                Math.abs(pa[i + 1] - pb[i + 1]) +
                Math.abs(pa[i + 2] - pb[i + 2]);
      if (d > opt.pixelThreshold) diffCount[rowBase + Math.floor(x / cs)]++;
    }
  }

  const cells = [];
  let changedArea = 0;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x0 = c * cs, y0 = r * cs;
      const cw = Math.min(cs, w - x0), ch = Math.min(cs, h - y0);
      const area = cw * ch;
      if (diffCount[r * cols + c] / area > opt.cellThreshold) {
        changedArea += area;
        cells.push({ x: x0 / w, y: y0 / h, w: cw / w, h: ch / h });
      }
    }
  }

  return { comparable: true, cols, rows, cells, changedRatio: changedArea / (w * h) };
}
