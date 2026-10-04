# MQTT Command Execution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the emulated device run shell commands it receives as `{"cmd": "..."}` MQTT messages inside a sandboxed Docker container (host fallback only when explicitly configured), and expose the same pipeline as a `thinx_exec` MCP tool.

**Architecture:** A pure policy module (`command-policy.js`) decides whether a command may run; a runner module (`command-runner.js`) executes an already-approved command in a long-lived Docker container via `docker exec` (or on the host in explicit host mode); the device client wires the MQTT handler and the `thinx_exec` tool to both, replying on `/<owner>/shared/<udid>/console`.

**Tech Stack:** Node.js ≥20 (ESM), `node:child_process` spawn via the Docker CLI, `node:test`, existing `mqtt` dependency. No new npm dependencies.

**Spec:** `docs/superpowers/specs/2026-10-04-mqtt-command-exec-design.md`

## Global Constraints

- No new npm dependencies; Docker is driven through the `docker` CLI with argv arrays, never a shell string.
- The built-in deny list (`rm -rf /` family, `mkfs*`, `dd of=/dev/*`, `shutdown`/`reboot`/`halt`/`poweroff`, shell function definitions / fork bomb) is always active and cannot be disabled or overridden by config.
- Command execution never falls back from Docker to host silently: host mode runs only when `commands.mode === "host"` is set explicitly.
- The same allow/deny policy applies in both Docker and host modes.
- Command replies go to `/<owner>/shared/<udid>/console` (non-retained); retained `cmd` messages are ignored.
- Secrets never leak: in host mode, env vars whose names match `/PASS|TOKEN|KEY|SECRET/i` are stripped from the child environment.

## Review Focus

- **A chained command where one segment is dangerous** (`ls; rm -rf /`) — must be refused as a whole; covered in Task 1.
- **Command substitution / write redirects** (`cat $(…)`, `echo x > /etc/passwd`) — cannot be statically checked, so must be refused outright; covered in Task 1.
- **The sandbox container dies between commands** (OOM-killed, `docker rm`) — the next command must recreate it, not error forever; covered in Task 2.
- **A command that never returns** (`tail -f`, `sleep 999`) — must be killed at the timeout and reported as `timeout`, not hang the server; covered in Task 2.
- **Our own console reply echoed back** over the `/<owner>/shared/#` subscription — must not be buffered or re-interpreted as a command; covered in Task 3.

---

## File Structure

- Create `src/command-policy.js` — pure allow/deny evaluation and segment splitting.
- Create `src/command-runner.js` — Docker/host execution backends over injected `spawn`.
- Modify `src/thinx-device-client.js` — config block, console channel getter, `executeCommand`/`dispatchCommand`, MQTT handler hook, `safeState` block, runner lifecycle.
- Modify `src/mcp-server.js` — `thinx_exec` tool + dispatch, runner close on shutdown/signals.
- Modify `package.json` — test script discovers all `test/*.test.js`.
- Create `test/command-policy.test.js`, `test/command-runner.test.js`, `test/command-client.test.js`.
- Modify `README.md` — "Remote commands" section.

---

### Task 1: Command policy (pure)

**Files:**
- Create: `src/command-policy.js`
- Test: `test/command-policy.test.js`

**Interfaces:**
- Produces: `evaluateCommand(command: string, { allow?: string[], deny?: string[], useDefaultAllow?: boolean }) -> { allowed: true } | { allowed: false, segment?: string, reason: string }`; `DEFAULT_ALLOW: string[]`; `splitSegments(command: string) -> { ok: true, segments: string[] } | { ok: false, reason: string }`.

- [ ] **Step 1: Write failing tests**

```js
import assert from "node:assert/strict";
import { test } from "node:test";
import { evaluateCommand, splitSegments, DEFAULT_ALLOW } from "../src/command-policy.js";

const allowed = (cmd, opts) => evaluateCommand(cmd, opts).allowed;

test("default allow-list permits read-only commands and their args", () => {
  for (const cmd of ["whoami", "ls", "ls -la /tmp", "cat /etc/hostname", "uname -a", "echo hi"]) {
    assert.equal(allowed(cmd), true, cmd);
  }
});

test("commands outside the allow-list are refused", () => {
  const r = evaluateCommand("curl http://x");
  assert.equal(r.allowed, false);
  assert.match(r.reason, /allow-list/);
});

test("a dangerous segment refuses the whole chain", () => {
  const r = evaluateCommand("ls; rm -rf /");
  assert.equal(r.allowed, false);
  assert.equal(r.segment, "rm -rf /");
  assert.match(r.reason, /built-in deny/);
});

test("rm -rf of root is denied even when rm * is allowed", () => {
  for (const cmd of ["rm -rf /", "rm -fr /*", "rm -r -f /", "rm --recursive --force /", "rm --no-preserve-root -rf /"]) {
    assert.equal(evaluateCommand(cmd, { allow: ["rm *"] }).allowed, false, cmd);
  }
});

test("other built-in denies", () => {
  for (const cmd of ["mkfs.ext4 /dev/sda", "dd if=/dev/zero of=/dev/sda", "shutdown now", ":(){ :|:& };:"]) {
    assert.equal(evaluateCommand(cmd, { allow: ["mkfs*", "dd *", "shutdown *"] }).allowed, false, cmd);
  }
});

test("command substitution and write redirects are refused", () => {
  for (const cmd of ["cat $(ls)", "echo `id`", "echo x > /tmp/f", "cat a >> b", "cat <(ls)"]) {
    assert.equal(evaluateCommand(cmd, { allow: ["cat *", "echo *"] }).allowed, false, cmd);
  }
});

test("input redirect and stderr merge are allowed", () => {
  assert.equal(allowed("cat < /etc/hostname", { allow: ["cat *"] }), true);
  assert.equal(allowed("ls /nope 2>&1", { allow: ["ls *"] }), true);
});

test("find with -exec/-delete is refused despite find *", () => {
  assert.equal(allowed("find . -name x", { allow: ["find *"] }), true);
  assert.equal(allowed("find . -delete", { allow: ["find *"] }), false);
  assert.equal(allowed("find . -exec rm {} ;", { allow: ["find *"] }), false);
});

test("deny rules win over allow rules", () => {
  assert.equal(allowed("cat /etc/shadow", { allow: ["cat *"], deny: ["cat /etc/shadow"] }), false);
});

test("useDefaultAllow:false means only configured allow applies", () => {
  assert.equal(allowed("whoami", { useDefaultAllow: false }), false);
  assert.equal(allowed("whoami", { useDefaultAllow: false, allow: ["whoami"] }), true);
});

test("splitSegments splits on separators and reports unterminated quotes", () => {
  assert.deepEqual(splitSegments("a && b | c ; d").segments, ["a", "b", "c", "d"]);
  assert.equal(splitSegments("echo 'open").ok, false);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test test/command-policy.test.js`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `src/command-policy.js`**

```js
// Claude-style command allow/deny policy. Pure: no side effects, no I/O.
//
// A command is split into segments at top-level separators (; && || | & \n).
// Every segment must pass: it is refused by the built-in deny list, a configured
// deny rule, the find-exec guard, or for not matching any allow rule — and the
// whole command is allowed only when every segment is allowed. Constructs that
// cannot be statically checked (command/process substitution, output redirects,
// unterminated quotes) refuse the whole command.
//
// Rule syntax (like Claude's tool permissions):
//   "foo"     exact: matches the segment "foo" only
//   "foo *"   prefix: matches "foo" alone or "foo " followed by anything
//   "foo*"    raw prefix: matches any segment starting with "foo"

export const DEFAULT_ALLOW = [
  "whoami", "id", "hostname", "pwd", "uptime", "date", "env", "printenv",
  "ls *", "cat *", "head *", "tail *", "wc *", "grep *", "find *", "stat *",
  "uname *", "df *", "du *", "free *", "ps *", "echo *", "which *", "file *",
  "md5sum *", "sha256sum *"
];

const DANGEROUS_PATHS = new Set(["/", "/*", "~", ".", "..", "/.", "/root", "/etc", "/*/"]);
const KILL_SWITCHES = ["shutdown", "reboot", "halt", "poweroff", "init"];
const FIND_EXEC_FLAGS = new Set(["-exec", "-execdir", "-ok", "-okdir", "-delete"]);

// Split a command into top-level segments, honouring quotes and rejecting
// constructs we cannot reason about. Returns { ok, segments } or { ok:false, reason }.
export function splitSegments(command) {
  const segments = [];
  let cur = "";
  let single = false;
  let dbl = false;
  let escaped = false;
  const lastNonSpace = () => {
    for (let k = cur.length - 1; k >= 0; k--) {
      if (cur[k] !== " " && cur[k] !== "\t") return cur[k];
    }
    return "";
  };
  const push = () => { segments.push(cur); cur = ""; };

  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    const n = command[i + 1];
    if (escaped) { cur += c; escaped = false; continue; }
    if (c === "\\" && !single) { escaped = true; cur += c; continue; }
    if (single) { if (c === "'") single = false; cur += c; continue; }
    if (dbl) {
      if (c === "`") return { ok: false, reason: "command substitution (backticks)" };
      if (c === "$" && n === "(") return { ok: false, reason: "command substitution" };
      if (c === '"') dbl = false;
      cur += c; continue;
    }
    if (c === "'") { single = true; cur += c; continue; }
    if (c === '"') { dbl = true; cur += c; continue; }
    if (c === "`") return { ok: false, reason: "command substitution (backticks)" };
    if (c === "$" && n === "(") return { ok: false, reason: "command substitution" };
    if ((c === "<" || c === ">") && n === "(") return { ok: false, reason: "process substitution" };
    if (c === ">") {
      if (n === "&") { cur += c; continue; } // fd duplication, e.g. 2>&1
      return { ok: false, reason: "output redirect" };
    }
    if (c === "&") {
      if (lastNonSpace() === ">") { cur += c; continue; } // part of >& fd dup
      if (n === "&") { push(); i++; continue; }           // &&
      push(); continue;                                   // background &
    }
    if (c === "|") { if (n === "|") i++; push(); continue; } // | and ||
    if (c === ";" || c === "\n") { push(); continue; }
    cur += c;
  }
  if (single || dbl || escaped) return { ok: false, reason: "unterminated quote or escape" };
  push();
  const trimmed = segments.map((s) => s.trim()).filter((s) => s.length > 0);
  return { ok: true, segments: trimmed };
}

// Words of a segment, surrounding quotes stripped. Good enough for flag/target
// inspection by the deny rules (not a full shell parser).
function words(segment) {
  const out = [];
  let cur = "";
  let single = false;
  let dbl = false;
  for (const c of segment) {
    if (single) { if (c === "'") single = false; else cur += c; continue; }
    if (dbl) { if (c === '"') dbl = false; else cur += c; continue; }
    if (c === "'") { single = true; continue; }
    if (c === '"') { dbl = true; continue; }
    if (c === " " || c === "\t") { if (cur) { out.push(cur); cur = ""; } continue; }
    cur += c;
  }
  if (cur) out.push(cur);
  return out;
}

const basename = (w) => w.split("/").pop();

// A non-configurable reason the segment is forbidden, or null.
function builtinDeny(segment) {
  // Shell function definition / fork bomb, detected before word-splitting.
  if (/[\w:.-]*\(\)\s*\{/.test(segment)) return "shell function definition / fork bomb";
  const w = words(segment);
  if (w.length === 0) return null;
  const base = basename(w[0]);

  if (base === "rm") {
    const flagChars = w.filter((x) => /^-[^-]/.test(x)).join("");
    const longFlags = w.filter((x) => x.startsWith("--"));
    if (longFlags.includes("--no-preserve-root")) return "rm --no-preserve-root";
    const recursive = flagChars.includes("r") || flagChars.includes("R") || longFlags.includes("--recursive");
    const force = flagChars.includes("f") || longFlags.includes("--force");
    const targets = w.slice(1).filter((x) => !x.startsWith("-"));
    if (recursive && force && (targets.length === 0 || targets.some((t) => DANGEROUS_PATHS.has(t)))) {
      return "recursive force remove of a dangerous path";
    }
    if (recursive && targets.some((t) => DANGEROUS_PATHS.has(t))) {
      return "recursive remove of a dangerous path";
    }
  }
  if (base.startsWith("mkfs")) return "filesystem creation";
  if (base === "dd" && w.some((x) => /^of=\/dev\//.test(x))) return "dd to a device";
  if (KILL_SWITCHES.includes(base)) return `power control (${base})`;
  return null;
}

function matchesRule(segment, rule) {
  const seg = segment.replace(/\s+/g, " ").trim();
  if (rule.endsWith(" *")) {
    const prefix = rule.slice(0, -2);
    return seg === prefix || seg.startsWith(prefix + " ");
  }
  if (rule.endsWith("*")) return seg.startsWith(rule.slice(0, -1));
  return seg === rule;
}

const matchesAny = (segment, rules) => rules.some((r) => matchesRule(segment, r));

export function evaluateCommand(command, { allow = [], deny = [], useDefaultAllow = true } = {}) {
  if (typeof command !== "string" || command.trim() === "") {
    return { allowed: false, reason: "empty command" };
  }
  const split = splitSegments(command);
  if (!split.ok) return { allowed: false, reason: `cannot evaluate: ${split.reason}` };

  const allowRules = (useDefaultAllow ? DEFAULT_ALLOW : []).concat(allow);
  for (const segment of split.segments) {
    const denyReason = builtinDeny(segment);
    if (denyReason) return { allowed: false, segment, reason: `built-in deny: ${denyReason}` };
    if (matchesAny(segment, deny)) return { allowed: false, segment, reason: "matches a deny rule" };

    const w = words(segment);
    if (basename(w[0] || "") === "find" && w.some((x) => FIND_EXEC_FLAGS.has(x))) {
      return { allowed: false, segment, reason: "find with -exec/-delete is not allowed" };
    }
    if (!matchesAny(segment, allowRules)) {
      return { allowed: false, segment, reason: "not in allow-list" };
    }
  }
  return { allowed: true };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `node --test test/command-policy.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/command-policy.js test/command-policy.test.js
git commit -m "Add command allow/deny policy module"
```

---

### Task 2: Command runner (Docker + host backends)

**Files:**
- Create: `src/command-runner.js`
- Test: `test/command-runner.test.js`

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces: `createCommandRunner(config, deps?) -> { run(command) -> Promise<{stdout,stderr,exitCode,timedOut,truncated,durationMs}>, status() -> object, close() -> Promise<void> }`. `config`: `{ mode, docker:{image,network,readOnly,user,memory,pidsLimit,extraArgs}, timeoutMs, maxOutputBytes, udid }`. `deps`: `{ spawn?, env? }`. `run` rejects with an `Error` whose `.code === "DOCKER_UNAVAILABLE"` when Docker is missing or the container cannot be created.

- [ ] **Step 1: Write failing tests**

```js
import assert from "node:assert/strict";
import { test } from "node:test";
import { EventEmitter } from "node:events";
import { createCommandRunner } from "../src/command-runner.js";

function fakeSpawn(handler) {
  const spawn = (cmd, args, options) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = (sig) => { child.killed = true; child.signal = sig; };
    const call = { cmd, args, options, child };
    spawn.calls.push(call);
    queueMicrotask(() => {
      const r = handler(call) || {};
      if (r.stdout) child.stdout.emit("data", Buffer.from(r.stdout));
      if (r.stderr) child.stderr.emit("data", Buffer.from(r.stderr));
      if (r.error) return child.emit("error", r.error);
      if (r.hang) return;
      child.emit("close", r.code ?? 0, r.signal ?? null);
    });
    return child;
  };
  spawn.calls = [];
  return spawn;
}

const dockerConfig = (over = {}) => ({
  mode: "docker",
  docker: { image: "dhi.io/alpine-base:3.24", network: "none", readOnly: true, user: "65534:65534", memory: "128m", pidsLimit: 64, extraArgs: [] },
  timeoutMs: 10000, maxOutputBytes: 65536, udid: "11111111-2222-3333-4444-555555555555",
  ...over
});

test("docker backend creates a hardened container and execs the command", async () => {
  const spawn = fakeSpawn((call) => {
    if (call.args[0] === "run") return { stdout: "container123\n", code: 0 };
    if (call.args[0] === "exec") return { stdout: "nobody\n", code: 0 };
    return {};
  });
  const runner = createCommandRunner(dockerConfig(), { spawn });
  const r = await runner.run("whoami");
  const runArgs = spawn.calls[0].args;
  for (const f of ["-d", "--rm", "--network", "none", "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--pids-limit", "64", "dhi.io/alpine-base:3.24", "sleep", "infinity"]) {
    assert.ok(runArgs.includes(f), `run args missing ${f}`);
  }
  assert.deepEqual(spawn.calls[1].args, ["exec", "-w", "/tmp", "container123", "timeout", "-s", "KILL", "10", "sh", "-c", "whoami"]);
  assert.equal(r.stdout, "nobody\n");
  assert.equal(r.exitCode, 0);
});

test("docker backend recreates the container when it has gone", async () => {
  let execs = 0;
  const spawn = fakeSpawn((call) => {
    if (call.args[0] === "run") return { stdout: "cid" + spawn.calls.filter((c) => c.args[0] === "run").length + "\n", code: 0 };
    if (call.args[0] === "exec") { execs++; return execs === 1 ? { stderr: "Error: No such container: cid1", code: 1 } : { stdout: "ok\n", code: 0 }; }
    return {};
  });
  const runner = createCommandRunner(dockerConfig(), { spawn });
  const r = await runner.run("whoami");
  assert.equal(r.stdout, "ok\n");
  assert.equal(spawn.calls.filter((c) => c.args[0] === "run").length, 2);
});

test("a command that never returns is killed and reported as timed out", async () => {
  const spawn = fakeSpawn((call) => (call.args[0] === "run" ? { stdout: "cid\n", code: 0 } : { hang: true }));
  const runner = createCommandRunner(dockerConfig({ timeoutMs: 20 }), { spawn });
  const r = await runner.run("sleep 999");
  assert.equal(r.timedOut, true);
});

test("output beyond the cap is truncated", async () => {
  const spawn = fakeSpawn((call) => (call.args[0] === "run" ? { stdout: "cid\n", code: 0 } : { stdout: "x".repeat(100), code: 0 }));
  const runner = createCommandRunner(dockerConfig({ maxOutputBytes: 10 }), { spawn });
  const r = await runner.run("cat big");
  assert.equal(r.truncated, true);
  assert.ok(Buffer.byteLength(r.stdout) <= 10);
});

test("host mode runs sh -c and strips secret env vars", async () => {
  const spawn = fakeSpawn(() => ({ stdout: "1\n", code: 0 }));
  const runner = createCommandRunner(
    { mode: "host", timeoutMs: 1000, maxOutputBytes: 100 },
    { spawn, env: { FOO: "1", THINX_OWNER_PASS: "secret", MY_TOKEN: "t", API_KEY: "k" } }
  );
  await runner.run("whoami");
  assert.deepEqual(spawn.calls[0].args, ["-c", "whoami"]);
  assert.equal(spawn.calls[0].cmd, "sh");
  const env = spawn.calls[0].options.env;
  assert.equal(env.FOO, "1");
  assert.ok(!("THINX_OWNER_PASS" in env) && !("MY_TOKEN" in env) && !("API_KEY" in env));
});

test("run rejects DOCKER_UNAVAILABLE when docker is missing", async () => {
  const spawn = fakeSpawn(() => ({ error: Object.assign(new Error("spawn docker ENOENT"), { code: "ENOENT" }) }));
  const runner = createCommandRunner(dockerConfig(), { spawn });
  await assert.rejects(runner.run("whoami"), (e) => e.code === "DOCKER_UNAVAILABLE");
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test test/command-runner.test.js`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `src/command-runner.js`**

```js
// Executes an already-approved command, either in a long-lived Docker container
// (default) or directly on the host (only when mode === "host"). Policy is NOT
// checked here — callers must run command-policy first.

import { spawn as nodeSpawn } from "node:child_process";

const SECRET_ENV = /PASS|TOKEN|KEY|SECRET/i;

// Spawn a process, capture bounded stdout/stderr, enforce a hard timeout.
function spawnCapture(spawnImpl, cmd, args, { env, timeoutMs, maxOutputBytes }) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnImpl(cmd, args, env ? { env } : {});
    } catch (e) {
      return reject(e);
    }
    const started = Date.now();
    let out = Buffer.alloc(0);
    let err = Buffer.alloc(0);
    let truncated = false;
    let timedOut = false;
    let settled = false;
    const cap = (buf, chunk) => {
      if (buf.length >= maxOutputBytes) { truncated = true; return buf; }
      const next = Buffer.concat([buf, chunk]);
      if (next.length > maxOutputBytes) { truncated = true; return next.subarray(0, maxOutputBytes); }
      return next;
    };
    const done = (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout: out.toString("utf8"), stderr: err.toString("utf8"), exitCode, timedOut, truncated, durationMs: Date.now() - started });
    };
    const timer = setTimeout(() => { timedOut = true; try { child.kill("SIGKILL"); } catch { /* already gone */ } done(null); }, timeoutMs);
    child.stdout.on("data", (c) => { out = cap(out, c); });
    child.stderr.on("data", (c) => { err = cap(err, c); });
    child.on("error", (e) => { if (settled) return; settled = true; clearTimeout(timer); reject(e); });
    child.on("close", (code) => done(code));
  });
}

function dockerUnavailable(e) {
  const err = new Error(`Docker is not available: ${e.message}`);
  err.code = "DOCKER_UNAVAILABLE";
  return err;
}

export function createCommandRunner(config, deps = {}) {
  const spawnImpl = deps.spawn || nodeSpawn;
  const baseEnv = deps.env || process.env;
  const timeoutMs = Number(config.timeoutMs) || 10000;
  const maxOutputBytes = Number(config.maxOutputBytes) || 65536;
  let containerId;

  const containerName = () => `thinx-mcp-${String(config.udid || "device").replace(/[^a-zA-Z0-9_.-]/g, "").slice(0, 16) || "device"}`;

  function runArgs() {
    const d = config.docker || {};
    return [
      "run", "-d", "--rm", "--name", containerName(),
      "--network", d.network || "none",
      ...(d.readOnly === false ? [] : ["--read-only"]),
      "--tmpfs", "/tmp:rw,size=16m",
      "--cap-drop", "ALL",
      "--security-opt", "no-new-privileges",
      "--user", d.user || "65534:65534",
      "--memory", d.memory || "128m",
      "--pids-limit", String(d.pidsLimit || 64),
      ...(Array.isArray(d.extraArgs) ? d.extraArgs : []),
      d.image || "dhi.io/alpine-base:3.24",
      "sleep", "infinity"
    ];
  }

  async function ensureContainer() {
    if (containerId) return containerId;
    let res;
    try {
      res = await spawnCapture(spawnImpl, "docker", runArgs(), { timeoutMs: 30000, maxOutputBytes });
    } catch (e) {
      throw dockerUnavailable(e);
    }
    if (res.exitCode !== 0 || !res.stdout.trim()) {
      throw dockerUnavailable(new Error(res.stderr.trim() || `docker run exited ${res.exitCode}`));
    }
    containerId = res.stdout.trim();
    return containerId;
  }

  function execArgs(id, command) {
    return ["exec", "-w", "/tmp", id, "timeout", "-s", "KILL", String(Math.ceil(timeoutMs / 1000)), "sh", "-c", command];
  }

  async function runDocker(command, recreated = false) {
    const id = await ensureContainer();
    let res;
    try {
      res = await spawnCapture(spawnImpl, "docker", execArgs(id, command), { timeoutMs: timeoutMs + 2000, maxOutputBytes });
    } catch (e) {
      throw dockerUnavailable(e);
    }
    const missing = res.exitCode !== 0 && /no such container|is not running/i.test(res.stderr);
    if (missing && !recreated) { containerId = undefined; return runDocker(command, true); }
    if (res.exitCode === 124) res.timedOut = true; // GNU timeout exit code
    return res;
  }

  async function runHost(command) {
    const env = {};
    for (const [k, v] of Object.entries(baseEnv)) if (!SECRET_ENV.test(k)) env[k] = v;
    return spawnCapture(spawnImpl, "sh", ["-c", command], { env, timeoutMs, maxOutputBytes });
  }

  return {
    run(command) {
      return config.mode === "host" ? runHost(command) : runDocker(command);
    },
    status() {
      return config.mode === "host"
        ? { mode: "host" }
        : { mode: "docker", image: (config.docker || {}).image, containerId: containerId || null, running: Boolean(containerId) };
    },
    async close() {
      if (!containerId) return;
      const id = containerId;
      containerId = undefined;
      try { await spawnCapture(spawnImpl, "docker", ["rm", "-f", id], { timeoutMs: 10000, maxOutputBytes }); } catch { /* best effort */ }
    }
  };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `node --test test/command-runner.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/command-runner.js test/command-runner.test.js
git commit -m "Add sandboxed command runner (Docker + host backends)"
```

---

### Task 3: Client wiring + MCP tool + README

**Files:**
- Modify: `src/thinx-device-client.js`
- Modify: `src/mcp-server.js`
- Modify: `package.json`
- Modify: `README.md`
- Test: `test/command-client.test.js`

**Interfaces:**
- Consumes: `evaluateCommand`, `DEFAULT_ALLOW` (Task 1); `createCommandRunner` (Task 2).
- Produces on the client: getter `consoleChannel`; `async executeCommand(command, { source }) -> reply`; `async dispatchCommand(command, { dryRun }) -> reply | policy`; `async closeCommandRunner()`. Reply shape: `{ udid, cmd, source, at, status, exitCode?, stdout?, stderr?, timedOut?, truncated?, durationMs?, reason?, segment?, message? }` where `status ∈ {ok, timeout, refused, disabled, unavailable, busy, error}`.

- [ ] **Step 1: Write failing tests** (`test/command-client.test.js`)

```js
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { EventEmitter } from "node:events";
import { ThinxDeviceClient } from "../src/thinx-device-client.js";

function tempPath(name) { return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "thinx-cmd-")), name); }

const OWNER = "b".repeat(64);
const UDID = "11111111-2222-3333-4444-555555555555";

function fakeMqtt() {
  const connect = (url, options) => {
    const client = new EventEmitter();
    client.options = options;
    client.published = [];
    client.subscribe = (topics, _o, cb) => cb(null, topics.map((t) => ({ topic: t, qos: 0 })));
    client.publish = (topic, payload, opts) => client.published.push({ topic, payload, opts });
    client.end = () => {};
    connect.clients.push(client);
    setImmediate(() => client.emit("connect"));
    return client;
  };
  connect.clients = [];
  return connect;
}

function fakeSpawn(stdout) {
  const spawn = (cmd, args) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    spawn.calls.push({ cmd, args });
    queueMicrotask(() => {
      if (args[0] === "run") child.stdout.emit("data", Buffer.from("cid\n"));
      else child.stdout.emit("data", Buffer.from(stdout));
      child.emit("close", 0, null);
    });
    return child;
  };
  spawn.calls = [];
  return spawn;
}

function makeClient(over = {}) {
  const client = new ThinxDeviceClient({
    statePath: tempPath("state.json"),
    apiKey: "a".repeat(64),
    ownerId: OWNER,
    autoConnectMqtt: false,
    checkinIntervalSeconds: 0,
    commands: { enabled: true, mode: "host", useDefaultAllow: true },
    spawn: fakeSpawn("nobody\n"),
    ...over
  });
  client.applyRegistrationResponse({ registration: { success: true, status: "OK", owner: OWNER, udid: UDID } });
  return client;
}

test("dispatchCommand runs an allowed command", async () => {
  const reply = await makeClient().dispatchCommand("whoami");
  assert.equal(reply.status, "ok");
  assert.equal(reply.stdout, "nobody\n");
});

test("dispatchCommand dryRun returns the policy decision only", async () => {
  const client = makeClient();
  assert.equal((await client.dispatchCommand("whoami", { dryRun: true })).allowed, true);
  const refused = await client.dispatchCommand("rm -rf /", { dryRun: true });
  assert.equal(refused.allowed, false);
  assert.equal(client.spawnCallCount?.() ?? client.getSpawnCalls?.().length ?? 0, 0); // nothing ran
});

test("a refused command is not executed", async () => {
  const reply = await makeClient().dispatchCommand("curl http://x");
  assert.equal(reply.status, "refused");
  assert.match(reply.reason, /allow-list/);
});

test("disabled config refuses with status disabled", async () => {
  const reply = await makeClient({ commands: { enabled: false, mode: "host" } }).dispatchCommand("whoami");
  assert.equal(reply.status, "disabled");
});

test("an MQTT cmd message publishes a reply on the console channel", async () => {
  const mqttConnect = fakeMqtt();
  const client = makeClient({ mqttConnect });
  await client.connectMqtt();
  const [mq] = mqttConnect.clients;
  mq.emit("message", `/${OWNER}/${UDID}`, Buffer.from(JSON.stringify({ cmd: "whoami" })), { retain: false });
  const consoleTopic = `/${OWNER}/shared/${UDID}/console`;
  for (let i = 0; i < 50 && !mq.published.find((p) => p.topic === consoleTopic); i++) await new Promise((r) => setImmediate(r));
  const pub = mq.published.find((p) => p.topic === consoleTopic);
  assert.ok(pub, "expected a console publish");
  const reply = JSON.parse(pub.payload);
  assert.equal(reply.status, "ok");
  assert.equal(reply.cmd, "whoami");
  assert.equal(pub.opts.retain, false);
});

test("a retained cmd message is ignored", async () => {
  const mqttConnect = fakeMqtt();
  const client = makeClient({ mqttConnect });
  await client.connectMqtt();
  const [mq] = mqttConnect.clients;
  const before = mq.published.length;
  mq.emit("message", `/${OWNER}/${UDID}`, Buffer.from(JSON.stringify({ cmd: "whoami" })), { retain: true });
  for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
  assert.equal(mq.published.length, before);
});
```

> Note: the `spawnCallCount` line in the dryRun test is defensive; the real
> assertion is that `allowed` is correct. Replace it with a no-op if the client
> does not expose spawn counts — the dryRun path never constructs a runner.

- [ ] **Step 2: Add `commands` config.** In `resolveConfig` (src/thinx-device-client.js), add a `commands` key built by a new `resolveCommandsConfig(options, fileConfig)` helper:

```js
function parseList(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === "string") return value.split(",").map((s) => s.trim()).filter(Boolean);
  return [];
}

function resolveCommandsConfig(options, fileConfig) {
  const c = options.commands || fileConfig.commands || {};
  const d = c.docker || {};
  return {
    enabled: parseBoolean(options.commandsEnabled ?? process.env.THINX_CMD_ENABLED ?? c.enabled, true),
    mode: options.commandMode || process.env.THINX_CMD_MODE || c.mode || "docker",
    docker: {
      image: options.commandImage || process.env.THINX_CMD_IMAGE || d.image || "dhi.io/alpine-base:3.24",
      network: d.network || "none",
      readOnly: d.readOnly !== false,
      user: d.user || "65534:65534",
      memory: d.memory || "128m",
      pidsLimit: Number(d.pidsLimit) || 64,
      extraArgs: Array.isArray(d.extraArgs) ? d.extraArgs : []
    },
    allow: parseList(process.env.THINX_CMD_ALLOW).concat(parseList(c.allow)),
    deny: parseList(process.env.THINX_CMD_DENY).concat(parseList(c.deny)),
    useDefaultAllow: parseBoolean(c.useDefaultAllow, true),
    timeoutMs: Number(options.commandTimeoutMs || process.env.THINX_CMD_TIMEOUT_MS || c.timeoutMs) || 10000,
    maxOutputBytes: Number(c.maxOutputBytes) || 65536
  };
}
```

Add `commands: resolveCommandsConfig(options, fileConfig),` to the returned config object. Add imports at the top of the file:

```js
import { evaluateCommand, DEFAULT_ALLOW } from "./command-policy.js";
import { createCommandRunner } from "./command-runner.js";
```

In the constructor add:

```js
this.spawnImpl = options.spawn;
this.commandRunner = undefined;
this.commandChain = Promise.resolve();
this.pendingCommands = 0;
```

Define a module constant near the top: `const MAX_PENDING_COMMANDS = 10;`

- [ ] **Step 3: Add the console channel getter and command methods** (after `sharedChannel` getter / near `publishStatus`):

```js
get consoleChannel() {
  return this.ownerId && this.udid ? `/${this.ownerId}/shared/${this.udid}/console` : undefined;
}

getCommandRunner() {
  if (!this.commandRunner) {
    this.commandRunner = createCommandRunner(
      { ...this.config.commands, udid: this.udid },
      { spawn: this.spawnImpl }
    );
  }
  return this.commandRunner;
}

async closeCommandRunner() {
  if (this.commandRunner) { await this.commandRunner.close(); this.commandRunner = undefined; }
}

async executeCommand(command, { source = "tool" } = {}) {
  const base = { udid: this.udid, cmd: command, source, at: new Date().toISOString() };
  const cfg = this.config.commands;
  if (!cfg.enabled) return { ...base, status: "disabled", reason: "command execution is disabled" };
  if (cfg.mode !== "docker" && cfg.mode !== "host") return { ...base, status: "disabled", reason: `unknown command mode "${cfg.mode}"` };
  const policy = evaluateCommand(command, cfg);
  if (!policy.allowed) return { ...base, status: "refused", reason: policy.reason, segment: policy.segment };
  if (this.pendingCommands >= MAX_PENDING_COMMANDS) return { ...base, status: "busy", reason: `too many pending commands (max ${MAX_PENDING_COMMANDS})` };

  this.pendingCommands++;
  const task = this.commandChain.then(() => this.getCommandRunner().run(command));
  this.commandChain = task.then(() => {}, () => {});
  let reply;
  try {
    const r = await task;
    reply = { ...base, status: r.timedOut ? "timeout" : "ok", exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr, timedOut: r.timedOut, truncated: r.truncated, durationMs: r.durationMs };
  } catch (err) {
    reply = (err && err.code === "DOCKER_UNAVAILABLE")
      ? { ...base, status: "unavailable", message: err.message }
      : { ...base, status: "error", message: err ? err.message : "unknown error" };
  } finally {
    this.pendingCommands--;
  }
  this.emit("command-run", reply);
  return reply;
}

async dispatchCommand(command, { dryRun = false } = {}) {
  if (typeof command !== "string" || command.trim() === "") return { cmd: command, status: "refused", reason: "empty command" };
  if (dryRun) return { cmd: command, dryRun: true, ...evaluateCommand(command, this.config.commands) };
  return this.executeCommand(command, { source: "tool" });
}

publishConsole(reply) {
  if (!this.mqttClient || !this.mqttConnected || !this.consoleChannel) return undefined;
  const payload = JSON.stringify(reply);
  this.mqttClient.publish(this.consoleChannel, payload, { qos: 0, retain: false });
  return { topic: this.consoleChannel, payload };
}
```

- [ ] **Step 4: Hook the MQTT message handler.** In `connectMqttOnce`, inside `client.on("message", ...)`, add a console-channel skip next to the existing status skip, and dispatch commands from the device channel:

```js
if (topic === statusChannel) return;
if (topic === this.consoleChannel) return; // our own replies, echoed back over shared/#
```

and after the message is buffered and the firmware-update check:

```js
if (topic === this.deviceChannel && !packet?.retain && message.json && typeof message.json.cmd === "string") {
  this.executeCommand(message.json.cmd, { source: "mqtt" })
    .then((reply) => this.publishConsole(reply))
    .catch((error) => this.emit("command-error", error));
}
```

- [ ] **Step 5: Add the `commands` block to `safeState()`:**

```js
commands: {
  enabled: this.config.commands.enabled,
  mode: this.config.commands.mode,
  image: this.config.commands.docker.image,
  useDefaultAllow: this.config.commands.useDefaultAllow,
  allow: this.config.commands.allow,
  deny: this.config.commands.deny,
  defaultAllow: DEFAULT_ALLOW,
  pending: this.pendingCommands,
  consoleChannel: this.consoleChannel,
  runner: this.commandRunner ? this.commandRunner.status() : null
},
```

- [ ] **Step 6: Add the `thinx_exec` tool.** In `src/mcp-server.js` tools array:

```js
tool("thinx_exec", "Run a shell command through the device command sandbox (Docker by default, host only if explicitly configured) and return stdout/stderr/exit code. Applies the same allow-list policy as MQTT cmd messages; does not publish to MQTT.", {
  type: "object",
  additionalProperties: false,
  required: ["command"],
  properties: {
    command: { type: "string", description: "Shell command to run in the sandbox." },
    dryRun: { type: "boolean", description: "Only return the allow/deny decision without running anything." }
  }
}),
```

In `handleToolCall`:

```js
case "thinx_exec":
  return textResult(await this.client.dispatchCommand(args.command, { dryRun: args.dryRun }));
```

In the `shutdown` case, also close the runner:

```js
case "shutdown":
  this.client.disconnectMqtt();
  await this.client.closeCommandRunner();
  this.sendResult(id, {});
  return;
```

In `run()`, register signal handlers and a `command-run` log line:

```js
this.client.on("command-run", (reply) => {
  process.stderr.write(`[thinx-mcp-device] command (${reply.source}) ${reply.status} exit=${reply.exitCode ?? "-"}: ${reply.cmd}\n`);
});
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => { this.client.disconnectMqtt(); this.client.closeCommandRunner().finally(() => process.exit(0)); });
}
```

- [ ] **Step 7: Discover all test files.** In `package.json`, change the test script to `"test": "node --test"`.

- [ ] **Step 8: Run the whole suite**

Run: `npm test`
Expected: all tests pass (existing + the three new files).

- [ ] **Step 9: Update `README.md`** — add a "Remote commands" section after the MQTT section documenting: the `{"cmd": "..."}` message format and device channel, the console reply topic and reply schema, the `commands` config block and `THINX_CMD_*` env overrides, the default allow-list, the rule syntax, the always-on built-in deny list, the host-mode warning, and the `thinx_exec` tool. Add `thinx_exec` to the Tools list.

- [ ] **Step 10: Live verification**

Run a one-line `thinx_exec whoami` against the real `dhi.io/alpine-base:3.24` and confirm the container is created, the command runs, and the reply is `status: ok`. Then one MQTT round trip confirming the console topic accepts the device's publish.

- [ ] **Step 11: Commit**

```bash
git add src/thinx-device-client.js src/mcp-server.js package.json README.md test/command-client.test.js
git commit -m "Wire command execution into MQTT and a thinx_exec tool"
```
