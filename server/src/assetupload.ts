// Roblox Open Cloud Assets API upload (persistent "upload" import mode).
// Config (env of the RoLink server process):
//   ROBLOX_API_KEY            Open Cloud key with asset:read + asset:write
//   ROBLOX_CREATOR_USER_ID    or ROBLOX_CREATOR_GROUP_ID
// The key is only ever sent in the x-api-key header; never logged or returned.

import fsp from "node:fs/promises";
import path from "node:path";
import { checkObjReferences, readGltf } from "./meshimport.js";

const API = "https://apis.roblox.com/assets/v1";

export interface UploadConfig {
  apiKey: string;
  userId?: string;
  groupId?: string;
}

export function uploadConfig(env: NodeJS.ProcessEnv = process.env): UploadConfig | undefined {
  const apiKey = env.ROBLOX_API_KEY?.trim();
  const userId = env.ROBLOX_CREATOR_USER_ID?.trim();
  const groupId = env.ROBLOX_CREATOR_GROUP_ID?.trim();
  if (!apiKey || (!userId && !groupId)) return undefined;
  return { apiKey, userId: userId || undefined, groupId: groupId || undefined };
}

export const CONTENT_TYPES: Record<string, string> = {
  ".fbx": "model/fbx",
  ".glb": "model/gltf-binary",
  ".gltf": "model/gltf+json",
  ".obj": "model/obj",
};

/** Redact anything that looks like the key from an error text. */
function scrub(s: string, cfg: UploadConfig) {
  return cfg.apiKey ? s.split(cfg.apiKey).join("<redacted>") : s;
}

async function readFileForUpload(file: string, ext: string): Promise<{ data: Uint8Array; ext: string }> {
  if (ext === ".gltf") {
    // a .gltf usually references external .bin/.png files: pack into one .glb
    const { doc, io } = await readGltf(file);
    return { data: await io.writeBinary(doc), ext: ".glb" };
  }
  const data = await fsp.readFile(file);
  if (ext === ".obj") checkObjReferences(data.toString("utf8"), file);
  return { data, ext };
}

export async function uploadModel(
  cfg: UploadConfig,
  file: string,
  ext: string,
  displayName: string,
  opts: { timeoutMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<{ assetId: string; operation: string }> {
  const f = opts.fetchImpl ?? fetch;
  const { data, ext: upExt } = await readFileForUpload(file, ext);
  const contentType = CONTENT_TYPES[upExt];
  if (!contentType) throw new Error(`upload does not support ${ext}`);
  const request = {
    assetType: "Model",
    displayName: displayName.slice(0, 50) || "Imported model",
    description: "Imported with RoLink",
    creationContext: { creator: cfg.groupId ? { groupId: cfg.groupId } : { userId: cfg.userId } },
  };
  const form = new FormData();
  form.append("request", JSON.stringify(request));
  form.append("fileContent", new Blob([new Uint8Array(data)], { type: contentType }), path.basename(file, ext) + upExt);
  const r = await f(`${API}/assets`, { method: "POST", headers: { "x-api-key": cfg.apiKey }, body: form });
  const body: any = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(scrub(`Open Cloud upload failed (HTTP ${r.status}): ${body?.message ?? JSON.stringify(body)}`, cfg));
  const operation: string = body.path ?? (body.operationId ? `operations/${body.operationId}` : "");
  if (body.done && body.response?.assetId) return { assetId: String(body.response.assetId), operation };
  if (!operation) throw new Error("Open Cloud upload: no operation path in response");

  const deadline = Date.now() + (opts.timeoutMs ?? 120_000);
  let wait = 1000;
  while (Date.now() < deadline) {
    await new Promise((res) => setTimeout(res, wait));
    wait = Math.min(wait * 1.5, 5000);
    const pr = await f(`${API}/${operation}`, { headers: { "x-api-key": cfg.apiKey } });
    const pb: any = await pr.json().catch(() => ({}));
    if (!pr.ok) throw new Error(scrub(`Open Cloud operation poll failed (HTTP ${pr.status}): ${pb?.message ?? ""}`, cfg));
    if (pb.done) {
      if (pb.error) throw new Error(scrub(`Open Cloud processing failed: ${pb.error.message ?? JSON.stringify(pb.error)}`, cfg));
      const id = pb.response?.assetId;
      if (!id) throw new Error("Open Cloud: operation done without assetId");
      return { assetId: String(id), operation };
    }
  }
  throw new Error(`Open Cloud: asset still processing after timeout (${operation}); try again later`);
}
