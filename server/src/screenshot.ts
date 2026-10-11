// Studio window capture → crop to the 3D viewport → downscale → JPEG.

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PNG } from "pngjs";
import jpeg from "jpeg-js";
import { CACHE_DIR, SCRIPTS_DIR } from "./config.js";

export interface Image {
  width: number;
  height: number;
  data: Buffer; // RGBA
}

let dllPath: string | undefined;

async function helperDll(script: string): Promise<string> {
  if (dllPath) return dllPath;
  const src = await fs.readFile(script);
  const hash = createHash("sha1").update(src).digest("hex").slice(0, 10);
  await fs.mkdir(CACHE_DIR, { recursive: true });
  dllPath = path.join(CACHE_DIR, `RoLinkCapture-${hash}.dll`);
  return dllPath;
}

export async function captureStudio(titleHint: string): Promise<{ image: Image; title: string }> {
  if (process.platform !== "win32") throw new Error("Screenshots are only supported on Windows");
  const script = path.join(SCRIPTS_DIR, "capture.ps1");
  const out = path.join(os.tmpdir(), `rolink-shot-${process.pid}-${Date.now()}.png`);
  const dll = await helperDll(script);
  const stdout = await new Promise<string>((resolve, reject) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script, "-Out", out, "-Title", titleHint, "-Dll", dll],
      { timeout: 30_000, windowsHide: true },
      (err, so, se) => {
        if (err && !so) reject(new Error(`capture failed: ${se || err.message}`));
        else resolve(so);
      },
    );
  });
  const line = stdout.trim().split(/\r?\n/).pop() ?? "";
  let res: { ok: boolean; error?: string; title?: string };
  try {
    res = JSON.parse(line);
  } catch {
    throw new Error(`capture helper returned: ${stdout.slice(0, 300)}`);
  }
  if (!res.ok) throw new Error(res.error ?? "capture failed");
  const buf = await fs.readFile(out);
  fs.unlink(out).catch(() => {});
  const png = PNG.sync.read(buf);
  return { image: { width: png.width, height: png.height, data: png.data }, title: res.title ?? "" };
}

const isMarker = (d: Buffer, i: number) => d[i] >= 245 && d[i + 1] <= 12 && d[i + 2] >= 245;

/**
 * The plugin draws magenta squares in the viewport's top-left and bottom-right
 * corners. Find them and crop to the rectangle they span.
 */
export function cropToMarkers(img: Image): { image: Image; found: boolean } {
  const { width: w, height: h, data } = img;
  let minX = w,
    minY = h,
    maxX = -1,
    maxY = -1,
    count = 0;
  for (let y = 0; y < h; y++) {
    let row = y * w * 4;
    for (let x = 0; x < w; x++, row += 4) {
      if (isMarker(data, row)) {
        count++;
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }
  const area = (maxX - minX) * (maxY - minY);
  if (count < 8 || count > 4000 || area < 100 * 100) return { image: img, found: false };

  const cw = maxX - minX + 1;
  const ch = maxY - minY + 1;
  const out = Buffer.alloc(cw * ch * 4);
  for (let y = 0; y < ch; y++) {
    data.copy(out, y * cw * 4, ((minY + y) * w + minX) * 4, ((minY + y) * w + minX + cw) * 4);
  }
  // paint the markers over with the pixel just outside each square
  const cleaned: Image = { width: cw, height: ch, data: out };
  paintOver(cleaned, 0, 0, 1, 1);
  paintOver(cleaned, cw - 1, ch - 1, -1, -1);
  return { image: cleaned, found: true };
}

function paintOver(img: Image, cx: number, cy: number, dx: number, dy: number) {
  const { width: w, height: h, data } = img;
  // marker extent from this corner
  let size = 0;
  while (size < 40 && isMarker(data, ((cy + dy * size) * w + (cx + dx * size)) * 4)) size++;
  if (size === 0) return;
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const x = cx + dx * i;
      const y = cy + dy * j;
      const sx = cx + dx * (size + 1);
      const sy = y;
      if (sx < 0 || sx >= w || y < 0 || y >= h) continue;
      data.copy(data, (y * w + x) * 4, (sy * w + sx) * 4, (sy * w + sx) * 4 + 4);
    }
  }
}

/** Box-filter downscale so width <= maxW and height <= maxH. */
export function downscale(img: Image, maxW: number, maxH: number): Image {
  const scale = Math.min(1, maxW / img.width, maxH / img.height);
  if (scale >= 1) return img;
  const nw = Math.max(1, Math.round(img.width * scale));
  const nh = Math.max(1, Math.round(img.height * scale));
  const out = Buffer.alloc(nw * nh * 4);
  const fx = img.width / nw;
  const fy = img.height / nh;
  for (let y = 0; y < nh; y++) {
    const y0 = Math.floor(y * fy);
    const y1 = Math.max(y0 + 1, Math.floor((y + 1) * fy));
    for (let x = 0; x < nw; x++) {
      const x0 = Math.floor(x * fx);
      const x1 = Math.max(x0 + 1, Math.floor((x + 1) * fx));
      let r = 0,
        g = 0,
        b = 0,
        n = 0;
      for (let yy = y0; yy < y1; yy++) {
        let i = (yy * img.width + x0) * 4;
        for (let xx = x0; xx < x1; xx++, i += 4) {
          r += img.data[i];
          g += img.data[i + 1];
          b += img.data[i + 2];
          n++;
        }
      }
      const o = (y * nw + x) * 4;
      out[o] = r / n;
      out[o + 1] = g / n;
      out[o + 2] = b / n;
      out[o + 3] = 255;
    }
  }
  return { width: nw, height: nh, data: out };
}

export function toJpeg(img: Image, quality = 82): Buffer {
  return Buffer.from(jpeg.encode({ width: img.width, height: img.height, data: img.data }, quality).data);
}

export function toPng(img: Image): Buffer {
  const png = new PNG({ width: img.width, height: img.height });
  img.data.copy(png.data);
  return PNG.sync.write(png);
}
