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
    return { ok: route.ok !== false, status: route.status || 200, text: async () => route.text };
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

test("ownerLogin posts credentials and caches the session token", async () => {
  const futureExp = Math.floor(Date.now() / 1000) + 3600;
  const jwt = fakeJwt(futureExp);
  const fetchImpl = mockFetch({
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
  assert.deepEqual(JSON.parse(fetchImpl.calls[0].body), { username: "test", password: "tset" });
});

test("getEnvironment auto-logs-in when only credentials are configured", async () => {
  const jwt = fakeJwt(Math.floor(Date.now() / 1000) + 3600);
  const fetchImpl = mockFetch({
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
  assert.equal(fetchImpl.calls[0].url, "https://console.thinx.cloud/api/v2/login");
  assert.equal(fetchImpl.calls[1].headers.Authorization, `Bearer ${jwt}`);
});

//
// Platform + OTT firmware updates
//

const DEVICE_OPTS = {
  apiKey: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  ownerId: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  cloudUrl: "https://app.thinx.cloud",
  mac: "5CCF7F123456"
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
