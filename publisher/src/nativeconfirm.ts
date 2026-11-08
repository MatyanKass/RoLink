// The human gate: a modal window opened by this process, on this computer. It never
// goes through RoLink's /rpc or the Studio plugin, which any local process or agent
// code running in Studio can impersonate.
//
// Everything shown comes from the caller and may be attacker-chosen (file names,
// data store keys and values). It reaches the dialog as data only: on stdin as
// base64 on Windows, as separate process arguments elsewhere. No shell is involved
// and the scripts below are constants.

import { spawn as nodeSpawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { Redactor } from "./config.js";

export interface NativeConfirmRequest {
  title: string;
  text: string;
  confirmLabel: string;
  timeoutMs: number;
}

export interface NativeConfirmAnswer {
  confirmed: boolean;
  reason?: string;
}

export type NativeConfirm = (req: NativeConfirmRequest) => Promise<NativeConfirmAnswer>;

export class DialogUnavailableError extends Error {}

interface ChildLike {
  stdin?: { end(data?: string): unknown; on(ev: string, fn: (...a: any[]) => void): unknown } | null;
  stdout?: { on(ev: string, fn: (d: any) => void): unknown } | null;
  on(ev: string, fn: (...a: any[]) => void): unknown;
  kill(): unknown;
}

export interface NativeConfirmOptions {
  platform?: string;
  spawn?: (file: string, args: string[], options: Record<string, unknown>) => ChildLike;
  env?: NodeJS.ProcessEnv;
  exists?: (file: string) => boolean;
  /** how long past timeoutMs the dialog process may live before it is killed */
  killGraceMs?: number;
}

export const DIALOG_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;
const KILL_GRACE_MS = 5_000;
const MAX_TITLE = 120;
const MAX_LABEL = 40;
const MAX_TEXT = 2000;
const MAX_LINES = 40;
const MAX_OUTPUT = 1024;
const YES = "RL-YES";
const TIMEOUT = "RL-TIMEOUT";

// control, format (bidi, zero-width, tag characters), lone surrogates, line and paragraph separators
const UNSAFE = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/gu;
const UNSAFE_EXCEPT_NEWLINE = /(?!\n)[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/gu;

function cap(s: string, max: number): string {
  const chars = Array.from(s);
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : s;
}

/** A value for a single line: no line breaks, no invisible characters, bounded. */
export function cleanLine(value: unknown, max: number): string {
  return cap(String(value).replace(/[\r\n\t]+/g, " ").replace(UNSAFE, "").trim(), max);
}

/** Dialog body: keeps the line breaks it was built with, drops everything invisible, bounded. */
export function cleanText(value: unknown): string {
  const s = String(value).replace(/\r\n?/g, "\n").replace(/\t/g, " ").replace(UNSAFE_EXCEPT_NEWLINE, "").replace(/\n{3,}/g, "\n\n").trim();
  return cap(s.split("\n").slice(0, MAX_LINES).join("\n"), MAX_TEXT);
}

// No double quotes: nothing here depends on how they are escaped on a command line.
export const WINDOWS_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "try {",
  "  $raw = [Console]::In.ReadToEnd()",
  "  $req = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($raw.Trim())) | ConvertFrom-Json",
  "  Add-Type -AssemblyName System.Windows.Forms",
  "  Add-Type -AssemblyName System.Drawing",
  "  [System.Windows.Forms.Application]::EnableVisualStyles()",
  "  $form = New-Object System.Windows.Forms.Form",
  "  $form.Text = [string]$req.title",
  "  $form.StartPosition = 'CenterScreen'",
  "  $form.ClientSize = New-Object System.Drawing.Size(560, 340)",
  "  $form.FormBorderStyle = 'FixedDialog'",
  "  $form.MinimizeBox = $false",
  "  $form.MaximizeBox = $false",
  "  $form.TopMost = $true",
  "  $box = New-Object System.Windows.Forms.TextBox",
  "  $box.Multiline = $true",
  "  $box.ReadOnly = $true",
  "  $box.TabStop = $false",
  "  $box.ScrollBars = 'Vertical'",
  "  $box.Bounds = New-Object System.Drawing.Rectangle(12, 12, 536, 270)",
  "  $box.Text = ([string]$req.text).Replace([string][char]10, [Environment]::NewLine)",
  "  $yes = New-Object System.Windows.Forms.Button",
  "  $yes.UseMnemonic = $false",
  "  $yes.Text = [string]$req.confirmLabel",
  "  $yes.DialogResult = 'Yes'",
  "  $yes.Bounds = New-Object System.Drawing.Rectangle(12, 294, 200, 34)",
  "  $yes.TabIndex = 1",
  "  $no = New-Object System.Windows.Forms.Button",
  "  $no.Text = 'No'",
  "  $no.DialogResult = 'No'",
  "  $no.Bounds = New-Object System.Drawing.Rectangle(428, 294, 120, 34)",
  "  $no.TabIndex = 0",
  "  $form.Controls.AddRange(@($box, $yes, $no))",
  "  $form.AcceptButton = $no",
  "  $form.CancelButton = $no",
  "  $form.ActiveControl = $no",
  "  $script:timedOut = $false",
  "  $timer = New-Object System.Windows.Forms.Timer",
  "  $timer.Interval = [int]$req.timeoutMs",
  "  $timer.Add_Tick({ $timer.Stop(); $script:timedOut = $true; $form.Close() })",
  "  $form.Add_Shown({ $form.Activate(); [void]$no.Focus(); $timer.Start() })",
  "  $result = $form.ShowDialog()",
  "  $timer.Stop()",
  "  if ($script:timedOut) { [Console]::Out.Write('RL-TIMEOUT'); exit 2 }",
  "  if ($result -eq [System.Windows.Forms.DialogResult]::Yes) { [Console]::Out.Write('RL-YES'); exit 0 }",
  "  [Console]::Out.Write('RL-NO')",
  "  exit 1",
  "} catch {",
  "  exit 3",
  "}",
].join("\n");

export const MAC_SCRIPT = [
  "on run argv",
  "  set theTitle to item 1 of argv",
  "  set theText to item 2 of argv",
  "  set yesLabel to item 3 of argv",
  "  set waitSeconds to (item 4 of argv) as integer",
  '  set answer to display dialog theText with title theTitle buttons {"No", yesLabel} default button "No" cancel button "No" with icon caution giving up after waitSeconds',
  '  if gave up of answer then return "RL-TIMEOUT"',
  '  if button returned of answer is yesLabel then return "RL-YES"',
  '  return "RL-NO"',
  "end run",
].join("\n");

interface Shown {
  title: string;
  text: string;
  confirmLabel: string;
  timeoutMs: number;
}

interface Plan {
  file: string;
  args: string[];
  cwd: string;
  stdin?: string;
  decide(code: number | null, output: string): NativeConfirmAnswer;
}

const DECLINED: NativeConfirmAnswer = { confirmed: false, reason: "declined" };
const TIMED_OUT: NativeConfirmAnswer = { confirmed: false, reason: "timed out" };

function byToken(code: number | null, output: string): NativeConfirmAnswer {
  const out = output.trim();
  if (out === TIMEOUT) return TIMED_OUT;
  if (code === 0 && out === YES) return { confirmed: true };
  if (code === 0 || code === 1) return DECLINED;
  return { confirmed: false, reason: `the dialog failed (exit code ${code})` };
}

function byExitCode(timeoutCode?: number) {
  return (code: number | null): NativeConfirmAnswer => {
    if (code === 0) return { confirmed: true };
    if (timeoutCode !== undefined && code === timeoutCode) return TIMED_OUT;
    if (code === 1 || code === 2) return DECLINED;
    return { confirmed: false, reason: `the dialog failed (exit code ${code})` };
  };
}

/** Option parsers would read a leading dash as a flag. */
const noLeadingDash = (s: string) => (s.startsWith("-") ? ` ${s}` : s);
/** zenity and kdialog expand \n and the like in their text. */
const noEscapes = (s: string) => s.replace(/\\/g, "\u29F5");
/** kdialog auto-detects rich text, and there is no switch to turn that off. */
const noRichText = (s: string) => noEscapes(s).replace(/</g, "\u2039");

function findLinuxTool(name: string, env: NodeJS.ProcessEnv, exists: (f: string) => boolean): string | undefined {
  const dirs = new Set(["/usr/bin", "/bin", "/usr/local/bin", ...(env.PATH ?? "").split(":").filter((d) => d.startsWith("/"))]);
  for (const dir of dirs) {
    const file = path.posix.join(dir, name);
    if (exists(file)) return file;
  }
  return undefined;
}

function planDialog(platform: string, r: Shown, env: NodeJS.ProcessEnv, exists: (f: string) => boolean): Plan {
  const seconds = Math.max(1, Math.ceil(r.timeoutMs / 1000));
  if (platform === "win32") {
    // absolute, so a powershell.exe in the working directory or on PATH is never picked up
    const file = path.win32.join(env.SystemRoot ?? env.windir ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    return {
      file,
      // hides only PowerShell's console; see windowsHide below for why the process itself stays visible
      args: ["-NoProfile", "-NonInteractive", "-STA", "-WindowStyle", "Hidden", "-Command", WINDOWS_SCRIPT],
      cwd: path.win32.dirname(file),
      stdin: Buffer.from(JSON.stringify(r), "utf8").toString("base64"),
      decide: byToken,
    };
  }
  if (platform === "darwin") {
    return { file: "/usr/bin/osascript", args: ["-e", MAC_SCRIPT, noLeadingDash(r.title), r.text, r.confirmLabel, String(seconds)], cwd: "/", decide: byToken };
  }
  if (platform === "linux") {
    const zenity = findLinuxTool("zenity", env, exists);
    if (zenity) {
      return {
        file: zenity,
        args: ["--question", `--title=${r.title}`, `--text=${noEscapes(r.text)}`, `--ok-label=${r.confirmLabel}`, "--cancel-label=No", "--default-cancel", "--no-markup", `--timeout=${seconds}`, "--width=520"],
        cwd: "/",
        decide: byExitCode(5),
      };
    }
    const kdialog = findLinuxTool("kdialog", env, exists);
    if (kdialog) {
      // a warning box is the kdialog form whose default button is No
      return {
        file: kdialog,
        args: ["--title", noLeadingDash(r.title), "--warningyesno", noLeadingDash(noRichText(r.text)), "--yes-label", noLeadingDash(noRichText(r.confirmLabel)), "--no-label", "No"],
        cwd: "/",
        decide: byExitCode(),
      };
    }
    throw new DialogUnavailableError("no confirmation dialog is available: install zenity or kdialog");
  }
  throw new DialogUnavailableError(`no confirmation dialog is available on this platform (${platform})`);
}

function safeEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([k]) => !/KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i.test(k)));
}

function run(plan: Plan, timeoutMs: number, killGraceMs: number, spawn: NonNullable<NativeConfirmOptions["spawn"]>, env: NodeJS.ProcessEnv): Promise<NativeConfirmAnswer> {
  return new Promise((resolve) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (answer: NativeConfirmAnswer) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(answer);
    };
    const failed = (e: any) => finish({ confirmed: false, reason: `could not be shown: ${String(e?.message ?? e)}` });

    let child: ChildLike;
    try {
      child = spawn(plan.file, plan.args, { cwd: plan.cwd, env: safeEnv(env), shell: false, windowsHide: false, stdio: ["pipe", "pipe", "ignore"] });
    } catch (e) {
      failed(e);
      return;
    }
    let output = "";
    child.on("error", failed);
    child.stdout?.on("data", (d) => {
      if (output.length < MAX_OUTPUT) output += String(d);
    });
    child.on("close", (code: number | null) => finish(plan.decide(code, output)));
    child.stdin?.on("error", () => {}); // a process that died early shows up through "close"
    child.stdin?.end(plan.stdin ?? "");
    timer = setTimeout(() => {
      finish(TIMED_OUT);
      try {
        child.kill();
      } catch {}
    }, timeoutMs + killGraceMs);
    timer.unref?.();
  });
}

function normalise(req: NativeConfirmRequest): Shown {
  let confirmLabel = cleanLine(req.confirmLabel, MAX_LABEL) || "Yes";
  // "No" twice would make the buttons ambiguous, and the mac script compares labels
  if (/^no$/i.test(confirmLabel)) confirmLabel = "Yes";
  const t = req.timeoutMs;
  return {
    title: cleanLine(req.title, MAX_TITLE) || "Confirm",
    text: cleanText(req.text),
    confirmLabel,
    timeoutMs: Number.isFinite(t) && t > 0 ? Math.min(Math.floor(t), MAX_TIMEOUT_MS) : DIALOG_TIMEOUT_MS,
  };
}

export function createNativeConfirm(opts: NativeConfirmOptions = {}): NativeConfirm {
  const platform = opts.platform ?? process.platform;
  const spawn = opts.spawn ?? (nodeSpawn as unknown as NonNullable<NativeConfirmOptions["spawn"]>);
  const env = opts.env ?? process.env;
  const exists = opts.exists ?? fs.existsSync;
  const killGraceMs = opts.killGraceMs ?? KILL_GRACE_MS;
  let open = false;
  return async (req) => {
    const shown = normalise(req);
    const plan = planDialog(platform, shown, env, exists);
    // one at a time, so a second window cannot be slid under the user's cursor
    if (open) return { confirmed: false, reason: "another confirmation dialog is already open" };
    open = true;
    try {
      return await run(plan, shown.timeoutMs, killGraceMs, spawn, env);
    } finally {
      open = false;
    }
  };
}

/** Throws unless the user explicitly chose Yes. Returning normally is the only way through. */
export async function requireNativeYes(confirm: NativeConfirm, redactor: Redactor, req: NativeConfirmRequest, nothingDone: string): Promise<void> {
  let answer: NativeConfirmAnswer | undefined;
  try {
    answer = await confirm({ ...req, text: redactor.text(req.text) });
  } catch (e: any) {
    throw new Error(`Refused: the confirmation dialog could not be shown (${redactor.text(String(e?.message ?? e))}). ${nothingDone}`);
  }
  if (answer?.confirmed !== true) {
    const reason = answer?.reason ? ` (${redactor.text(String(answer.reason))})` : "";
    throw new Error(`Not confirmed: the dialog on this computer was declined, closed or timed out${reason}. ${nothingDone}`);
  }
}
