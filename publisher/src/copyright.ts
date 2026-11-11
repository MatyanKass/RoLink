// Optional copyright lookup. A provider only knows what is in its database, so
// a miss is reported as "no match found", never as "this is free to use".

import crypto from "node:crypto";
import type { Log, Redactor } from "./config.js";

export type CopyrightHit = { kind: "no_match" } | { kind: "match"; title: string; artist: string };

export interface CopyrightProvider {
  name: string;
  /** Longest sample the service accepts; bigger files are checked from the start. */
  maxBytes: number;
  check(data: Buffer, fileName: string): Promise<CopyrightHit>;
}

export interface CopyrightResult {
  status: "not_run" | "no_match" | "match" | "error";
  provider?: string;
  title?: string;
  artist?: string;
  partial?: boolean;
  checkedBytes?: number;
  errors?: string[];
}

type Fetch = typeof fetch;

/** https://docs.audd.io/ : standard endpoint, 10 MB per file. */
export class AuddProvider implements CopyrightProvider {
  readonly name = "AudD";
  readonly maxBytes = 10 * 1000 * 1000;

  constructor(private token: string, private fetchImpl: Fetch) {}

  async check(data: Buffer, fileName: string): Promise<CopyrightHit> {
    const form = new FormData();
    form.append("api_token", this.token);
    form.append("file", new Blob([new Uint8Array(data)]), fileName);
    const r = await this.fetchImpl("https://api.audd.io/", { method: "POST", body: form, signal: AbortSignal.timeout(90_000) });
    const body: any = await r.json().catch(() => ({}));
    if (body.status !== "success") throw new Error(`AudD error: ${body.error?.error_message ?? `HTTP ${r.status}`}`);
    if (!body.result || !body.result.title) return { kind: "no_match" };
    return { kind: "match", title: String(body.result.title), artist: String(body.result.artist ?? "unknown artist") };
  }
}

/** https://docs.acrcloud.com/reference/identification-api/identification-api */
export class AcrCloudProvider implements CopyrightProvider {
  readonly name = "ACRCloud";
  readonly maxBytes = 4_900_000; // the docs: "below 5M Bytes"

  constructor(private host: string, private accessKey: string, private secret: string, private fetchImpl: Fetch) {}

  async check(data: Buffer, fileName: string): Promise<CopyrightHit> {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const toSign = ["POST", "/v1/identify", this.accessKey, "audio", "1", timestamp].join("\n");
    const form = new FormData();
    form.append("sample", new Blob([new Uint8Array(data)]), fileName);
    form.append("access_key", this.accessKey);
    form.append("data_type", "audio");
    form.append("signature_version", "1");
    form.append("signature", crypto.createHmac("sha1", this.secret).update(toSign).digest("base64"));
    form.append("sample_bytes", String(data.length));
    form.append("timestamp", timestamp);
    const r = await this.fetchImpl(`https://${this.host}/v1/identify`, { method: "POST", body: form, signal: AbortSignal.timeout(90_000) });
    const body: any = await r.json().catch(() => ({}));
    const code = body.status?.code;
    if (code === 1001) return { kind: "no_match" };
    if (code !== 0) throw new Error(`ACRCloud error: ${body.status?.msg ?? `HTTP ${r.status}`}`);
    const song = body.metadata?.music?.[0];
    if (!song?.title) return { kind: "no_match" };
    return { kind: "match", title: String(song.title), artist: (song.artists ?? []).map((a: any) => a.name).join(", ") || "unknown artist" };
  }
}

export function providersFromEnv(env: NodeJS.ProcessEnv, fetchImpl: Fetch): CopyrightProvider[] {
  const out: CopyrightProvider[] = [];
  if (env.AUDD_API_TOKEN?.trim()) out.push(new AuddProvider(env.AUDD_API_TOKEN.trim(), fetchImpl));
  const [host, key, secret] = [env.ACRCLOUD_HOST?.trim(), env.ACRCLOUD_ACCESS_KEY?.trim(), env.ACRCLOUD_ACCESS_SECRET?.trim()];
  if (host && key && secret) out.push(new AcrCloudProvider(host, key, secret, fetchImpl));
  return out;
}

/** Provider text ends up in a phrase the user must retype, so it is kept plain. */
export function cleanTitle(raw: string): string {
  // invisible and bidi characters would make the phrase untypeable, or show text other than what must be typed
  const plain = raw.normalize("NFC").replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, " ").replace(/[\p{Cf}\p{Cs}]/gu, "");
  return Array.from(plain.replace(/\s+/g, " ").trim()).slice(0, 120).join("").trim() || "Unknown title";
}

export async function runCopyrightCheck(
  providers: CopyrightProvider[],
  data: Buffer,
  fileName: string,
  redactor: Redactor,
  log: Log,
): Promise<CopyrightResult> {
  if (providers.length === 0) return { status: "not_run" };
  const errors: string[] = [];
  let miss: CopyrightResult | undefined;
  for (const p of providers) {
    const partial = data.length > p.maxBytes;
    const sample = partial ? data.subarray(0, p.maxBytes) : data;
    const coverage = { provider: p.name, partial, checkedBytes: sample.length };
    try {
      const hit = await p.check(sample, fileName);
      if (hit.kind === "match") return { status: "match", ...coverage, title: cleanTitle(hit.title), artist: cleanTitle(hit.artist) };
      miss ??= { status: "no_match", ...coverage };
    } catch (e: any) {
      const message = redactor.text(`${p.name}: ${e?.message ?? e}`);
      errors.push(message);
      log("copyright check failed", message);
    }
  }
  if (miss) return errors.length ? { ...miss, errors } : miss;
  return { status: "error", errors };
}
