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
      resolve({
        stdout: out.toString("utf8"),
        stderr: err.toString("utf8"),
        exitCode,
        timedOut,
        truncated,
        durationMs: Date.now() - started
      });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
      done(null);
    }, timeoutMs);
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

  const containerName = () =>
    `thinx-mcp-${String(config.udid || "device").replace(/[^a-zA-Z0-9_.-]/g, "").slice(0, 16) || "device"}`;

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
    if (missing && !recreated) {
      containerId = undefined;
      return runDocker(command, true);
    }
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
      try {
        await spawnCapture(spawnImpl, "docker", ["rm", "-f", id], { timeoutMs: 10000, maxOutputBytes });
      } catch {
        /* best effort */
      }
    }
  };
}
