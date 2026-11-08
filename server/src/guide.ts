// The guide tool: serves docs/guide/<topic>.md, lists the topics and greps them.
//
// `npm run build` copies docs/ into dist/docs (scripts/copy-docs.mjs), so a built
// server needs nothing outside dist/. Running straight from a checkout falls back
// to the repository's docs/ folder.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

/** Reading order of guide() and of search results. A file in docs/guide must be listed here. */
export const TOPIC_ORDER = [
  "overview",
  "install-and-connect",
  "plugin-internals",
  "tools-reference",
  "mirror-basics",
  "mirror-reference",
  "property-types",
  "build-spec",
  "scripts",
  "gui",
  "models-and-parts",
  "unions-csg",
  "meshes-and-import-model",
  "materials-textures-decals",
  "proximity-prompt",
  "click-detector",
  "events-remotes-bindables",
  "sounds",
  "lights-particles-effects",
  "welds-constraints",
  "attributes-tags",
  "terrain",
  "lighting-atmosphere",
  "tween-animation-import",
  "playtest-and-scenarios",
  "output-and-debugging",
  "editor-tools",
  "perf",
  "toolbox-quarantine",
  "publishing-assets",
  "publishing-places-datastores",
  "sync-rojo",
  "security-and-trust",
  "troubleshooting",
  "limits-and-known-gaps",
];

/** Older reference pages, served as they are by their file names. */
export const REFERENCE_PAGES = ["BUILD_FORMAT", "PLAYTEST", "MIRROR_FORMAT", "TOOLBOX", "ANIMATION", "IMPORT_MODEL", "ROBLOX_CAPABILITIES"];

const MAX_RESULTS = 15;
const MAX_SECTION_CHARS = 6000;
const MAX_OUTPUT_CHARS = 60_000;
const MAX_QUERY_CHARS = 200;

const QUICK_REFERENCE = `Quick reference (the topics have the full detail):

build node: {"class":"Model","name":"Tower","primary":"Base","children":[{"name":"Base","size":[8,1,8],"at":[0,0.5,0],"color":"#5A5F66","material":"Concrete"}]}
  at/rot are local to the parent node (rot in degrees). Also repeat {count,step,rotStep}, mirror "x"|["x","z"], span [[a],[b]] with thickness, csg {op,with}, refs {"ref":"./Base"}, any PascalCase property. Topic: build-spec.
playtest_scenario helpers in T: T.player, T.players, T.character, T.teleport, T.wait, T.waitFor, T.assert, T.equal, T.step, T.log, T.set, T.get. Start with playtest_start or multiplayer_test. Topic: playtest-and-scenarios.`;

/** dist/docs when built, the repository's docs/ otherwise. */
export function docsRoot(): string {
  const candidates = [path.join(here, "docs"), path.resolve(here, "..", "..", "docs")];
  for (const c of candidates) if (fs.existsSync(path.join(c, "guide", "overview.md"))) return c;
  throw new Error(`the guide files are missing; looked in ${candidates.join(" and ")}. Run npm run build in server/.`);
}

export interface TopicInfo {
  id: string;
  title: string;
  summary: string;
}

function topicFile(id: string, root: string) {
  return path.join(root, "guide", `${id}.md`);
}

/** First heading and the "> one line" right below it. */
export function parseHeader(markdown: string): { title: string; summary: string } {
  const lines = markdown.split(/\r?\n/);
  const title = (lines[0] ?? "").replace(/^#\s+/, "").trim();
  const quote = lines.slice(1, 5).find((l) => l.startsWith("> "));
  return { title, summary: (quote ?? "").replace(/^>\s+/, "").trim() };
}

export function topicIds(root = docsRoot()): string[] {
  const onDisk = fs.readdirSync(path.join(root, "guide")).filter((f) => f.endsWith(".md")).map((f) => f.slice(0, -3));
  const listed = TOPIC_ORDER.filter((t) => onDisk.includes(t));
  return [...listed, ...onDisk.filter((t) => !TOPIC_ORDER.includes(t)).sort()];
}

export function listTopics(root = docsRoot()): TopicInfo[] {
  return topicIds(root).map((id) => ({ id, ...parseHeader(fs.readFileSync(topicFile(id, root), "utf8")) }));
}

interface Section {
  /** "Heading" or "Heading > Sub-heading" */
  path: string;
  level: number;
  text: string;
}

/** Splits at ## and ### outside code fences. Text before the first ## is a section named after the page. */
export function splitSections(markdown: string, pageTitle: string): Section[] {
  const out: Section[] = [];
  let current: Section = { path: pageTitle, level: 1, text: "" };
  let parent = "";
  let fence: string | null = null;
  for (const line of markdown.split(/\r?\n/)) {
    const f = /^\s*(```+|~~~+)/.exec(line);
    if (f) {
      if (fence === null) fence = f[1][0];
      else if (f[1][0] === fence) fence = null;
    }
    const h = fence === null ? /^(##|###)\s+(.+?)\s*$/.exec(line) : null;
    if (h) {
      out.push(current);
      const level = h[1].length;
      if (level === 2) parent = h[2];
      current = { path: level === 2 ? h[2] : `${parent} > ${h[2]}`, level, text: "" };
    }
    current.text += line + "\n";
  }
  out.push(current);
  return out.filter((s) => s.text.trim());
}

function clip(text: string, max = MAX_SECTION_CHARS) {
  return text.length > max ? `${text.slice(0, max)}\n... (section cut; read the whole topic for the rest)\n` : text;
}

const normaliseId = (s: string) => s.trim().toLowerCase().replace(/\.md$/, "").replace(/[\s_]+/g, "-");

function resolveReference(topic: string): string | undefined {
  const want = normaliseId(topic);
  return REFERENCE_PAGES.find((p) => normaliseId(p) === want);
}

function suggest(topic: string, ids: string[]) {
  const want = normaliseId(topic);
  const words = want.split("-").filter(Boolean);
  const hits = ids.filter((id) => id.includes(want) || want.includes(id) || words.some((w) => w.length >= 3 && id.includes(w)));
  return hits.length ? `Did you mean: ${hits.slice(0, 6).join(", ")}?` : "Call guide() for the list of topics.";
}

function readPage(topic: string, root: string): { id: string; text: string } {
  const ids = topicIds(root);
  const id = normaliseId(topic);
  if (ids.includes(id)) return { id, text: fs.readFileSync(topicFile(id, root), "utf8") };
  const page = resolveReference(topic);
  if (page) return { id: page, text: fs.readFileSync(path.join(root, `${page}.md`), "utf8") };
  throw new Error(`no guide topic "${topic.slice(0, 80)}". ${suggest(topic, ids)}`);
}

export function renderIndex(root = docsRoot()): string {
  const lines = [
    'RoLink guide. guide({topic:"<id>"}) returns one topic, guide({topic:"<id>", section:"<heading text>"}) one section of it, guide({search:"<text>"}) greps every topic and returns the matching sections.',
    "",
    "Topics:",
    ...listTopics(root).map((t) => `- ${t.id}: ${t.summary}`),
    "",
    `Older reference pages, also available as topics: ${REFERENCE_PAGES.join(", ")}.`,
    "",
    QUICK_REFERENCE,
  ];
  return lines.join("\n") + "\n";
}

function renderSection(topic: string, wanted: string, root: string): string {
  const page = readPage(topic, root);
  const { title } = parseHeader(page.text);
  const sections = splitSections(page.text, title);
  const needle = wanted.trim().toLowerCase();
  const hits = sections.filter((s) => s.path.toLowerCase().includes(needle));
  if (!hits.length) {
    const headings = sections.filter((s) => s.level === 2).map((s) => s.path);
    throw new Error(`topic ${page.id} has no section matching "${wanted.slice(0, 80)}". Its sections: ${headings.join("; ")}`);
  }
  // a matched ## section comes with its ### parts
  const parents = new Set(hits.filter((s) => s.level === 2).map((s) => s.path));
  const expanded = sections.filter((s) => hits.includes(s) || (s.level === 3 && parents.has(s.path.split(" > ")[0])));
  return [`Topic ${page.id}, section "${wanted.trim()}":`, "", ...expanded.map((s) => s.text.trimEnd())].join("\n") + "\n";
}

export interface SearchHit {
  topic: string;
  section: string;
  text: string;
  score: number;
}

export function searchGuide(query: string, opts: { topic?: string; root?: string } = {}): { hits: SearchHit[]; total: number } {
  const root = opts.root ?? docsRoot();
  const q = query.trim().toLowerCase();
  const pages = opts.topic ? [readPage(opts.topic, root)] : topicIds(root).map((id) => ({ id, text: fs.readFileSync(topicFile(id, root), "utf8") }));
  const all = pages.flatMap((p) => splitSections(p.text, parseHeader(p.text).title).map((s) => ({ topic: p.id, section: s })));

  const count = (hay: string, needle: string) => (needle ? hay.split(needle).length - 1 : 0);
  const scoreWith = (terms: string[]) => (s: Section) => {
    const body = s.text.toLowerCase();
    if (!terms.every((t) => body.includes(t))) return 0;
    const inHeading = terms.reduce((n, t) => n + count(s.path.toLowerCase(), t), 0);
    return inHeading * 100 + terms.reduce((n, t) => n + count(body, t), 0);
  };
  // the exact phrase first; when that finds nothing, every word somewhere in one section
  let score = scoreWith([q]);
  if (!all.some((a) => score(a.section) > 0) && /\s/.test(q)) score = scoreWith(q.split(/\s+/).filter(Boolean));

  const hits = all
    .map((a) => ({ topic: a.topic, section: a.section.path, text: a.section.text, score: score(a.section) }))
    .filter((h) => h.score > 0)
    .sort((a, b) => b.score - a.score);
  return { hits: hits.slice(0, MAX_RESULTS), total: hits.length };
}

function renderSearch(query: string, topic: string | undefined, root: string): string {
  const { hits, total } = searchGuide(query, { topic, root });
  if (!hits.length) return `No section of the guide matches "${query.trim()}". Try a shorter or different word, or call guide() for the list of topics.\n`;
  const parts = [`${total} section(s) match "${query.trim()}"${total > hits.length ? `; showing the best ${hits.length}, narrow the search for the rest` : ""}.`];
  let size = parts[0].length;
  for (const h of hits) {
    const block = `--- ${h.topic} > ${h.section}\n${clip(h.text).trimEnd()}`;
    if (size + block.length > MAX_OUTPUT_CHARS) {
      parts.push("... (output limit reached; narrow the search)");
      break;
    }
    parts.push(block);
    size += block.length;
  }
  return parts.join("\n\n") + "\n";
}

export interface GuideArgs {
  topic?: string;
  section?: string;
  search?: string;
}

/** Text of a guide call; throws a readable Error for a bad topic or section. */
export function guideText(args: GuideArgs = {}, root = docsRoot()): string {
  const search = args.search?.trim();
  if (search) {
    if (search.length > MAX_QUERY_CHARS) throw new Error(`search is longer than ${MAX_QUERY_CHARS} characters`);
    return renderSearch(search, args.topic, root);
  }
  if (args.section?.trim()) {
    if (!args.topic) throw new Error("section needs a topic");
    return renderSection(args.topic, args.section, root);
  }
  if (args.topic?.trim()) return readPage(args.topic, root).text;
  return renderIndex(root);
}
