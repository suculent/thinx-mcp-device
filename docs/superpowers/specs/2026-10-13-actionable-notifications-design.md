# Actionable Notifications — Design

Date: 2026-10-13
Status: Approved (pending implementation plan)
Repo: `thinx-mcp-device` (THiNX device emulator exposed as an MCP server)

## Intent

Give the emulated THiNX device the two device-side halves of the THiNX
*actionable notification* round-trip:

1. **Emit** an actionable notification (so the THiNX cloud/console/app can show
   it with action buttons), and
2. **Receive, parse, and act on** the user's response that comes back from the
   cloud.

The emulator must be **faithful to the contract that works end-to-end today**
with `thinx-device-api` and a real device — it is not a place to invent a new
protocol. "Act on the response" means: always record/surface it, and
faithfully mirror the one real behavior a device has today (approve/deny a
pending firmware update). No arbitrary code execution is introduced.

Success criteria:

- With the live API running, a `thinx_publish_notification` call produces an
  `actionable` card for the owner's console/app (via the API's
  `processActionableNotification` → WebSocket path).
- A response published back to the device channel is recorded, surfaced in
  `thinx_status` / `thinx_recent_messages`, and — when it approves a pending
  update — triggers the emulator's existing firmware download.
- The emulator never mistakes its own emitted notification (loopback) or a
  retained message for a fresh response.

## The contract (verified against sources)

### Topics

Device base channel: `/<owner>/<udid>` (the client's `this.deviceChannel`).
The device publishes to and is subscribed to this channel; the API's per-owner
MQTT client is subscribed to `/<owner>/#` and ingests it.

### Emit (device → cloud), from `messenger.js processActionableNotification`

The API reads only `notification.body` and `notification.response_type`, and
treats a message as **from device** when `notification.response` is `undefined`
or `false`. The console title is hardcoded ("Device Interaction"), so a
device-supplied `title` is cosmetic but allowed.

Emit payload, published to `/<owner>/<udid>`:

```json
{ "notification": { "title": "<optional>", "body": "<string>", "response_type": "bool" } }
```

- No `response` field (so the API classifies it as from-device).
- `response_type` ∈ `{ "bool", "string" }` (the firmware accepts
  `bool`/`boolean` and `string`/`String`).

### Response (cloud → device)

Primary faithful shape the device receives over MQTT — what the console
publishes to `/<owner>/<udid>`, matching the firmware's `parse()` NOTIFICATION
case:

```json
{ "notification": { "nid": "<id>", "response_type": "bool", "response": true } }
```

Secondary shape — the HTTP route `POST /api/v2/device/notification { udid, reply }`
emits via `Messenger.publish`:

```json
{ "nid": "nid:<udid>", "reply": <value> }
```

The emulator tolerates both; the `notification` wrapper is primary.

### Approval semantics (faithful to firmware `THiNXLib32.cpp` NOTIFICATION case)

- `response_type` `bool`/`boolean`: approved iff `response === true`.
- `response_type` `string`/`String`: `"yes"` → approved, `"no"` → denied.
- Anything else → unrecognized (record only).

## Architecture (Approach B: pure module + thin client wiring)

Matches the repo's existing seam — pure decision logic in a module
(`command-policy.js`), stateful orchestration in `ThinxDeviceClient`.

### `src/notifications.js` (pure, no state, no I/O)

- `classifyNotification(json)` → one of:
  - `{ kind: "response", responseType, response, nid, via: "notification" }`
    when `json.notification` is an object with a defined, non-`false`
    `response`;
  - `{ kind: "response", response, nid, via: "reply" }` when the message is
    `{ nid, reply }`;
  - `{ kind: "echo" }` when `json.notification` exists but has no truthy
    `response` (our own emitted notification looping back);
  - `undefined` when it is not a notification.
- `isApproval(responseType, response)` → `true` / `false` / `undefined`.
- `buildNotificationPayload({ title, body, responseType = "bool" })` →
  `{ notification: { ...(title ? { title } : {}), body, response_type } }`.
  Validates `body` is a non-empty string and `responseType ∈ { bool, string }`;
  never emits a `response` field.

### `ThinxDeviceClient` additions (`src/thinx-device-client.js`)

Emit:

- `publishNotification({ title, body, responseType = "bool", retain = false })`:
  - requires MQTT connected (throws like `publishStatus`);
  - publishes `buildNotificationPayload(...)` to `this.deviceChannel`, QoS 0,
    `retain` default **false** (a retained actionable would re-fire on every
    reconnect);
  - records `state.outstandingNotification = { title, body, responseType,
    topic, publishedAt }` (one outstanding at a time — matches the server's
    one-NID-per-device), `saveState()`, emits `"notification-published"`;
  - returns `{ topic, payload, outstanding }`.

Receive — in the existing `client.on("message")` handler in
`connectMqttOnce`, after the firmware-update and `cmd` blocks, with the same
guards (`topic === this.deviceChannel`, `message.json` present,
`!packet?.retain`):

- `classifyNotification(message.json)`:
  - `echo` → ignore;
  - `response` →
    1. push `{ responseType, response, approved, nid, via, receivedAt }` onto a
       bounded `state.notificationResponses` (last 10), set
       `state.lastNotificationResponse`, mark
       `state.outstandingNotification.done = true` if present, `saveState()`;
    2. emit `"notification-response"`;
    3. OTA mirror: if `isApproval(...) === true` **and**
       `state.pendingUpdate?.ott`, call the existing `handleFirmwareUpdate` /
       `downloadFirmware` non-blocking with `{ autoDownload: true }`
       (`.catch` → `emit("firmware-error")`). The approval is the user's
       explicit consent, so it **overrides auto-update-off**: when new firmware
       is available the update is deferred to the user, who confirms a safe
       window, and that confirmation must download regardless of the
       `autoDownloadFirmware` flag. Denial or unrecognized → record only.
  - `undefined` → leave for existing handlers.

### Observability

- `safeState()` gains a `notifications` block:
  `{ outstanding, lastResponse, responseCount }` (surfaced by `thinx_status`;
  raw payloads remain in `thinx_recent_messages`).
- `mcp-server.js` logs `notification-published` and `notification-response` to
  `process.stderr`, matching the existing `command-run` / `firmware-downloaded`
  style.

### MCP tool

`thinx_publish_notification`:

- `body` (required string), `title` (optional string),
  `responseType` (enum `["bool", "string"]`, default `"bool"`),
  `retain` (optional bool, default false);
- `mcp-server.js` → `client.publishNotification(args)`.

## Testing (node --test, existing harness)

- `test/notifications.test.js` (pure module): `classifyNotification` (echo /
  `notification`-wrapper response / `{nid,reply}` response / non-notification),
  `isApproval` (bool true/false, string yes/no, unknown → undefined),
  `buildNotificationPayload` (shape, default `responseType`, omits `response`,
  validation errors).
- Extend `test/thinx-device-client.test.js` with the existing `fakeMqtt()`:
  emit publishes the correct payload to the device channel + records
  `outstanding`; an inbound response records it, clears outstanding, emits the
  event; an approval with a pending update triggers `downloadFirmware`
  (injected `fetch` fake); own-echo ignored; retained response ignored.

## Out of scope (YAGNI)

- Generic multi-action model (named action buttons / action ids) — the real
  contract is bool/string only.
- APNs/FCM — not implemented anywhere in the stack; delivery to apps is the
  API's WebSocket path.
- Multiple concurrent outstanding notifications; channel override.
- Any change to `thinx-device-api`, `eav-app-ios`, or `thinx-eav-firmware` —
  this work is confined to the emulator.
