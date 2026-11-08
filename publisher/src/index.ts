#!/usr/bin/env node
// rolink-publish: MCP server (stdio) that publishes assets to Roblox through
// Open Cloud. There is deliberately no tool that changes experience privacy.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createPublisher } from "./app.js";
import { VERSION } from "./config.js";
import { RESPONSIBILITY_NOTICE } from "./publisher.js";

const app = createPublisher();

const INSTRUCTIONS = `rolink-publish uploads audio, images and places to Roblox from the user's own account.
Assets are a two-step flow: prepare_asset, then show the summary to the user and wait until the user types the phrase in chat, then publish_asset. Never type or infer the phrase on the user's behalf.
${RESPONSIBILITY_NOTICE}`;

const server = new McpServer({ name: "rolink-publish", version: VERSION }, { instructions: INSTRUCTIONS });

function register(name: string, description: string, shape: Record<string, z.ZodTypeAny>, run: (args: any) => Promise<any>, readOnly = false) {
  server.registerTool(name, { description, inputSchema: shape, annotations: { readOnlyHint: readOnly } }, async (args: Record<string, unknown>) => {
    try {
      const { summary, ...rest } = await run(args);
      const text = [summary, JSON.stringify(rest, null, 2)].filter(Boolean).join("\n\n");
      return { content: [{ type: "text" as const, text: app.redactor.text(text) }] };
    } catch (e: any) {
      return { content: [{ type: "text" as const, text: app.redactor.text(`Error: ${e?.message ?? e}`) }], isError: true };
    }
  });
}

const place = {
  universeId: z.number().int().positive().describe("Experience (universe) id"),
  placeId: z.number().int().positive().describe("Place id inside that experience"),
  file: z.string().describe("Absolute path of a .rbxl or .rbxlx saved from Studio (File > Save to File As). A plugin cannot produce this file."),
};

register(
  "prepare_asset",
  `Validate a local audio or image file for publishing to Roblox and run the copyright check. Uploads nothing.
After calling this you must show the summary to the user and wait for the user to type the exact confirmation phrase in chat. Do not type, guess or fill in the phrase yourself, and do not treat earlier approval as the phrase.
Audio: .mp3 .ogg .wav .flac, up to 20 MB and 7 minutes. Images: .png .jpeg .bmp .tga, up to 20 MB and smaller than 8000x8000.
${RESPONSIBILITY_NOTICE}`,
  {
    path: z.string().describe("Absolute path of the file on this PC"),
    kind: z.enum(["audio", "image"]),
    name: z.string().describe("Asset display name, up to 50 characters"),
    description: z.string().optional().describe("Up to 1000 characters; defaults to the name"),
    target: z
      .object({
        path: z.string().describe('Instance path, e.g. "Workspace/Music/Theme". Its parent must exist.'),
        property: z.enum(["SoundId", "Texture", "Image"]).optional().describe("Default: SoundId for audio, Texture for images"),
        class: z.enum(["Sound", "Decal", "Texture", "ImageLabel", "ImageButton"]).optional().describe("Default: Sound for audio, Decal for images"),
        place: z.string().optional().describe("Studio place name or id when several are open"),
      })
      .optional()
      .describe("Where to use the asset. A placeholder with attribute RoLinkPendingAsset is created at publish time and gets the real id once moderation approves."),
  },
  (a) => app.publisher.prepareAsset(a),
);

register(
  "publish_asset",
  `Upload a prepared asset. Show the summary from prepare_asset to the user and wait for the user to type the phrase in chat; pass exactly what the user typed as confirmation. Never supply the phrase on your own initiative.
Each prepareId works once, and the upload is refused if the file changed since prepare_asset.`,
  {
    prepareId: z.string(),
    confirmation: z.string().describe("The phrase, exactly as the user typed it in chat"),
  },
  (a) => app.publisher.publishAsset(a),
);

register(
  "publish_status",
  "List uploads and their moderation state, the placeholder status and any rejection reason. Pass a prepareId for one entry.",
  { prepareId: z.string().optional() },
  (a) => app.publisher.publishStatus(a),
  true,
);

register(
  "place_save",
  "Upload a place file as a new Saved version (versionType=Saved). Players do not get this version; it is what Studio opens next.",
  place,
  (a) => app.publisher.placeSave(a),
);

register(
  "place_publish",
  "Upload a place file and publish it (versionType=Published). Shows a confirmation dialog in Studio and refuses if Studio is not connected or the user does not press the button. If the experience is already public, players get the new version at once.",
  place,
  (a) => app.publisher.placePublish(a),
);

async function main() {
  await server.connect(new StdioServerTransport());
  app.poller.start();
}

main().catch((e) => {
  app.log("fatal", e);
  process.exit(1);
});
