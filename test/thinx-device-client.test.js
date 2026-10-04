import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { readInoCredentials, redactSecret } from "../src/credentials.js";
import crypto from "node:crypto";

import { normalizePlatform, selectHardwareMac, ThinxDeviceClient } from "../src/thinx-device-client.js";

function tempPath(name) {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "thinx-mcp-device-")), name);
}

test("reads API key and owner ID from Arduino example", () => {
  const inoPath = tempPath("example.ino");
  fs.writeFileSync(
    inoPath,
    `
const char *apikey = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const char *owner_id = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const char *ssid = "example";
const char *pass = "secret";
`
  );

  const credentials = readInoCredentials(inoPath);
  assert.equal(credentials.apiKey, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  assert.equal(credentials.ownerId, "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
  assert.equal(credentials.ssid, "example");
  assert.equal(credentials.password, "secret");
});

test("builds THiNX registration body with firmware-compatible fields", () => {
  const statePath = tempPath("state.json");
  const client = new ThinxDeviceClient({
    statePath,
    apiKey: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    ownerId: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    alias: "test-device",
    mac: "5CCF7F123456"
  });

  const body = client.registrationBody({ mac: "5CCF7F123456" });
  assert.deepEqual(Object.keys(body), ["registration"]);
  assert.equal(body.registration.mac, "5CCF7F123456");
  assert.equal(body.registration.owner, "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
  assert.equal(body.registration.alias, "test-device");
  assert.equal(body.registration.platform, "nodejs:mcp");
  assert.equal(body.registration.status, "Registered");
});

test("prefers built-in network interface MAC addresses", () => {
  const mac = selectHardwareMac(
    {
      lo0: [{ internal: true, mac: "00:00:00:00:00:00" }],
      other0: [{ internal: false, mac: "aa:aa:aa:aa:aa:aa" }],
      en0: [{ internal: false, mac: "bb:bb:bb:bb:bb:bb" }],
      eth0: [{ internal: false, mac: "cc:cc:cc:cc:cc:cc" }]
    },
    ["en0", "eth0", "wlan0"]
  );

  assert.equal(mac, "bb:bb:bb:bb:bb:bb");
});

test("applies registration response and derives MQTT topics", () => {
  const statePath = tempPath("state.json");
  const client = new ThinxDeviceClient({
    statePath,
    apiKey: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    ownerId: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
  });

  client.applyRegistrationResponse({
    registration: {
      success: true,
      status: "OK",
      owner: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      udid: "11111111-2222-3333-4444-555555555555",
      alias: "registered-device"
    }
  });

  assert.equal(client.deviceChannel, "/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/11111111-2222-3333-4444-555555555555");
  assert.equal(client.statusChannel, "/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/11111111-2222-3333-4444-555555555555/status");
  assert.equal(client.safeState().apiKey, redactSecret("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"));
});

test("unwraps stringified response envelope and reports rejection", () => {
  const client = new ThinxDeviceClient({
    statePath: tempPath("state.json"),
    apiKey: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    ownerId: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
  });

  assert.throws(
    () =>
      client.applyRegistrationResponse({
        success: false,
        response: JSON.stringify({ registration: { success: false, status: "OK" } })
      }),
    /Registration rejected by THiNX/
  );
});

function mockFetch(routes) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, method: init.method || "GET", headers: init.headers || {}, body: init.body });
    const route = routes[`${init.method || "GET"} ${url}`] || routes[url];
    if (!route) {
      return { ok: false, status: 404, text: async () => JSON.stringify({ success: false, error: "no_route" }) };
    }
    const setCookie = route.setCookie || [];
    const headers = {
      get: (name) => (name.toLowerCase() === "set-cookie" && setCookie.length ? setCookie.join(", ") : null),
      getSetCookie: () => setCookie
    };
    return { ok: route.ok !== false, status: route.status || 200, headers, text: async () => route.text };
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

const ENV_CLIENT_OPTS = {
  apiKey: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  ownerId: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  ownerToken: "owner-jwt-token-1234567890",
  apiUrl: "https://console.thinx.cloud"
};

test("getEnvironment reads device.environment via POST /api/v2/device", async () => {
  const fetchImpl = mockFetch({
    "POST https://console.thinx.cloud/api/v2/device": {
      text: JSON.stringify({ success: true, response: { udid: "udid-1", environment: { ssid: "*****", region: "eu" }, env_hash: "h1" } })
    }
  });
  const client = new ThinxDeviceClient({ ...ENV_CLIENT_OPTS, statePath: tempPath("state.json"), fetch: fetchImpl });
  const result = await client.getEnvironment({ udid: "udid-1" });

  assert.deepEqual(result.environment, { ssid: "*****", region: "eu" });
  assert.equal(result.env_hash, "h1");
  assert.equal(fetchImpl.calls[0].method, "POST");
  assert.equal(fetchImpl.calls[0].headers.Authorization, "Bearer owner-jwt-token-1234567890");
});

test("setEnvironment with merge=false PUTs the exact environment", async () => {
  const fetchImpl = mockFetch({
    "PUT https://console.thinx.cloud/api/v2/device": {
      text: JSON.stringify({ success: true, change: { environment: { region: "us" } } })
    }
  });
  const client = new ThinxDeviceClient({ ...ENV_CLIENT_OPTS, statePath: tempPath("state.json"), fetch: fetchImpl });
  const result = await client.setEnvironment({ region: "us" }, { udid: "udid-1", merge: false });

  assert.equal(fetchImpl.calls.length, 1);
  assert.equal(fetchImpl.calls[0].method, "PUT");
  const sent = JSON.parse(fetchImpl.calls[0].body);
  assert.deepEqual(sent, { changes: { udid: "udid-1", environment: { region: "us" } } });
  assert.deepEqual(result.environment, { region: "us" });
});

test("setEnvironment with merge=true keeps existing keys", async () => {
  const fetchImpl = mockFetch({
    "POST https://console.thinx.cloud/api/v2/device": {
      text: JSON.stringify({ success: true, response: { environment: { ssid: "office", region: "eu" } } })
    },
    "PUT https://console.thinx.cloud/api/v2/device": {
      text: JSON.stringify({ success: true })
    }
  });
  const client = new ThinxDeviceClient({ ...ENV_CLIENT_OPTS, statePath: tempPath("state.json"), fetch: fetchImpl });
  const result = await client.setEnvironment({ region: "us" }, { udid: "udid-1" });

  assert.deepEqual(result.environment, { ssid: "office", region: "us" });
  const put = JSON.parse(fetchImpl.calls[1].body);
  assert.deepEqual(put.changes.environment, { ssid: "office", region: "us" });
});

test("environment calls require owner credentials", async () => {
  const client = new ThinxDeviceClient({
    apiKey: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    ownerId: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    statePath: tempPath("state.json")
  });
  await assert.rejects(() => client.getEnvironment({ udid: "udid-1" }), /No owner credentials/);
});

function fakeJwt(expEpoch) {
  const seg = (obj) => Buffer.from(JSON.stringify(obj)).toString("base64").replace(/=+$/, "");
  return `${seg({ alg: "HS512", typ: "JWT" })}.${seg({ username: "owner", exp: expEpoch })}.sig`;
}

const CSRF_PRIME = {
  "GET https://console.thinx.cloud/api/v2/csrf-token": {
    text: JSON.stringify({ success: true, response: { csrf_token: "xsrf-abc" } }),
    setCookie: [
      "XSRF-TOKEN=xsrf-abc; Domain=.thinx.cloud; Path=/; Secure; SameSite=Lax",
      "x-thx-core=sess-123; Domain=.thinx.cloud; Path=/; HttpOnly; Secure; SameSite=Lax"
    ]
  }
};

test("ownerLogin primes the CSRF token and echoes it on the login POST", async () => {
  const jwt = fakeJwt(Math.floor(Date.now() / 1000) + 3600);
  const fetchImpl = mockFetch({
    ...CSRF_PRIME,
    "POST https://console.thinx.cloud/api/v2/login": {
      text: JSON.stringify({ success: true, access_token: jwt, refresh_token: "r" })
    }
  });
  const client = new ThinxDeviceClient({
    statePath: tempPath("state.json"),
    ownerUsername: "test",
    ownerPassword: "tset",
    apiUrl: "https://console.thinx.cloud",
    fetch: fetchImpl
  });

  await client.ownerLogin();
  assert.equal(fetchImpl.calls[0].url, "https://console.thinx.cloud/api/v2/csrf-token");
  const login = fetchImpl.calls[1];
  assert.equal(login.url, "https://console.thinx.cloud/api/v2/login");
  assert.equal(login.headers["X-XSRF-TOKEN"], "xsrf-abc");
  assert.equal(login.headers.Cookie, "XSRF-TOKEN=xsrf-abc; x-thx-core=sess-123");
});

test("ownerLogin posts credentials and caches the session token", async () => {
  const futureExp = Math.floor(Date.now() / 1000) + 3600;
  const jwt = fakeJwt(futureExp);
  const fetchImpl = mockFetch({
    ...CSRF_PRIME,
    "POST https://console.thinx.cloud/api/v2/login": {
      text: JSON.stringify({ success: true, access_token: jwt, refresh_token: "refresh-xyz" })
    }
  });
  const client = new ThinxDeviceClient({
    statePath: tempPath("state.json"),
    ownerUsername: "test",
    ownerPassword: "tset",
    apiUrl: "https://console.thinx.cloud",
    fetch: fetchImpl
  });

  const session = await client.ownerLogin();
  assert.equal(session.accessToken, jwt);
  assert.equal(session.expiresAt, futureExp);
  assert.deepEqual(JSON.parse(fetchImpl.calls[1].body), { username: "test", password: "tset" });
});

test("getEnvironment auto-logs-in when only credentials are configured", async () => {
  const jwt = fakeJwt(Math.floor(Date.now() / 1000) + 3600);
  const fetchImpl = mockFetch({
    ...CSRF_PRIME,
    "POST https://console.thinx.cloud/api/v2/login": {
      text: JSON.stringify({ success: true, access_token: jwt, refresh_token: "r" })
    },
    "POST https://console.thinx.cloud/api/v2/device": {
      text: JSON.stringify({ success: true, response: { environment: { region: "eu" } } })
    }
  });
  const client = new ThinxDeviceClient({
    statePath: tempPath("state.json"),
    ownerUsername: "test",
    ownerPassword: "tset",
    apiUrl: "https://console.thinx.cloud",
    fetch: fetchImpl
  });

  const result = await client.getEnvironment({ udid: "udid-1" });
  assert.deepEqual(result.environment, { region: "eu" });
  assert.equal(fetchImpl.calls[1].url, "https://console.thinx.cloud/api/v2/login");
  assert.equal(fetchImpl.calls[2].headers.Authorization, `Bearer ${jwt}`);
});

//
// Platform + OTT firmware updates
//

const DEVICE_OPTS = {
  apiKey: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  ownerId: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  cloudUrl: "https://app.thinx.cloud",
  mac: "5CCF7F123456",
  autoConnectMqtt: false
};
const UDID = "11111111-2222-3333-4444-555555555555";
const OTT = "c".repeat(64);

// Like mockFetch, but routes may answer with a binary body and headers.
function deviceFetch(routes) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const href = String(url);
    calls.push({ url: href, method: init.method || "GET", headers: init.headers || {}, body: init.body });
    const route = routes[`${init.method || "GET"} ${href}`];
    if (!route) {
      return { ok: false, status: 404, headers: new Headers(), text: async () => "no_route" };
    }
    const body = route.binary || Buffer.from(route.text || "");
    return {
      ok: route.ok !== false,
      status: route.status || 200,
      headers: new Headers(route.headers || {}),
      text: async () => body.toString("utf8"),
      arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.length)
    };
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

function firmwareRoute(binary) {
  return {
    binary,
    headers: {
      "content-type": "application/octet-stream",
      "content-length": String(binary.length),
      "x-md5": crypto.createHash("md5").update(binary).digest("hex")
    }
  };
}

test("normalizes arduino/platformio platforms to <platform>:<mcu>", () => {
  assert.equal(normalizePlatform("platformio"), "platformio:esp32");
  assert.equal(normalizePlatform("Arduino", "esp8266"), "arduino:esp8266");
  assert.equal(normalizePlatform("platformio:esp8266"), "platformio:esp8266");
  assert.equal(normalizePlatform("nodejs:mcp"), "nodejs:mcp");
});

test("register persists an explicit platform for later check-ins", async () => {
  const fetchImpl = deviceFetch({
    "POST https://app.thinx.cloud/device/register": {
      text: JSON.stringify({ registration: { success: true, status: "OK", owner: DEVICE_OPTS.ownerId, udid: UDID } })
    }
  });
  const client = new ThinxDeviceClient({ ...DEVICE_OPTS, statePath: tempPath("state.json"), fetch: fetchImpl });

  await client.register({ platform: "platformio", firmwareVersionShort: "0.0.1" });
  await client.register();

  const first = JSON.parse(fetchImpl.calls[0].body).registration;
  const second = JSON.parse(fetchImpl.calls[1].body).registration;
  assert.equal(first.platform, "platformio:esp32");
  assert.equal(first.version, "0.0.1");
  assert.equal(second.platform, "platformio:esp32");
  assert.equal(client.safeState().platform, "platformio:esp32");
});

test("FIRMWARE_UPDATE check-in downloads the firmware via OTT and stores it", async () => {
  const binary = crypto.randomBytes(4096);
  const fetchImpl = deviceFetch({
    "POST https://app.thinx.cloud/device/register": {
      // THiNX answers an update as a stringified body without owner/success.
      text: JSON.stringify({ registration: { status: "FIRMWARE_UPDATE", udid: UDID, ott: OTT, version: "1.2.3", auto_update: true } })
    },
    [`GET https://app.thinx.cloud/device/firmware?ott=${OTT}`]: firmwareRoute(binary)
  });
  const firmwareDir = path.dirname(tempPath("x"));
  const client = new ThinxDeviceClient({ ...DEVICE_OPTS, statePath: tempPath("state.json"), firmwareDir, fetch: fetchImpl });

  const result = await client.register({ platform: "platformio" });

  assert.equal(result.registration.status, "FIRMWARE_UPDATE");
  assert.notEqual(result.registration.ott, OTT, "OTT must be redacted in tool output");
  assert.equal(result.firmwareDownload.md5Match, true);
  assert.equal(result.firmwareDownload.version, "1.2.3");
  assert.ok(result.firmwareDownload.path.startsWith(firmwareDir));
  assert.deepEqual(fs.readFileSync(result.firmwareDownload.path), binary);
  assert.equal(client.state.pendingUpdate, undefined);

  // The same version offered again is not downloaded twice.
  const again = await client.register();
  assert.equal(again.firmwareDownload.skipped, true);
  assert.equal(fetchImpl.calls.filter((call) => call.method === "GET").length, 1);
});

test("adoptVersion makes later check-ins report the downloaded version", async () => {
  const binary = crypto.randomBytes(2048);
  const fetchImpl = deviceFetch({
    [`GET https://app.thinx.cloud/device/firmware?ott=${OTT}`]: firmwareRoute(binary)
  });
  const client = new ThinxDeviceClient({
    ...DEVICE_OPTS,
    statePath: tempPath("state.json"),
    firmwareDir: path.dirname(tempPath("x")),
    fetch: fetchImpl
  });
  client.state.udid = UDID;

  await client.downloadFirmware({ ott: OTT, version: "2.0.0", adoptVersion: true });
  assert.equal(client.registrationBody().registration.version, "2.0.0");
});

test("downloadFirmware reports a refused OTT instead of storing it", async () => {
  const fetchImpl = deviceFetch({
    // Util.respond sends a bare string with no octet-stream content type.
    [`GET https://app.thinx.cloud/device/firmware?ott=${OTT}`]: { text: "OTT_UPDATE_NOT_FOUND" }
  });
  const firmwareDir = path.join(path.dirname(tempPath("x")), "fw");
  const client = new ThinxDeviceClient({ ...DEVICE_OPTS, statePath: tempPath("state.json"), firmwareDir, fetch: fetchImpl });

  await assert.rejects(() => client.downloadFirmware({ ott: OTT }), /OTT_UPDATE_NOT_FOUND/);
  assert.equal(fs.existsSync(firmwareDir), false);
});

test("downloadFirmware without a pending token requests a new OTT first", async () => {
  const binary = crypto.randomBytes(1500);
  const fetchImpl = deviceFetch({
    "POST https://app.thinx.cloud/device/firmware": { text: JSON.stringify({ ott: OTT }) },
    [`GET https://app.thinx.cloud/device/firmware?ott=${OTT}`]: firmwareRoute(binary)
  });
  const client = new ThinxDeviceClient({
    ...DEVICE_OPTS,
    statePath: tempPath("state.json"),
    firmwareDir: path.dirname(tempPath("x")),
    fetch: fetchImpl
  });
  client.state.udid = UDID;

  const download = await client.downloadFirmware();

  const request = fetchImpl.calls[0];
  assert.equal(request.headers.Authentication, DEVICE_OPTS.apiKey);
  assert.deepEqual(JSON.parse(request.body), { use: "ott", owner: DEVICE_OPTS.ownerId, udid: UDID, mac: "5CCF7F123456" });
  assert.equal(download.source, "request");
  assert.equal(download.size, binary.length);
});

test("requestOtt surfaces a refusal", async () => {
  const fetchImpl = deviceFetch({ "POST https://app.thinx.cloud/device/firmware": { text: "OTT_API_KEY_NOT_VALID" } });
  const client = new ThinxDeviceClient({ ...DEVICE_OPTS, statePath: tempPath("state.json"), fetch: fetchImpl });
  client.state.udid = UDID;
  await assert.rejects(() => client.requestOtt(), /OTT_API_KEY_NOT_VALID/);
});

//
// MQTT
//

import { EventEmitter } from "node:events";

// Fake mqtt.js client: connects on the next tick (or errors), grants or
// refuses (qos 128) subscriptions per topic, records publishes.
function fakeMqtt({ failConnects = 0, refuse = [] } = {}) {
  const clients = [];
  const connect = (url, options) => {
    const client = new EventEmitter();
    client.url = url;
    client.options = options;
    client.published = [];
    client.ended = false;
    client.subscribe = (topics, _opts, callback) => {
      client.topics = topics;
      callback(null, topics.map((topic) => ({ topic, qos: refuse.includes(topic) ? 128 : 0 })));
    };
    client.publish = (topic, payload, opts) => client.published.push({ topic, payload, opts });
    client.end = () => {
      client.ended = true;
    };
    clients.push(client);
    setImmediate(() => {
      if (clients.length <= failConnects) {
        client.emit("error", new Error("Connection refused: Not authorized"));
      } else {
        client.emit("connect");
      }
    });
    return client;
  };
  connect.clients = clients;
  return connect;
}

const OWNER = DEVICE_OPTS.ownerId;
const registerOk = () =>
  deviceFetch({
    "POST https://app.thinx.cloud/device/register": {
      text: JSON.stringify({ registration: { success: true, status: "OK", owner: OWNER, udid: UDID } })
    }
  });

test("registration connects MQTT and listens on the ACL-granted device topics", async () => {
  const mqttConnect = fakeMqtt();
  const client = new ThinxDeviceClient({
    ...DEVICE_OPTS,
    autoConnectMqtt: true,
    checkinIntervalSeconds: 0,
    statePath: tempPath("state.json"),
    fetch: registerOk(),
    mqttConnect
  });

  const result = await client.register({ platform: "platformio" });

  assert.equal(mqttConnect.clients.length, 1);
  const [mqttClient] = mqttConnect.clients;
  assert.equal(mqttClient.url, "mqtt://thinx.cloud:1883");
  assert.equal(mqttClient.options.username, UDID);
  assert.equal(mqttClient.options.password, DEVICE_OPTS.apiKey);
  assert.equal(mqttClient.options.clientId, "5CCF7F123456");
  assert.equal(mqttClient.options.will.topic, `/${OWNER}/${UDID}/status`);
  assert.deepEqual(mqttClient.topics, [`/${OWNER}/${UDID}`, `/${OWNER}/shared/#`]);
  assert.equal(result.mqtt.connected, true);
  assert.ok(result.mqtt.subscriptions.every((entry) => entry.granted));
  assert.deepEqual(mqttClient.published[0], {
    topic: `/${OWNER}/${UDID}/status`,
    payload: JSON.stringify({ status: "connected" }),
    opts: { qos: 0, retain: true }
  });

  // A later check-in reuses the existing client.
  await client.register();
  assert.equal(mqttConnect.clients.length, 1);
});

test("MQTT connect retries while the backend is still writing credentials", async () => {
  const mqttConnect = fakeMqtt({ failConnects: 2 });
  const client = new ThinxDeviceClient({
    ...DEVICE_OPTS,
    checkinIntervalSeconds: 0,
    statePath: tempPath("state.json"),
    fetch: registerOk(),
    mqttConnect
  });

  const summary = await client.connectMqtt({ retryDelayMs: 1 });

  assert.equal(summary.connected, true);
  assert.equal(mqttConnect.clients.length, 3);
  assert.ok(mqttConnect.clients[0].ended && mqttConnect.clients[1].ended);
  assert.equal(client.safeState().lastMqttError, null);
});

test("MQTT failure does not fail the registration", async () => {
  const mqttConnect = fakeMqtt({ failConnects: 99 });
  const client = new ThinxDeviceClient({
    ...DEVICE_OPTS,
    autoConnectMqtt: true,
    checkinIntervalSeconds: 0,
    statePath: tempPath("state.json"),
    fetch: registerOk(),
    mqttConnect
  });

  const result = await client.register({ retryDelayMs: 1 });

  assert.equal(result.registration.udid, UDID);
  assert.equal(result.mqtt.connected, false);
  assert.match(result.mqtt.error, /after 3 attempt\(s\): Connection refused/);
  assert.equal(client.mqttClient, undefined);
});

test("a refused /owner/udid/# subscription is reported, not fatal", async () => {
  const wildcard = `/${OWNER}/${UDID}/#`;
  const mqttConnect = fakeMqtt({ refuse: [wildcard] });
  const client = new ThinxDeviceClient({
    ...DEVICE_OPTS,
    checkinIntervalSeconds: 0,
    statePath: tempPath("state.json"),
    fetch: registerOk(),
    mqttConnect
  });

  const summary = await client.connectMqtt({ subscribeWildcard: true });

  assert.equal(summary.connected, true);
  assert.deepEqual(summary.subscriptions.find((entry) => entry.topic === wildcard), { topic: wildcard, qos: 128, granted: false });
});

test("MQTT messages on the device channel are buffered and OTTs picked up", async () => {
  const mqttConnect = fakeMqtt();
  const client = new ThinxDeviceClient({
    ...DEVICE_OPTS,
    autoDownloadFirmware: false,
    checkinIntervalSeconds: 0,
    statePath: tempPath("state.json"),
    fetch: registerOk(),
    mqttConnect
  });
  await client.connectMqtt();

  const [mqttClient] = mqttConnect.clients;
  const push = { registration: { status: "FIRMWARE_UPDATE", ott: OTT, version: "3.0.0" } };
  mqttClient.emit("message", `/${OWNER}/${UDID}`, Buffer.from(JSON.stringify(push)), { retain: false });
  mqttClient.emit("message", `/${OWNER}/${UDID}/status`, Buffer.from("{}"), {});

  const messages = client.recentMessages();
  assert.equal(messages.length, 1);
  assert.deepEqual(messages[0].json, push);
  assert.equal(client.state.pendingUpdate.ott, OTT);
  assert.equal(client.state.pendingUpdate.source, "mqtt");
});

test("a reconnect whose re-subscribe returns no new grants keeps the subscription state", async () => {
  // Reproduces mqtt.js 5.x: a repeat subscribe for topics it already tracks
  // short-circuits and calls back with an empty granted array (its own
  // auto-resubscribe keeps the topics live). Our connect handler must not
  // overwrite the first connect's grants with "refused".
  const connect = (url, options) => {
    const client = new EventEmitter();
    client.options = options;
    client.published = [];
    let subCount = 0;
    client.subscribe = (topics, _opts, callback) => {
      subCount += 1;
      const granted = subCount === 1 ? topics.map((topic) => ({ topic, qos: 0 })) : [];
      callback(null, granted);
    };
    client.publish = (topic, payload, opts) => client.published.push({ topic, payload, opts });
    client.end = () => {};
    connect.clients.push(client);
    setImmediate(() => client.emit("connect"));
    return client;
  };
  connect.clients = [];

  const client = new ThinxDeviceClient({
    ...DEVICE_OPTS,
    checkinIntervalSeconds: 0,
    statePath: tempPath("state.json"),
    fetch: registerOk(),
    mqttConnect: connect
  });
  await client.connectMqtt();
  assert.ok(client.safeState().mqttSubscriptions.every((s) => s.granted));

  // Automatic reconnect: mqtt.js fires "close" then "connect" again.
  connect.clients[0].emit("close");
  connect.clients[0].emit("connect");
  await new Promise((resolve) => setImmediate(resolve));

  const subs = client.safeState().mqttSubscriptions;
  assert.equal(subs.length, 2);
  assert.ok(subs.every((s) => s.granted), "subscriptions should stay granted after a reconnect");
});

test("a disconnect clears the reported subscriptions (no stale granted:true)", async () => {
  const mqttConnect = fakeMqtt();
  const client = new ThinxDeviceClient({
    ...DEVICE_OPTS,
    checkinIntervalSeconds: 0,
    statePath: tempPath("state.json"),
    fetch: registerOk(),
    mqttConnect
  });
  await client.connectMqtt();
  assert.equal(client.safeState().mqttSubscriptions.length, 2);

  // A dropped connection must not leave stale granted:true in status.
  mqttConnect.clients[0].emit("close");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(client.safeState().mqttConnected, false);
  assert.deepEqual(client.safeState().mqttSubscriptions, []);
});

test("an explicit disconnect clears the reported subscriptions", async () => {
  const mqttConnect = fakeMqtt();
  const client = new ThinxDeviceClient({
    ...DEVICE_OPTS,
    checkinIntervalSeconds: 0,
    statePath: tempPath("state.json"),
    fetch: registerOk(),
    mqttConnect
  });
  await client.connectMqtt();
  client.disconnectMqtt();
  assert.deepEqual(client.safeState().mqttSubscriptions, []);
});
