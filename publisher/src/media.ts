// Local validation against the limits in
// https://create.roblox.com/docs/cloud/guides/usage-assets#supported-asset-types-and-limits
// Parses headers directly so no ffprobe or image library is needed.

import crypto from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";

export type AssetKind = "audio" | "image" | "animation";

export const MAX_FILE_BYTES = 20 * 1024 * 1024;
export const MAX_AUDIO_SECONDS = 7 * 60;
/** The docs say "smaller than 8000x8000", so 8000 itself is refused. */
export const MAX_IMAGE_SIDE = 8000;

const AUDIO: Record<string, string> = { ".mp3": "audio/mpeg", ".ogg": "audio/ogg", ".wav": "audio/wav", ".flac": "audio/flac" };
const IMAGE: Record<string, string> = { ".png": "image/png", ".jpeg": "image/jpeg", ".jpg": "image/jpeg", ".bmp": "image/bmp", ".tga": "image/tga" };
/** The guide also lists .rbxmx, but a report of a 400 for it keeps this to the binary format. */
const ANIMATION: Record<string, string> = { ".rbxm": "model/x-rbxm" };
const ALLOWED: Record<AssetKind, Record<string, string>> = { audio: AUDIO, image: IMAGE, animation: ANIMATION };

export interface MediaInfo {
  file: string;
  ext: string;
  sizeBytes: number;
  sha256: string;
  contentType: string;
  durationSeconds?: number;
  width?: number;
  height?: number;
  data: Buffer;
}

export function sha256(data: Buffer): string {
  return crypto.createHash("sha256").update(data).digest("hex");
}

export async function inspectMedia(file: string, kind: AssetKind): Promise<MediaInfo> {
  if (!path.isAbsolute(file)) throw new Error(`Path must be absolute: ${file}`);
  const ext = path.extname(file).toLowerCase();
  const allowed = ALLOWED[kind];
  const contentType = allowed[ext];
  if (!contentType) throw new Error(`Extension "${ext}" is not supported for ${kind}. Allowed: ${Object.keys(allowed).join(", ")}`);

  const stat = await fsp.stat(file).catch(() => undefined);
  if (!stat || !stat.isFile()) throw new Error(`File not found: ${file}`);
  if (stat.size > MAX_FILE_BYTES) throw new Error(`File is ${(stat.size / 1048576).toFixed(1)} MiB; Roblox accepts up to 20 MB per asset.`);

  const data = await fsp.readFile(file);
  // the file can grow between stat and read
  if (data.length > MAX_FILE_BYTES) throw new Error(`File is ${(data.length / 1048576).toFixed(1)} MiB; Roblox accepts up to 20 MB per asset.`);
  const info: MediaInfo = { file, ext, sizeBytes: data.length, sha256: sha256(data), contentType, data };
  if (kind === "animation") {
    if (data.toString("latin1", 0, 8) !== "<roblox!") throw new Error(`${path.basename(file)} does not look like a binary .rbxm file.`);
  } else if (kind === "audio") {
    info.durationSeconds = audioDuration(data, ext);
    if (info.durationSeconds > MAX_AUDIO_SECONDS) {
      throw new Error(`Audio is ${info.durationSeconds.toFixed(1)} s long; Roblox allows up to 7 minutes (${MAX_AUDIO_SECONDS} s).`);
    }
  } else {
    const { width, height } = imageSize(data, ext);
    info.width = width;
    info.height = height;
    if (width >= MAX_IMAGE_SIDE || height >= MAX_IMAGE_SIDE) {
      throw new Error(`Image is ${width}x${height}; Roblox requires it to be smaller than ${MAX_IMAGE_SIDE}x${MAX_IMAGE_SIDE}.`);
    }
  }
  return info;
}

// ------------------------------------------------------------------ audio

function audioDuration(b: Buffer, ext: string): number {
  switch (ext) {
    case ".wav":
      return wavDuration(b);
    case ".flac":
      return flacDuration(b);
    case ".ogg":
      return oggDuration(b);
    default:
      return mp3Duration(b);
  }
}

function tag(b: Buffer, at: number, s: string) {
  return b.length >= at + s.length && b.toString("latin1", at, at + s.length) === s;
}

function wavDuration(b: Buffer): number {
  if (!tag(b, 0, "RIFF") || !tag(b, 8, "WAVE")) throw new Error("File is not a valid WAV.");
  let byteRate = 0;
  let pos = 12;
  while (pos + 8 <= b.length) {
    const size = b.readUInt32LE(pos + 4);
    if (tag(b, pos, "fmt ") && pos + 20 <= b.length) byteRate = b.readUInt32LE(pos + 16);
    if (tag(b, pos, "data")) {
      if (!byteRate) break;
      // streaming writers leave 0 or 0xFFFFFFFF here: fall back to the bytes present
      const available = b.length - pos - 8;
      const bytes = size === 0 || size > available ? available : size;
      return bytes / byteRate;
    }
    pos += 8 + size + (size % 2);
  }
  throw new Error("Could not determine the duration of this WAV.");
}

function flacDuration(b: Buffer): number {
  if (!tag(b, 0, "fLaC") || b.length < 26) throw new Error("File is not a valid FLAC.");
  const rate = (b[18] << 12) | (b[19] << 4) | (b[20] >> 4);
  const samples = (b[21] & 0x0f) * 2 ** 32 + b.readUInt32BE(22);
  if (!rate || !samples) throw new Error("Could not determine the duration of this FLAC (its header has no sample count).");
  return samples / rate;
}

function oggDuration(b: Buffer): number {
  if (!tag(b, 0, "OggS") || b.length < 28) throw new Error("File is not a valid Ogg.");
  const serial = b.readUInt32LE(14);
  const packet = 27 + b[26];
  let rate: number;
  let preSkip = 0;
  if (tag(b, packet, "\x01vorbis") && b.length >= packet + 16) {
    rate = b.readUInt32LE(packet + 12);
  } else if (tag(b, packet, "OpusHead") && b.length >= packet + 12) {
    rate = 48000; // Opus granule positions are always in 48 kHz units
    preSkip = b.readUInt16LE(packet + 10);
  } else {
    throw new Error("File is not a valid Ogg Vorbis/Opus stream.");
  }
  for (let pos = b.length - 27; pos >= 0; pos--) {
    if (b[pos] !== 0x4f || !tag(b, pos, "OggS") || b.readUInt32LE(pos + 14) !== serial) continue;
    const granule = b.readBigUInt64LE(pos + 6);
    if (granule === 0xffffffffffffffffn) continue; // page where no packet finishes
    if (rate > 0 && granule > 0n) return (Number(granule) - preSkip) / rate;
    break;
  }
  throw new Error("Could not determine the duration of this Ogg file.");
}

const MPEG1_BITRATES = [
  [],
  [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448], // layer I
  [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384], // layer II
  [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320], // layer III
];
const MPEG2_BITRATES = [
  [],
  [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
  [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
  [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
];
const SAMPLE_RATES: Record<number, number[]> = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };

/** Frame length and sample count at `p`, or undefined if no valid header is there. */
function mp3Frame(b: Buffer, p: number): { bytes: number; samples: number; rate: number } | undefined {
  if (p + 4 > b.length || b[p] !== 0xff || (b[p + 1] & 0xe0) !== 0xe0) return undefined;
  const version = (b[p + 1] >> 3) & 3;
  const layer = 4 - ((b[p + 1] >> 1) & 3);
  const brIndex = b[p + 2] >> 4;
  const srIndex = (b[p + 2] >> 2) & 3;
  if (version === 1 || layer === 4 || brIndex === 0 || brIndex === 15 || srIndex === 3) return undefined;
  const kbps = (version === 3 ? MPEG1_BITRATES : MPEG2_BITRATES)[layer][brIndex];
  const rate = SAMPLE_RATES[version][srIndex];
  const padding = (b[p + 2] >> 1) & 1;
  if (layer === 1) return { bytes: (Math.floor((12000 * kbps) / rate) + padding) * 4, samples: 384, rate };
  const samples = layer === 3 && version !== 3 ? 576 : 1152;
  return { bytes: Math.floor(((samples / 8) * 1000 * kbps) / rate) + padding, samples, rate };
}

function mp3Duration(b: Buffer): number {
  let pos = 0;
  if (tag(b, 0, "ID3") && b.length >= 10) pos = 10 + ((b[6] << 21) | (b[7] << 14) | (b[8] << 7) | b[9]);
  let seconds = 0;
  let frames = 0;
  while (pos < b.length) {
    const f = mp3Frame(b, pos);
    // a real frame is followed by another frame or by the end of the file
    if (f && (pos + f.bytes >= b.length || mp3Frame(b, pos + f.bytes))) {
      seconds += f.samples / f.rate;
      frames++;
      pos += f.bytes;
    } else {
      pos++; // junk between frames, or a trailing ID3v1 tag
    }
  }
  if (!frames) throw new Error("File is not a valid MP3.");
  return seconds;
}

// ------------------------------------------------------------------ images

function imageSize(b: Buffer, ext: string): { width: number; height: number } {
  switch (ext) {
    case ".png":
      if (b.length < 24 || b.toString("latin1", 1, 4) !== "PNG" || !tag(b, 12, "IHDR")) throw new Error("File is not a valid PNG.");
      return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
    case ".bmp":
      if (b.length < 26 || !tag(b, 0, "BM")) throw new Error("File is not a valid BMP.");
      return { width: Math.abs(b.readInt32LE(18)), height: Math.abs(b.readInt32LE(22)) };
    case ".tga":
      if (b.length < 18 || ![1, 2, 3, 9, 10, 11].includes(b[2]) || ![8, 15, 16, 24, 32].includes(b[16])) throw new Error("File is not a valid TGA.");
      return { width: b.readUInt16LE(12), height: b.readUInt16LE(14) };
    default:
      return jpegSize(b);
  }
}

function jpegSize(b: Buffer): { width: number; height: number } {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) throw new Error("File is not a valid JPEG.");
  let pos = 2;
  while (pos + 9 <= b.length) {
    if (b[pos] !== 0xff) throw new Error("File is not a valid JPEG.");
    const marker = b[pos + 1];
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { width: b.readUInt16BE(pos + 7), height: b.readUInt16BE(pos + 5) };
    }
    pos += 2 + b.readUInt16BE(pos + 2);
  }
  throw new Error("Could not read the dimensions of this JPEG.");
}
