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
  timeoutMs: 10000,
  maxOutputBytes: 65536,
  udid: "11111111-2222-3333-4444-555555555555",
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

test("close removes the container once", async () => {
  const spawn = fakeSpawn((call) => (call.args[0] === "run" ? { stdout: "cid\n", code: 0 } : { stdout: "", code: 0 }));
  const runner = createCommandRunner(dockerConfig(), { spawn });
  await runner.run("whoami");
  await runner.close();
  const rm = spawn.calls.filter((c) => c.args[0] === "rm");
  assert.equal(rm.length, 1);
  assert.deepEqual(rm[0].args, ["rm", "-f", "cid"]);
});
