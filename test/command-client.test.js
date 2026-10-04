import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { EventEmitter } from "node:events";
import { ThinxDeviceClient } from "../src/thinx-device-client.js";

function tempPath(name) {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "thinx-cmd-")), name);
}

const OWNER = "b".repeat(64);
const UDID = "11111111-2222-3333-4444-555555555555";
const CONSOLE = `/${OWNER}/shared/${UDID}/console`;

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

// Host-mode fake spawn: "run" is never called in host mode; sh -c echoes a value.
function fakeSpawn(stdout) {
  const spawn = (cmd, args) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    spawn.calls.push({ cmd, args });
    queueMicrotask(() => {
      child.stdout.emit("data", Buffer.from(stdout));
      child.emit("close", 0, null);
    });
    return child;
  };
  spawn.calls = [];
  return spawn;
}

function makeClient(over = {}) {
  const spawn = over.spawn || fakeSpawn("nobody\n");
  const client = new ThinxDeviceClient({
    statePath: tempPath("state.json"),
    apiKey: "a".repeat(64),
    ownerId: OWNER,
    autoConnectMqtt: false,
    checkinIntervalSeconds: 0,
    commands: { enabled: true, mode: "host", useDefaultAllow: true, ...(over.commands || {}) },
    spawn,
    ...(over.mqttConnect ? { mqttConnect: over.mqttConnect } : {})
  });
  client._spawn = spawn;
  client.applyRegistrationResponse({ registration: { success: true, status: "OK", owner: OWNER, udid: UDID } });
  return client;
}

async function tick(n = 20) {
  for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
}

test("dispatchCommand runs an allowed command", async () => {
  const reply = await makeClient().dispatchCommand("whoami");
  assert.equal(reply.status, "ok");
  assert.equal(reply.stdout, "nobody\n");
  assert.equal(reply.exitCode, 0);
});

test("dispatchCommand dryRun returns the policy decision without running", async () => {
  const client = makeClient();
  assert.equal((await client.dispatchCommand("whoami", { dryRun: true })).allowed, true);
  const refused = await client.dispatchCommand("rm -rf /", { dryRun: true });
  assert.equal(refused.allowed, false);
  assert.equal(client._spawn.calls.length, 0);
});

test("a refused command is not executed", async () => {
  const client = makeClient();
  const reply = await client.dispatchCommand("curl http://x");
  assert.equal(reply.status, "refused");
  assert.match(reply.reason, /allow-list/);
  assert.equal(client._spawn.calls.length, 0);
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
  await tick();
  const pub = mq.published.find((p) => p.topic === CONSOLE);
  assert.ok(pub, "expected a console publish");
  const reply = JSON.parse(pub.payload);
  assert.equal(reply.status, "ok");
  assert.equal(reply.cmd, "whoami");
  assert.equal(reply.source, "mqtt");
  assert.equal(pub.opts.retain, false);
});

test("a retained cmd message is ignored", async () => {
  const mqttConnect = fakeMqtt();
  const client = makeClient({ mqttConnect });
  await client.connectMqtt();
  const [mq] = mqttConnect.clients;
  const before = mq.published.length;
  mq.emit("message", `/${OWNER}/${UDID}`, Buffer.from(JSON.stringify({ cmd: "whoami" })), { retain: true });
  await tick();
  assert.equal(mq.published.length, before);
});

test("our own console reply echoed back is not buffered or re-run", async () => {
  const mqttConnect = fakeMqtt();
  const client = makeClient({ mqttConnect });
  await client.connectMqtt();
  const [mq] = mqttConnect.clients;
  mq.emit("message", CONSOLE, Buffer.from(JSON.stringify({ cmd: "whoami", status: "ok" })), { retain: false });
  await tick();
  assert.equal(client.recentMessages().length, 0);
});

test("safeState reports the commands block", () => {
  const state = makeClient().safeState();
  assert.equal(state.commands.enabled, true);
  assert.equal(state.commands.mode, "host");
  assert.equal(state.commands.consoleChannel, CONSOLE);
  assert.ok(Array.isArray(state.commands.defaultAllow));
});
