# Actionable Notifications Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the THiNX device emulator the two device-side halves of the actionable-notification round-trip: emit an actionable notification, and receive/parse/act on the response.

**Architecture:** A new pure module `src/notifications.js` holds the classify/approval/payload-build logic (no state, no I/O), mirroring `src/command-policy.js`. `ThinxDeviceClient` orchestrates: a `publishNotification` method, response handling inside the existing MQTT `message` handler, state tracking, and an OTA-approval mirror that reuses the existing firmware-download path. A new `thinx_publish_notification` MCP tool exposes emit.

**Tech Stack:** Node.js ≥20 (ESM), `mqtt` ^5, `node:test` + `node:assert/strict`. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-13-actionable-notifications-design.md`

## Global Constraints

- ESM only (`"type": "module"`); import with explicit `.js` extensions.
- No new runtime dependencies.
- Emit payload MUST be `{ notification: { [title], body, response_type } }` with **no** `response` field, published to the device base channel `/<owner>/<udid>`.
- `response_type` on emit ∈ `{ "bool", "string" }`.
- Approval semantics: `bool`/`boolean` → approved iff `response === true`; `string`/`String` → `"yes"` approved, `"no"` denied; anything else → unrecognized.
- Notification responses must be ignored when the MQTT packet is retained (`packet.retain`), matching the existing `cmd` guard.
- One outstanding notification at a time; `notificationResponses` history bounded to the last 10.
- Tests run via `npm test` (`node --test test/*.test.js`).

## Review Focus

- **Own-notification loopback:** the device is subscribed to the channel it publishes to, so `publishNotification` output returns as an inbound `message`. It must classify as `echo` and never be treated as a response. (Pinned in Task 1 and Task 4.)
- **Retained response replay:** a retained response on the device channel must not re-trigger handling (especially the OTA mirror) on reconnect. (Pinned in Task 4.)
- **Approval without a pending update:** an approval response when `state.pendingUpdate` is absent must record only and must not call the firmware download. (Pinned in Task 5.)
- **Malformed `response_type`:** an unrecognized `response_type` (e.g. `"int"`) must yield `isApproval(...) === undefined` and record-only (no OTA, no throw). (Pinned in Task 1 and Task 5.)
- **Non-string / empty body on emit:** `buildNotificationPayload` must reject a missing/empty/non-string `body` rather than publish an invalid card. (Pinned in Task 1.)

---

### Task 1: Pure notifications module

**Files:**
- Create: `src/notifications.js`
- Test: `test/notifications.test.js`

**Interfaces:**
- Consumes: nothing (pure module).
- Produces:
  - `classifyNotification(json)` → `undefined` | `{ kind: "echo" }` | `{ kind: "response", responseType?, response, nid?, via: "notification" | "reply" }`
  - `isApproval(responseType, response)` → `true | false | undefined`
  - `buildNotificationPayload({ title, body, responseType })` → `{ notification: { title?, body, response_type } }`; throws `Error` on invalid `body` or `responseType`.

- [ ] **Step 1: Write the failing test**

```javascript
// test/notifications.test.js
import assert from "node:assert/strict";
import { test } from "node:test";

import { classifyNotification, isApproval, buildNotificationPayload } from "../src/notifications.js";

test("classifyNotification: echo when notification has no truthy response", () => {
  assert.deepEqual(classifyNotification({ notification: { body: "Update?", response_type: "bool" } }), { kind: "echo" });
  assert.deepEqual(classifyNotification({ notification: { body: "x", response: false } }), { kind: "echo" });
});

test("classifyNotification: response via notification wrapper", () => {
  assert.deepEqual(
    classifyNotification({ notification: { nid: "nid-1", response_type: "bool", response: true } }),
    { kind: "response", responseType: "bool", response: true, nid: "nid-1", via: "notification" }
  );
});

test("classifyNotification: response via {nid, reply}", () => {
  assert.deepEqual(
    classifyNotification({ nid: "nid:abc", reply: "yes" }),
    { kind: "response", response: "yes", nid: "nid:abc", via: "reply", responseType: undefined }
  );
});

test("classifyNotification: undefined for non-notification", () => {
  assert.equal(classifyNotification({ status: "connected" }), undefined);
  assert.equal(classifyNotification({ cmd: "uname -a" }), undefined);
  assert.equal(classifyNotification(undefined), undefined);
  assert.equal(classifyNotification("not-json"), undefined);
});

test("isApproval: bool and string semantics", () => {
  assert.equal(isApproval("bool", true), true);
  assert.equal(isApproval("boolean", false), false);
  assert.equal(isApproval("string", "yes"), true);
  assert.equal(isApproval("String", "no"), false);
  assert.equal(isApproval("int", 1), undefined);
  assert.equal(isApproval("string", "maybe"), undefined);
});

test("buildNotificationPayload: shape, default type, omits response", () => {
  assert.deepEqual(buildNotificationPayload({ body: "Update now?" }), {
    notification: { body: "Update now?", response_type: "bool" }
  });
  assert.deepEqual(buildNotificationPayload({ title: "Hi", body: "b", responseType: "string" }), {
    notification: { title: "Hi", body: "b", response_type: "string" }
  });
  const payload = buildNotificationPayload({ body: "b" });
  assert.equal("response" in payload.notification, false);
});

test("buildNotificationPayload: rejects bad body and responseType", () => {
  assert.throws(() => buildNotificationPayload({ body: "" }), /body/);
  assert.throws(() => buildNotificationPayload({ body: 42 }), /body/);
  assert.throws(() => buildNotificationPayload({}), /body/);
  assert.throws(() => buildNotificationPayload({ body: "b", responseType: "int" }), /response_type|responseType/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/notifications.test.js`
Expected: FAIL — cannot find module `../src/notifications.js`.

- [ ] **Step 3: Write minimal implementation**

```javascript
// src/notifications.js

// Faithful to thinx-device-api messenger.js and THiNXLib32.cpp:
// a notification with no truthy `response` is "from device" (an echo of our
// own emit looping back); one with a defined, non-false `response` is a reply
// aimed at the device.

const EMIT_RESPONSE_TYPES = new Set(["bool", "string"]);

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function classifyNotification(json) {
  if (!isPlainObject(json)) {
    return undefined;
  }
  if (isPlainObject(json.notification)) {
    const n = json.notification;
    const hasResponse = n.response !== undefined && n.response !== false;
    if (!hasResponse) {
      return { kind: "echo" };
    }
    return {
      kind: "response",
      responseType: n.response_type,
      response: n.response,
      nid: n.nid,
      via: "notification"
    };
  }
  if (json.nid !== undefined && json.reply !== undefined) {
    return { kind: "response", responseType: undefined, response: json.reply, nid: json.nid, via: "reply" };
  }
  return undefined;
}

export function isApproval(responseType, response) {
  const type = String(responseType || "").toLowerCase();
  if (type === "bool" || type === "boolean") {
    if (response === true) return true;
    if (response === false) return false;
    return undefined;
  }
  if (type === "string") {
    if (response === "yes") return true;
    if (response === "no") return false;
    return undefined;
  }
  return undefined;
}

export function buildNotificationPayload({ title, body, responseType = "bool" } = {}) {
  if (typeof body !== "string" || body.trim() === "") {
    throw new Error("notification body must be a non-empty string");
  }
  if (!EMIT_RESPONSE_TYPES.has(responseType)) {
    throw new Error(`notification response_type must be one of ${[...EMIT_RESPONSE_TYPES].join(", ")}`);
  }
  const notification = { body, response_type: responseType };
  if (typeof title === "string" && title.length > 0) {
    notification.title = title;
  }
  return { notification };
}
```

Note: `buildNotificationPayload` builds keys in `{ body, response_type, title? }` insertion order; the test uses `assert.deepEqual`, which ignores key order.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/notifications.test.js`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add src/notifications.js test/notifications.test.js
git commit -m "feat: pure notifications module (classify/approval/payload)"
```

---

### Task 2: Emit — `publishNotification` on the client

**Files:**
- Modify: `src/thinx-device-client.js` (add import of `./notifications.js`; add `publishNotification` method near `publishStatus` ~line 925; add `notifications` block in `safeState` ~line 1313)
- Test: `test/thinx-device-client.test.js` (append)

**Interfaces:**
- Consumes: `buildNotificationPayload` from Task 1; existing `this.mqttClient`, `this.mqttConnected`, `this.deviceChannel`, `this.saveState()`.
- Produces:
  - `ThinxDeviceClient.publishNotification({ title, body, responseType = "bool", retain = false })` → `{ topic, payload, outstanding }`; throws `"MQTT is not connected."` when offline.
  - `this.state.outstandingNotification` = `{ title, body, responseType, topic, publishedAt, done: false }`.
  - `safeState().notifications` = `{ outstanding, lastResponse, responseCount }`.

- [ ] **Step 1: Write the failing test**

```javascript
// Append to test/thinx-device-client.test.js. OWNER/UDID and fakeMqtt() already
// exist in this file; reuse them.

test("publishNotification emits an actionable payload to the device channel and records it", async () => {
  const statePath = tempPath("state.json");
  const mqttConnect = fakeMqtt();
  const client = new ThinxDeviceClient({
    statePath,
    apiKey: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    ownerId: OWNER,
    mqttConnect
  });
  client.state.ownerId = OWNER;
  client.state.udid = UDID;
  await client.connectMqtt({ autoRegister: false });
  const [mqttClient] = mqttConnect.clients;
  mqttClient.published.length = 0; // drop the retained "connected" status

  const result = client.publishNotification({ title: "Hi", body: "Update now?", responseType: "bool" });

  assert.equal(result.topic, `/${OWNER}/${UDID}`);
  const sent = mqttClient.published.find((p) => p.topic === `/${OWNER}/${UDID}`);
  assert.ok(sent, "published to device channel");
  assert.deepEqual(JSON.parse(sent.payload), {
    notification: { body: "Update now?", response_type: "bool", title: "Hi" }
  });
  assert.equal(sent.opts.retain, false);
  assert.equal(client.safeState().notifications.outstanding.body, "Update now?");
});

test("publishNotification throws when MQTT is not connected", () => {
  const client = new ThinxDeviceClient({
    statePath: tempPath("state.json"),
    apiKey: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    ownerId: OWNER
  });
  client.state.ownerId = OWNER;
  client.state.udid = UDID;
  assert.throws(() => client.publishNotification({ body: "x" }), /MQTT is not connected/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/thinx-device-client.test.js`
Expected: FAIL — `client.publishNotification is not a function`.

- [ ] **Step 3: Write minimal implementation**

Add the import at the top of `src/thinx-device-client.js` (next to the other local imports, ~line 11):

```javascript
import { classifyNotification, isApproval, buildNotificationPayload } from "./notifications.js";
```

Add the method immediately after `publishStatus` (before `disconnectMqtt`, ~line 940):

```javascript
  publishNotification({ title, body, responseType = "bool", retain = false } = {}) {
    if (!this.mqttClient || !this.mqttConnected) {
      throw new Error("MQTT is not connected.");
    }
    const topic = this.deviceChannel;
    const payload = JSON.stringify(buildNotificationPayload({ title, body, responseType }));
    this.mqttClient.publish(topic, payload, { qos: 0, retain: Boolean(retain) });
    this.state.outstandingNotification = {
      title: typeof title === "string" && title.length > 0 ? title : undefined,
      body,
      responseType,
      topic,
      publishedAt: new Date().toISOString(),
      done: false
    };
    this.saveState();
    this.emit("notification-published", { topic, outstanding: this.state.outstandingNotification });
    return { topic, payload, outstanding: this.state.outstandingNotification };
  }
```

Add the `notifications` block to the object returned by `safeState()` (anywhere among the returned keys, e.g. after `lastFirmwareDownload`):

```javascript
      notifications: {
        outstanding: this.state.outstandingNotification || null,
        lastResponse: this.state.lastNotificationResponse || null,
        responseCount: (this.state.notificationResponses || []).length
      },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/thinx-device-client.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/thinx-device-client.js test/thinx-device-client.test.js
git commit -m "feat: publishNotification emits actionable notifications"
```

---

### Task 3: MCP tool `thinx_publish_notification`

**Files:**
- Modify: `src/mcp-server.js` (add tool definition to the `tools` array ~line 98 after `thinx_publish_status`; add a `case` in `handleToolCall` ~line 231; add stderr logging in `run()` ~line 355)
- Test: `test/command-client.test.js` or a new assertion in an existing MCP-server test if one exists; otherwise a focused unit test of the handler.

**Interfaces:**
- Consumes: `ThinxDeviceClient.publishNotification` from Task 2.
- Produces: MCP tool `thinx_publish_notification` with inputSchema `{ body (required string), title (string), responseType (enum ["bool","string"]), retain (boolean) }`.

- [ ] **Step 1: Write the failing test**

```javascript
// test/mcp-notification-tool.test.js
import assert from "node:assert/strict";
import { test } from "node:test";

import { McpJsonRpcServer } from "../src/mcp-server.js";

function fakeClient() {
  return {
    calls: [],
    on() {},
    publishNotification(args) {
      this.calls.push(args);
      return { topic: "/o/u", payload: "{}", outstanding: { body: args.body } };
    }
  };
}

test("tools/list includes thinx_publish_notification with the expected schema", async () => {
  const client = fakeClient();
  const outputs = [];
  const server = new McpJsonRpcServer({ client, output: { write: (s) => outputs.push(JSON.parse(s)) } });
  await server.handleRequest({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  const tool = outputs[0].result.tools.find((t) => t.name === "thinx_publish_notification");
  assert.ok(tool, "tool present");
  assert.deepEqual(tool.inputSchema.required, ["body"]);
  assert.deepEqual(tool.inputSchema.properties.responseType.enum, ["bool", "string"]);
});

test("tools/call thinx_publish_notification forwards args to the client", async () => {
  const client = fakeClient();
  const outputs = [];
  const server = new McpJsonRpcServer({ client, output: { write: (s) => outputs.push(JSON.parse(s)) } });
  await server.handleRequest({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: { name: "thinx_publish_notification", arguments: { body: "Update now?", responseType: "bool" } }
  });
  assert.deepEqual(client.calls[0], { body: "Update now?", responseType: "bool" });
  assert.equal(outputs[0].result.isError ?? false, false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/mcp-notification-tool.test.js`
Expected: FAIL — tool not found / handler returns "Unknown tool".

- [ ] **Step 3: Write minimal implementation**

In `src/mcp-server.js`, add to the `tools` array right after the `thinx_publish_status` tool (closing `}),` ~line 98):

```javascript
  tool(
    "thinx_publish_notification",
    "Publish an actionable notification to the device channel /owner/udid as a real THiNX device would. The THiNX cloud/console shows it with action buttons; the user's response comes back on the same channel. Emits { notification: { title?, body, response_type } } with no response field.",
    {
      type: "object",
      additionalProperties: false,
      required: ["body"],
      properties: {
        body: { type: "string", description: "Notification body text shown to the user." },
        title: { type: "string", description: "Optional title (cosmetic; the console overrides it with \"Device Interaction\")." },
        responseType: {
          type: "string",
          enum: ["bool", "string"],
          description: "Expected response type. bool → true/false; string → \"yes\"/\"no\". Defaults to bool."
        },
        retain: { type: "boolean", description: "Retain the MQTT message. Defaults to false (a retained actionable would re-fire on reconnect)." }
      }
    }
  ),
```

Add a `case` to `handleToolCall` (after the `thinx_publish_status` case ~line 231):

```javascript
      case "thinx_publish_notification":
        return textResult(this.client.publishNotification(args));
```

Add stderr logging in `run()` next to the other `this.client.on(...)` handlers (~line 357):

```javascript
    this.client.on("notification-published", (info) => {
      process.stderr.write(`[thinx-mcp-device] notification published on ${info.topic}: ${info.outstanding?.body ?? ""}\n`);
    });

    this.client.on("notification-response", (info) => {
      process.stderr.write(`[thinx-mcp-device] notification response (${info.via}) approved=${info.approved}: ${JSON.stringify(info.response)}\n`);
    });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/mcp-notification-tool.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/mcp-server.js test/mcp-notification-tool.test.js
git commit -m "feat: thinx_publish_notification MCP tool"
```

---

### Task 4: Receive — classify responses in the MQTT message handler

**Files:**
- Modify: `src/thinx-device-client.js` — the `client.on("message", ...)` handler in `connectMqttOnce` (~lines 762-792), adding a notification-response branch after the existing `cmd` block; add a `recordNotificationResponse(...)` helper method.
- Test: `test/thinx-device-client.test.js` (append)

**Interfaces:**
- Consumes: `classifyNotification`, `isApproval` from Task 1; existing message handler locals (`topic`, `message.json`, `packet`).
- Produces:
  - `ThinxDeviceClient.recordNotificationResponse(classified)` → pushes `{ responseType, response, approved, nid, via, receivedAt }` onto `this.state.notificationResponses` (bounded to 10), sets `this.state.lastNotificationResponse`, marks `this.state.outstandingNotification.done = true` if present, `saveState()`, emits `"notification-response"`. Returns the recorded entry.
  - `this.state.notificationResponses` (array, ≤10), `this.state.lastNotificationResponse`.

This task records and surfaces responses; the OTA-approval mirror is added in Task 5 so each task has an independently testable deliverable.

- [ ] **Step 1: Write the failing test**

```javascript
test("records a notification response received on the device channel, ignores echo and retained", async () => {
  const statePath = tempPath("state.json");
  const mqttConnect = fakeMqtt();
  const client = new ThinxDeviceClient({
    statePath,
    apiKey: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    ownerId: OWNER,
    mqttConnect
  });
  client.state.ownerId = OWNER;
  client.state.udid = UDID;
  await client.connectMqtt({ autoRegister: false });
  const [mqttClient] = mqttConnect.clients;
  const channel = `/${OWNER}/${UDID}`;

  const events = [];
  client.on("notification-response", (e) => events.push(e));

  // echo of our own emit: no truthy response → ignored
  mqttClient.emit("message", channel, Buffer.from(JSON.stringify({ notification: { body: "Update?", response_type: "bool" } })), { retain: false });
  // retained response → ignored
  mqttClient.emit("message", channel, Buffer.from(JSON.stringify({ notification: { response_type: "bool", response: true } })), { retain: true });
  assert.equal(events.length, 0, "echo and retained produce no response");

  // real response
  mqttClient.emit("message", channel, Buffer.from(JSON.stringify({ notification: { nid: "nid-1", response_type: "string", response: "yes" } })), { retain: false });
  assert.equal(events.length, 1);
  assert.equal(events[0].approved, true);
  assert.equal(events[0].via, "notification");
  const state = client.safeState();
  assert.equal(state.notifications.lastResponse.response, "yes");
  assert.equal(state.notifications.responseCount, 1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/thinx-device-client.test.js`
Expected: FAIL — `events.length` is 0 after the real response (handler not implemented).

- [ ] **Step 3: Write minimal implementation**

Add the helper method to `ThinxDeviceClient` (near `publishNotification`):

```javascript
  recordNotificationResponse(classified) {
    const approved = isApproval(classified.responseType, classified.response);
    const entry = {
      responseType: classified.responseType,
      response: classified.response,
      approved,
      nid: classified.nid,
      via: classified.via,
      receivedAt: new Date().toISOString()
    };
    this.state.notificationResponses = [...(this.state.notificationResponses || []), entry].slice(-10);
    this.state.lastNotificationResponse = entry;
    if (this.state.outstandingNotification) {
      this.state.outstandingNotification.done = true;
    }
    this.saveState();
    this.emit("notification-response", entry);
    return entry;
  }
```

In the `client.on("message", ...)` handler, after the existing `cmd` block (after the `if (topic === this.deviceChannel && !packet?.retain && ... cmd ...)` block, ~line 791), add:

```javascript
        // Actionable-notification response on the device channel. Retained
        // messages are skipped so a stored reply does not replay on reconnect;
        // our own emitted notification loops back as an "echo" and is ignored.
        if (topic === this.deviceChannel && !packet?.retain && message.json) {
          const classified = classifyNotification(message.json);
          if (classified && classified.kind === "response") {
            this.recordNotificationResponse(classified);
          }
        }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/thinx-device-client.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/thinx-device-client.js test/thinx-device-client.test.js
git commit -m "feat: record actionable-notification responses from the device channel"
```

---

### Task 5: OTA-approval mirror

**Files:**
- Modify: `src/thinx-device-client.js` — extend `recordNotificationResponse` (from Task 4) to trigger the existing firmware download on an approval when an update is pending.
- Test: `test/thinx-device-client.test.js` (append)

**Interfaces:**
- Consumes: `recordNotificationResponse` (Task 4), existing `this.state.pendingUpdate`, `this.config.autoDownloadFirmware`, `this.handleFirmwareUpdate(...)`.
- Produces: no new public symbol; on an approval (`approved === true`) with `this.state.pendingUpdate?.ott` and auto-download enabled, calls `this.handleFirmwareUpdate({ ott, version, status }, "notification")` non-blocking (`.catch` → `emit("firmware-error")`).

- [ ] **Step 1: Write the failing test**

```javascript
test("an approval with a pending update triggers the firmware download; denial and no-pending do not", async () => {
  const statePath = tempPath("state.json");
  const mqttConnect = fakeMqtt();
  const downloads = [];
  const client = new ThinxDeviceClient({
    statePath,
    apiKey: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    ownerId: OWNER,
    mqttConnect
  });
  client.state.ownerId = OWNER;
  client.state.udid = UDID;
  // Stub the download path so the test does not hit the network.
  client.handleFirmwareUpdate = async (update, source) => { downloads.push({ update, source }); return { stubbed: true }; };
  await client.connectMqtt({ autoRegister: false });
  const [mqttClient] = mqttConnect.clients;
  const channel = `/${OWNER}/${UDID}`;

  // approval but no pending update → no download
  mqttClient.emit("message", channel, Buffer.from(JSON.stringify({ notification: { response_type: "bool", response: true } })), { retain: false });
  await new Promise((r) => setImmediate(r));
  assert.equal(downloads.length, 0, "no pending update → no download");

  // pending update present, approval → download
  client.state.pendingUpdate = { ott: "ott-token-123456", version: "1.2.3", status: "FIRMWARE_UPDATE" };
  mqttClient.emit("message", channel, Buffer.from(JSON.stringify({ notification: { response_type: "bool", response: true } })), { retain: false });
  await new Promise((r) => setImmediate(r));
  assert.equal(downloads.length, 1, "approval + pending → download");
  assert.equal(downloads[0].source, "notification");
  assert.equal(downloads[0].update.ott, "ott-token-123456");

  // pending update present, denial → no further download
  mqttClient.emit("message", channel, Buffer.from(JSON.stringify({ notification: { response_type: "bool", response: false } })), { retain: false });
  await new Promise((r) => setImmediate(r));
  assert.equal(downloads.length, 1, "denial → no extra download");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/thinx-device-client.test.js`
Expected: FAIL — `downloads.length` is 0 after the approval-with-pending case.

- [ ] **Step 3: Write minimal implementation**

Extend `recordNotificationResponse` — just before `return entry;`, add the OTA mirror:

```javascript
    // OTA mirror (faithful to THiNXLib32 NOTIFICATION case): an approval of a
    // pending firmware update triggers the existing download. Nothing else runs.
    const autoDownload = this.config.autoDownloadFirmware;
    if (approved === true && autoDownload && this.state.pendingUpdate?.ott) {
      const { ott, version, status } = this.state.pendingUpdate;
      this.handleFirmwareUpdate({ ott, version, status }, "notification").catch((error) =>
        this.emit("firmware-error", error)
      );
    }
```

Note: `handleFirmwareUpdate` already guards re-downloads and resolves the pending OTT; passing an object with `ott` makes `extractFirmwareUpdate` inside it recognize the update (it requires `ott.length > 5`).

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/thinx-device-client.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/thinx-device-client.js test/thinx-device-client.test.js
git commit -m "feat: mirror OTA approval from notification response"
```

---

### Task 6: README documentation + full suite

**Files:**
- Modify: `README.md` (add an "Actionable notifications" section documenting the tool and the emit/response contract)
- No new test file; this task's gate is the whole suite passing.

**Interfaces:**
- Consumes: everything from Tasks 1-5.
- Produces: documentation only.

- [ ] **Step 1: Add the README section**

Add a section under the tools documentation describing:

```markdown
## Actionable notifications

A real THiNX device can raise an *actionable notification* — a prompt the
THiNX cloud/console shows with action buttons (Yes/No). The emulator mirrors
both device-side halves.

### Emit — `thinx_publish_notification`

Publishes to the device channel `/<owner>/<udid>`:

    { "notification": { "title": "<optional>", "body": "<text>", "response_type": "bool" } }

- `response_type` is `bool` (true/false) or `string` ("yes"/"no").
- No `response` field is sent, so the API classifies it as *from device* and
  shows it to the owner's console/app over its WebSocket channel.
- `retain` defaults to false; a retained actionable would re-fire on reconnect.

Requires an active MQTT connection (run `thinx_register` / `thinx_connect_mqtt`
first).

### Response

When the user responds, the cloud publishes the reply back on the same
channel. The emulator recognizes two shapes:

    { "notification": { "nid": "<id>", "response_type": "bool", "response": true } }   # primary
    { "nid": "nid:<udid>", "reply": <value> }                                          # HTTP-route shape

Responses are recorded and surfaced under `notifications` in `thinx_status`
(and as raw messages in `thinx_recent_messages`). Faithful to the device
firmware, an approval (`bool` true / `string` "yes") of a **pending firmware
update** triggers the emulator's firmware download; nothing else runs.
The emulator ignores its own emitted notification looping back, and ignores
retained responses on reconnect.
```

- [ ] **Step 2: Run the full test suite**

Run: `npm test`
Expected: PASS — all files (`command-*`, `thinx-device-client`, `notifications`, `mcp-notification-tool`).

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: document actionable notifications"
```

---

## Self-Review

**1. Spec coverage:**
- Emit contract / `publishNotification` / tool → Tasks 2, 3. ✓
- `notifications.js` pure functions (`classifyNotification`, `isApproval`, `buildNotificationPayload`) → Task 1. ✓
- Receive/classify + both response shapes → Task 4 (test covers `via:"notification"`; `{nid,reply}` covered in Task 1's classify test; the handler path is shape-agnostic since it keys off `kind:"response"`). ✓
- OTA mirror → Task 5. ✓
- Observability (`safeState.notifications`, stderr logging) → Tasks 2 (state) + 3 (logging). ✓
- Loopback-echo guard → Tasks 1 (classify) + 4 (handler test). ✓
- Retained-response guard → Task 4 (test). ✓
- Approval-without-pending → Task 5 (test). ✓
- Malformed response_type → Tasks 1 + 5 (record-only). ✓
- Docs → Task 6. ✓

**2. Placeholder scan:** No TBD/TODO/"handle edge cases"; all steps carry real code. ✓

**3. Type consistency:** `publishNotification`, `recordNotificationResponse`, `classifyNotification`, `isApproval`, `buildNotificationPayload`, and the `{ kind, responseType, response, nid, via }` / `{ outstanding, lastResponse, responseCount }` shapes are named identically across Tasks 1-5. ✓

**4. Review Focus:** All five lines have owning-task tests (echo, retained, approval-without-pending, malformed type, bad body). ✓
