// The native OS confirmation. Nothing here opens a window: child processes are
// faked, and the one test that runs real PowerShell never calls ShowDialog.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn as realSpawn } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { MAC_SCRIPT, WINDOWS_SCRIPT, DialogUnavailableError, cleanLine, cleanText, createNativeConfirm } from "../dist/nativeconfirm.js";
import { setup, tmpDir, writeFile } from "./helpers.mjs";

const REQ = { title: "Publish?", text: "Target: 22", confirmLabel: "Publish now", timeoutMs: 5000 };
const WIN_ENV = { SystemRoot: "C:\\Windows" };
const HOSTILE = [
  `'; Remove-Item C:\\x; '`,
  `"; calc; "`,
  "$(calc.exe)",
  "`calc`",
  "${env:X}",
  "line1\nline2\r\nline3",
  "@(1) | calc & calc",
  "%PATH%",
  "--title=evil",
  "<b>bold</b>\\n",
].join(" ");

function fakeSpawn(behave) {
  const calls = [];
  const spawn = (file, args, options) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    const call = { file, args, options, stdin: "", killed: false };
    child.stdin = Object.assign(new EventEmitter(), { end: (d) => (call.stdin += d ?? "") });
    child.kill = () => {
      call.killed = true;
      return true;
    };
    calls.push(call);
    setImmediate(() => behave(child, call));
    return child;
  };
  return { spawn, calls };
}
const exits = (out, code) => (child) => {
  if (out) child.stdout.emit("data", Buffer.from(out));
  child.emit("close", code);
};
const win = (behave, extra = {}) => {
  const f = fakeSpawn(behave);
  return { ...f, confirm: createNativeConfirm({ platform: "win32", spawn: f.spawn, env: WIN_ENV, ...extra }) };
};

// ------------------------------------------------------------------ what is displayed

test("cleanLine drops control, bidi and zero-width characters and flattens line breaks", () => {
  assert.equal(cleanLine("a\nb\r\tc\u202Ed\u2066e\u200Bf\u0000g\u0085h\u2028i\uFEFFj", 100), "a b cdefghij");
});

test("cleanLine caps by characters without splitting a surrogate pair", () => {
  assert.equal(cleanLine("x".repeat(50), 10), `${"x".repeat(9)}…`);
  const capped = cleanLine("😀".repeat(50), 10);
  assert.equal(Array.from(capped).length, 10);
  assert.doesNotMatch(capped, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
});

test("cleanText keeps our paragraph breaks but limits blank lines, lines and length", () => {
  assert.equal(cleanText("one\r\ntwo\n\n\n\nthree\u202E"), "one\ntwo\n\nthree");
  assert.ok(cleanText("x\n".repeat(500)).split("\n").length <= 41);
  assert.ok(Array.from(cleanText("y".repeat(9000))).length <= 2000);
});

// ------------------------------------------------------------------ answers

test("Yes: only the exact token with exit code 0 confirms", async () => {
  assert.equal((await win(exits("RL-YES", 0)).confirm(REQ)).confirmed, true);
});

for (const [name, out, code] of [
  ["No button", "RL-NO", 1],
  ["window closed", "RL-NO", 1],
  ["script timer", "RL-TIMEOUT", 2],
  ["script error", "", 3],
  ["yes token with a failing exit code", "RL-YES", 1],
  ["exit 0 without the token", "", 0],
  ["exit 0 with other output", "RL-YES and more", 0],
  ["killed by a signal", "RL-YES", null],
]) {
  test(`anything else is No: ${name}`, async () => {
    assert.equal((await win(exits(out, code)).confirm(REQ)).confirmed, false);
  });
}

test("timeout: a dialog that never answers is killed and counts as No", async () => {
  const { confirm, calls } = win(() => {}, { killGraceMs: 5 });
  const r = await confirm({ ...REQ, timeoutMs: 10 });
  assert.equal(r.confirmed, false);
  assert.match(r.reason, /timed out/i);
  assert.equal(calls[0].killed, true);
});

test("the script's own timer is reported as a timeout", async () => {
  assert.match((await win(exits("RL-TIMEOUT", 2)).confirm(REQ)).reason, /timed out/i);
});

test("spawn error event means No, with the reason", async () => {
  const r = await win((child) => child.emit("error", new Error("ENOENT powershell"))).confirm(REQ);
  assert.equal(r.confirmed, false);
  assert.match(r.reason, /ENOENT/);
});

test("spawn throwing synchronously means No", async () => {
  const confirm = createNativeConfirm({ platform: "win32", env: WIN_ENV, spawn: () => { throw new Error("boom"); } });
  const r = await confirm(REQ);
  assert.equal(r.confirmed, false);
  assert.match(r.reason, /boom/);
});

test("a broken stdin pipe does not crash and means No", async () => {
  const r = await win((child) => {
    child.stdin.emit("error", new Error("EPIPE"));
    child.emit("close", 3);
  }).confirm(REQ);
  assert.equal(r.confirmed, false);
});

test("a late Yes after the timeout does not change the answer", async () => {
  let late;
  const { confirm } = win((child) => { late = child; }, { killGraceMs: 5 });
  const r = await confirm({ ...REQ, timeoutMs: 10 });
  // under load the 15 ms timer can beat the fake spawn's setImmediate
  while (!late) await new Promise((res) => setImmediate(res));
  exits("RL-YES", 0)(late);
  assert.equal(r.confirmed, false);
});

test("a second dialog while one is open is refused without spawning", async () => {
  let first;
  const { confirm, calls } = win((child) => { first = child; });
  const pending = confirm(REQ);
  const second = await confirm(REQ);
  assert.equal(second.confirmed, false);
  assert.match(second.reason, /already open/i);
  assert.equal(calls.length, 1);
  await new Promise((r) => setImmediate(r));
  exits("RL-NO", 1)(first);
  assert.equal((await pending).confirmed, false);
});

// ------------------------------------------------------------------ Windows spawn

test("Windows: fixed absolute powershell.exe, no shell, secrets kept out of its environment", async () => {
  const { confirm, calls } = win(exits("RL-NO", 1), { env: { ...WIN_ENV, ROBLOX_PUBLISH_API_KEY: "s3cret", ACRCLOUD_ACCESS_SECRET: "x", AUDD_API_TOKEN: "y" } });
  await confirm(REQ);
  const c = calls[0];
  assert.equal(c.file, "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
  assert.ok(!c.options.shell);
  // windowsHide also hides the form: the process starts with SW_HIDE and the form's first show uses it
  assert.equal(c.options.windowsHide, false);
  assert.equal(c.options.env.SystemRoot, "C:\\Windows");
  for (const k of ["ROBLOX_PUBLISH_API_KEY", "ACRCLOUD_ACCESS_SECRET", "AUDD_API_TOKEN"]) assert.equal(c.options.env[k], undefined, k);
});

test("Windows: hostile text cannot alter the spawned script or its command line", async () => {
  const { confirm, calls } = win(exits("RL-NO", 1));
  await confirm({ title: HOSTILE, text: HOSTILE, confirmLabel: HOSTILE, timeoutMs: 5000 });
  assert.deepEqual(calls[0].args, ["-NoProfile", "-NonInteractive", "-STA", "-WindowStyle", "Hidden", "-Command", WINDOWS_SCRIPT]);
  assert.match(calls[0].stdin, /^[A-Za-z0-9+/=]+$/, "stdin is plain base64");
});

test("Windows: the data on stdin decodes to exactly the cleaned request", async () => {
  const { confirm, calls } = win(exits("RL-NO", 1));
  await confirm({ title: "Т\u202Eitle", text: `Ключ\n\n"$(x)"`, confirmLabel: "Да", timeoutMs: 4000 });
  assert.deepEqual(JSON.parse(Buffer.from(calls[0].stdin, "base64").toString("utf8")), { title: "Тitle", text: `Ключ\n\n"$(x)"`, confirmLabel: "Да", timeoutMs: 4000 });
});

test("Windows script: default No, always on top, no double quotes to mis-escape", () => {
  assert.ok(!WINDOWS_SCRIPT.includes('"'));
  assert.match(WINDOWS_SCRIPT, /\.TopMost = \$true/);
  assert.match(WINDOWS_SCRIPT, /\.AcceptButton = \$no/);
  assert.match(WINDOWS_SCRIPT, /\.CancelButton = \$no/);
  assert.match(WINDOWS_SCRIPT, /\.ActiveControl = \$no/);
});

test("Windows, real PowerShell: hostile text round-trips as data and runs nothing", { skip: process.platform !== "win32" }, async () => {
  const dir = tmpDir();
  const canary = path.join(dir, "canary.txt");
  const evil = `'; Set-Content -LiteralPath '${canary}' x; ' "; Set-Content -LiteralPath '${canary}' x; " $(Set-Content -LiteralPath '${canary}' x) \`n ${"${env:TEMP}"} Ключ`;
  // the same script, with the one line that shows the window swapped for a report
  const show = "$result = $form.ShowDialog()";
  assert.ok(WINDOWS_SCRIPT.includes(show));
  const script = WINDOWS_SCRIPT.replace(show, () => "[Console]::Out.Write([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($form.Text + [char]31 + $box.Text + [char]31 + $yes.Text + [char]31 + $form.TopMost + [char]31 + $form.AcceptButton.Text)) + ' '); $result = [System.Windows.Forms.DialogResult]::No");
  const payload = { title: evil, text: `${evil}\nsecond`, confirmLabel: evil, timeoutMs: 1000 };
  const { out, code } = await new Promise((resolve, reject) => {
    const child = realSpawn(path.join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), ["-NoProfile", "-NonInteractive", "-STA", "-Command", script], { windowsHide: true });
    let o = "";
    child.stdout.on("data", (d) => (o += d));
    child.on("error", reject);
    child.on("close", (c) => resolve({ out: o, code: c }));
    child.stdin.end(Buffer.from(JSON.stringify(payload), "utf8").toString("base64"));
  });
  const [b64, token] = out.trim().split(" ");
  assert.equal(token, "RL-NO");
  assert.equal(code, 1);
  const [title, text, label, top, accept] = Buffer.from(b64, "base64").toString("utf8").split("\u001f");
  assert.equal(title, evil);
  assert.equal(text, `${evil}\r\nsecond`);
  assert.equal(label, evil);
  assert.equal(top, "True");
  assert.equal(accept, "No");
  assert.equal(fs.existsSync(canary), false, "nothing in the text was executed");
});

// ------------------------------------------------------------------ macOS and Linux

test("macOS: osascript gets the text only as arguments after a fixed script", async () => {
  const f = fakeSpawn(exits("RL-NO", 0));
  const confirm = createNativeConfirm({ platform: "darwin", spawn: f.spawn, env: {} });
  await confirm({ title: HOSTILE, text: "plain", confirmLabel: "Go", timeoutMs: 5000 });
  const c = f.calls[0];
  assert.equal(c.file, "/usr/bin/osascript");
  assert.deepEqual(c.args, ["-e", MAC_SCRIPT, cleanLine(HOSTILE, 120), "plain", "Go", "5"]);
  assert.ok(!c.options.shell);
  assert.ok(!MAC_SCRIPT.includes(HOSTILE));
});

test("macOS: only the script's yes token confirms", async () => {
  const run = async (out, code) => (await createNativeConfirm({ platform: "darwin", spawn: fakeSpawn(exits(out, code)).spawn, env: {} })(REQ)).confirmed;
  assert.equal(await run("RL-YES\n", 0), true);
  assert.equal(await run("RL-NO\n", 0), false);
  assert.equal(await run("RL-TIMEOUT\n", 0), false);
  assert.equal(await run("", 1), false);
});

test("Linux: zenity gets each value as one argument, markup off, Cancel as the default", async () => {
  const f = fakeSpawn(exits("", 1));
  const confirm = createNativeConfirm({ platform: "linux", spawn: f.spawn, env: {}, exists: (p) => p === "/usr/bin/zenity" });
  await confirm({ title: "T", text: HOSTILE, confirmLabel: "Go", timeoutMs: 5000 });
  const c = f.calls[0];
  assert.equal(c.file, "/usr/bin/zenity");
  assert.equal(c.args[0], "--question");
  for (const a of ["--no-markup", "--default-cancel", "--timeout=5", "--ok-label=Go", "--cancel-label=No", "--title=T"]) assert.ok(c.args.includes(a), a);
  const textArg = c.args.filter((a) => a.startsWith("--text="));
  assert.equal(textArg.length, 1);
  assert.equal(c.args.length, 9, "the hostile --title=evil stayed inside --text");
  assert.ok(!textArg[0].includes("\\"), "backslash escapes cannot be interpreted");
});

test("Linux: zenity exit codes", async () => {
  const run = async (code) => createNativeConfirm({ platform: "linux", spawn: fakeSpawn(exits("", code)).spawn, env: {}, exists: (p) => p === "/usr/bin/zenity" })(REQ);
  assert.equal((await run(0)).confirmed, true);
  assert.equal((await run(1)).confirmed, false);
  assert.match((await run(5)).reason, /timed out/i);
  assert.equal((await run(255)).confirmed, false);
});

test("Linux: kdialog is the fallback, with No as default and rich text neutralised", async () => {
  const f = fakeSpawn(exits("", 0));
  const confirm = createNativeConfirm({ platform: "linux", spawn: f.spawn, env: {}, exists: (p) => p === "/usr/bin/kdialog" });
  assert.equal((await confirm({ ...REQ, text: "-x <img src=a> \\n" })).confirmed, true);
  const c = f.calls[0];
  assert.equal(c.file, "/usr/bin/kdialog");
  assert.ok(c.args.includes("--warningyesno"));
  const text = c.args[c.args.indexOf("--warningyesno") + 1];
  assert.ok(!text.startsWith("-"));
  assert.ok(!text.includes("<") && !text.includes("\\"));
});

test("no dialog tool: refused with a clear error, nothing spawned", async () => {
  const f = fakeSpawn(exits("RL-YES", 0));
  const none = createNativeConfirm({ platform: "linux", spawn: f.spawn, env: { PATH: "/usr/bin" }, exists: () => false });
  await assert.rejects(none(REQ), (e) => e instanceof DialogUnavailableError && /zenity|kdialog/.test(e.message));
  const odd = createNativeConfirm({ platform: "aix", spawn: f.spawn, env: {} });
  await assert.rejects(odd(REQ), DialogUnavailableError);
  assert.equal(f.calls.length, 0);
});

test("Linux: a relative PATH entry is not searched", async () => {
  const seen = [];
  const confirm = createNativeConfirm({ platform: "linux", spawn: fakeSpawn(exits("", 1)).spawn, env: { PATH: `.:bin:/opt/x` }, exists: (p) => (seen.push(p), false) });
  await assert.rejects(confirm(REQ), DialogUnavailableError);
  assert.ok(seen.includes("/opt/x/zenity"));
  assert.ok(!seen.some((p) => !p.startsWith("/")), seen.join());
});

// ------------------------------------------------------------------ the four gated tools

const RBXL = Buffer.from("<roblox!\x89\xff\r\n\x1a\ndata", "latin1");
const seed = (ctx) => ctx.cloud.entries.set("Coins/-/p1", { id: "p1", state: "ACTIVE", revisionId: "r1", value: 1 });
const GATED = {
  place_publish: {
    run: (ctx) => ctx.app.publisher.placePublish({ universeId: 11, placeId: 22, file: writeFile(ctx.dir, "p.rbxl", RBXL) }),
    effects: (ctx) => ctx.cloud.placeUploads.length,
  },
  server_restart: { run: (ctx) => ctx.app.tools.serverRestart({ universeId: 9 }), effects: (ctx) => ctx.cloud.restarts.length },
  datastore_set: {
    run: (ctx) => (seed(ctx), ctx.app.tools.datastoreSet({ universeId: 9, store: "Coins", key: "p1", value: 2 })),
    effects: (ctx) => ctx.cloud.patches.length,
  },
  datastore_delete: {
    run: (ctx) => (seed(ctx), ctx.app.tools.datastoreDelete({ universeId: 9, store: "Coins", key: "p1" })),
    effects: (ctx) => ctx.cloud.deletes.length,
  },
};
const NOT_YES = [
  ["declined", { confirmed: false }],
  ["timed out", { confirmed: false, reason: "timed out" }],
  ['the string "yes"', { confirmed: "yes" }],
  ["a truthy number", { confirmed: 1 }],
  ["a bare true", true],
  ["null", null],
  ["undefined", undefined],
  ["an empty object", {}],
];

for (const [tool, { run, effects }] of Object.entries(GATED)) {
  test(`${tool}: acts on Yes, without Studio or any RPC`, async (t) => {
    const ctx = await setup(t, { rolink: { online: false } });
    await run(ctx);
    assert.equal(effects(ctx), 1);
    assert.equal(ctx.dialogs.length, 1);
    assert.equal(ctx.dialogs[0].timeoutMs > 0, true);
    assert.ok(ctx.dialogs[0].confirmLabel);
    assert.equal(ctx.rl.calls.length, 0, "the gate never goes through RoLink");
  });

  for (const [name, answer] of NOT_YES) {
    test(`${tool}: ${name} does nothing`, async (t) => {
      const ctx = await setup(t);
      ctx.dialog = answer;
      await assert.rejects(run(ctx), /not confirmed/i);
      assert.equal(effects(ctx), 0);
    });
  }

  test(`${tool}: a dialog that throws does nothing`, async (t) => {
    const ctx = await setup(t);
    ctx.dialog = () => {
      throw new DialogUnavailableError("no dialog tool");
    };
    await assert.rejects(run(ctx), /refused.*no dialog tool/i);
    assert.equal(effects(ctx), 0);
  });

  for (const [name, out, code, wanted] of [["Yes", "RL-YES", 0, 1], ["No", "RL-NO", 1, 0], ["timeout", "RL-TIMEOUT", 2, 0], ["failure", "", 3, 0]]) {
    test(`${tool}: real nativeConfirm over a faked process, ${name}`, async (t) => {
      const f = fakeSpawn(exits(out, code));
      const ctx = await setup(t, { nativeConfirm: createNativeConfirm({ platform: "win32", spawn: f.spawn, env: WIN_ENV }) });
      if (wanted) await run(ctx);
      else await assert.rejects(run(ctx), /not confirmed/i);
      assert.equal(f.calls.length, 1);
      assert.equal(effects(ctx), wanted);
    });
  }

  test(`${tool}: spawn failure does nothing`, async (t) => {
    const f = fakeSpawn((child) => child.emit("error", new Error("ENOENT")));
    const ctx = await setup(t, { nativeConfirm: createNativeConfirm({ platform: "win32", spawn: f.spawn, env: WIN_ENV }) });
    await assert.rejects(run(ctx), /not confirmed.*ENOENT/i);
    assert.equal(effects(ctx), 0);
  });
}

test("place_save never shows a dialog", async (t) => {
  const ctx = await setup(t);
  await ctx.app.publisher.placeSave({ universeId: 11, placeId: 22, file: writeFile(ctx.dir, "p.rbxl", RBXL) });
  assert.equal(ctx.dialogs.length, 0);
  assert.equal(ctx.cloud.placeUploads.length, 1);
});

test("the place dialog names universe, place and file, and warns about live players", async (t) => {
  const ctx = await setup(t);
  await GATED.place_publish.run(ctx);
  const { text } = ctx.dialogs[0];
  assert.match(text, /\b11\b/);
  assert.match(text, /\b22\b/);
  assert.match(text, /p\.rbxl/);
  assert.match(text, /already public/i);
  assert.match(text, /players at once/i);
});

test("an over-long key cannot push the value and warnings out of the dialog", async (t) => {
  const ctx = await setup(t);
  const key = "k".repeat(5000);
  ctx.cloud.entries.set(`Coins/-/${key}`, { id: key, state: "ACTIVE", revisionId: "r1", value: 1 });
  await ctx.app.tools.datastoreSet({ universeId: 9, store: "Coins", key, value: { gold: 6 } });
  assert.ok(ctx.dialogs[0].text.length < 1500, `dialog is ${ctx.dialogs[0].text.length} chars`);
  assert.match(ctx.dialogs[0].text, /"gold":6/);
});

test("a file name with line breaks stays on one line in the dialog", { skip: process.platform === "win32" }, async (t) => {
  const ctx = await setup(t);
  await ctx.app.publisher.placePublish({ universeId: 11, placeId: 22, file: writeFile(ctx.dir, "a\n\nPress Publish.rbxl", RBXL) });
  assert.doesNotMatch(ctx.dialogs[0].text, /a\n/);
});

test("the API key is scrubbed from dialog text", async (t) => {
  const ctx = await setup(t);
  seed(ctx);
  await ctx.app.tools.datastoreSet({ universeId: 9, store: "Coins", key: "p1", value: "SECRET-OPEN-CLOUD-KEY-abc123" });
  assert.ok(!ctx.dialogs[0].text.includes("SECRET-OPEN-CLOUD-KEY"));
});
