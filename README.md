# THiNX MCP Device

Simple MCP stdio server that acts like a THiNX device client:

- includes the public test `apikey` and `owner_id` from the ESP32 example `.ino` file
- still supports reading credentials from the `.ino` file as a fallback
- calls THiNX registration using the firmware-compatible `registration` body
- stores the returned UDID in `.thinx-device-state.json`
- connects to MQTT with `username = udid` and `password = api_key` automatically after each successful check-in
- subscribes to `/<owner>/<udid>` and `/<owner>/shared/#` (the topics the THiNX device ACL grants)
- identifies the device with a real interface MAC, preferring `en0`, then `eth0`, then `wlan0`

Default settings live in:

```text
./thinx-device.config.json
```

The fallback Arduino example path is:

```text
/Users/igraczech/Repositories/thinx-firmware-esp32/examples/thinx-esp32-example/thinx-esp32-example.ino
```

## Run

```bash
npm install
npm start
```

For an MCP client, use:

```json
{
  "mcpServers": {
    "thinx-device": {
      "command": "node",
      "args": ["/Users/igraczech/thinx-mcp-device/src/index.js"]
    }
  }
}
```

## Tools

- `thinx_register`: POSTs to THiNX registration, saves the returned UDID, then connects MQTT and listens (see below).
- `thinx_connect_mqtt`: connects MQTT and starts listening (registers first if needed).
- `thinx_status`: shows redacted API key, UDID, topics, and connection state.
- `thinx_recent_messages`: returns received MQTT messages buffered by the server.
- `thinx_publish_status`: publishes to `/<owner>/<udid>/status`.
- `thinx_request_ott`: requests a one-time firmware token (`POST /device/firmware {use:"ott"}`).
- `thinx_download_firmware`: downloads firmware via `GET /device/firmware?ott=…` and stores it.
- `thinx_disconnect_mqtt`: closes MQTT.
- `thinx_login`: logs in as the device owner and caches a session token.
- `thinx_get_environment`: inspects the device's environment variables via `POST /api/v2/device`.
- `thinx_set_environment`: sets environment variables via `PUT /api/v2/device` (merges by default).

### MQTT

After every successful check-in (`thinx_register` or the periodic check-in), the
device connects to the broker and listens, as THiNXLib does after registration:

- Broker `mqtt://<mqttHost>:<mqttPort>` (default `thinx.cloud:1883`). The client ID
  is the device MAC, `username` is the UDID and `password` is the device API key.
  The last will is `{"status":"disconnected"}`, retained on `/<owner>/<udid>/status`.
- On connect it subscribes to `/<owner>/<udid>` and `/<owner>/shared/#`, then
  publishes a retained `{"status":"connected"}` to `/<owner>/<udid>/status`.
- These are the topics the backend's ACL grants a device (`authorize_mqtt`):
  `/<owner>/<udid>`, `/<owner>/<udid>/status` and `/<owner>/shared/#`.
  `/<owner>/<udid>/#` is not granted. It is subscribed only with
  `thinx_connect_mqtt { "subscribeWildcard": true }`, and a refusal shows as
  `granted: false` under `subscriptions`. If the device channel itself is refused,
  the connection counts as failed.
- The backend writes the device's MQTT credentials to Redis asynchronously during
  check-in, so a first connect can be refused. The client tries 3 times, 2 s apart
  (`connectAttempts` / `retryDelayMs` on `thinx_connect_mqtt`).
- An MQTT failure never fails the registration. The `thinx_register` result carries
  an `mqtt` block (`connected`, `subscriptions`, `lastError`, or `error`).
- Later check-ins reuse the existing client, and mqtt.js reconnects it after drops
  (every 30 s). `thinx_connect_mqtt` also starts the periodic check-in
  (`checkinIntervalSeconds`, default 300).
- Received messages (except the device's own status topic) are buffered for
  `thinx_recent_messages` (last 100). A message carrying an OTT starts the firmware
  download described below.
- `thinx_disconnect_mqtt` publishes a retained `disconnected` status and closes the
  connection. The next check-in connects again, unless it passes `connectMqtt: false`.

Turn the automatic connect off with `autoConnectMqtt: false` in the config,
`THINX_AUTO_CONNECT_MQTT=false`, or `connectMqtt: false` on a single
`thinx_register` call. `thinx_status` shows `mqttConnected`, `mqttSubscriptions`
and `lastMqttError`.

### Acting as an Arduino / PlatformIO device (OTT firmware updates)

THiNX builds a single `firmware.bin` (and serves it over OTT) only for the
`arduino` and `platformio` platforms. Register with one of them:

```jsonc
// thinx_register arguments
{ "platform": "platformio", "mcu": "esp32", "firmwareVersionShort": "0.0.1" }
```

`platform` is expanded to `platformio:esp32`, the same shape THiNXLib reports,
and is saved in `.thinx-device-state.json` so the periodic check-ins keep reporting
it. You can also set it with `platform`/`mcu` in the config file or with
`THINX_PLATFORM`/`THINX_MCU`.

The binary is written to `./firmware/<udid>-<version>-<timestamp>.bin` and its
MD5 is checked against the `x-MD5` response header. The file is never flashed or
executed. `thinx_status` shows `pendingUpdate` and `lastFirmwareDownload`.

### Environment variable tools

`device.environment` is owner-pushed state, not device-reported — the device API
key cannot write it. `thinx_get_environment` and `thinx_set_environment` therefore
need an **owner session** (the device owner's THiNX account).

Preferred: set owner credentials so the server logs in and refreshes tokens
itself (THiNX owner JWTs only last ~1 hour):

```bash
THINX_OWNER_USER=...
THINX_OWNER_PASS=...
```

The env tools call `thinx_login` automatically when credentials are present and
no fresh token is cached. You can also call `thinx_login` explicitly, or pass a
ready-made token via `THINX_OWNER_TOKEN` / a `ownerToken` field in
`thinx-device.config.json` / the `ownerToken` tool argument — the owner token is
the `Authorization: Bearer …` value the THiNX console sends on its API requests.
Use `apiUrl` to point at the host that serves the console you are testing (for
example `https://console.thinx.cloud`) when it differs from the registration
`cloudUrl`.

```jsonc
// thinx_set_environment arguments
{
  "environment": { "ssid": "office-wifi", "region": "eu", "interval": "300" },
  "merge": true,                       // default; false replaces the whole object
  "apiUrl": "https://console.thinx.cloud"
}
```

## OTT firmware update test procedure

This procedure tests the backend's whole OTT path with the MCP device standing in
for an ESP32: registration as a firmware platform, build, the update offer at
check-in, OTT issue and OTT redemption.

### How the backend decides (reference)

| Step | Endpoint | Backend behaviour |
|------|----------|-------------------|
| Check-in | `POST /device/register` | When `device.auto_update` is true and `deployment.hasUpdateAvailable()` finds a build whose `version` is newer (semver) than the reported `registration.version`, the answer is `{"registration":{"status":"FIRMWARE_UPDATE","ott":"<64 hex>","version":"…","mac":"…","udid":"…"}}`. Otherwise the answer is `status: "OK"` with no `ott`. When the versions are equal, a different `env_hash` also triggers an update. |
| OTT on demand | `POST /device/firmware` `{"use":"ott","owner","udid"}` + `Authentication: <api key>` | Issues an OTT for an owned device **without** a version check. Refusals are the bare strings `OTT_API_KEY_NOT_VALID` / `no_such_device`. |
| Redemption | `GET /device/firmware?ott=<token>` | Serves `firmware.bin` as `application/octet-stream` with `Content-Length` and `x-MD5`, but only when the build envelope's platform is `arduino`, `platformio` or `pine64`. Refusals are bare strings: `OTT_UPDATE_NOT_FOUND`, `OTT_INFO_NOT_FOUND`, `OTT_UPDATE_NOT_AVAILABLE`. |
| Token lifetime | Redis `ott:<token>` | 24 h if unredeemed; capped at 1 h after the first redemption. Reuse inside that hour is allowed on purpose (THiNXLib retries). |

The MCP device does what THiNXLib32 does. It takes the `ott` from a
`FIRMWARE_UPDATE` check-in response, or from an MQTT message carrying
`registration.ott` or `update.ott`. Then it fetches `/device/firmware?ott=…`. It
saves the binary instead of flashing it.

### 0. Prerequisites

- A THiNX owner account, an API key from it, and its 64-character owner ID.
- A builder able to run the PlatformIO (or Arduino) docker build.
- `npm install` run in this repository.
- `curl` and `jq` for the owner API steps below. You can do the same steps in the
  THiNX console instead.

Shell variables used below:

```bash
export API=https://app.thinx.cloud     # owner API host (or your console host, e.g. https://console.thinx.cloud)
export THINX_CLOUD_URL=$API            # device API host used by the MCP device
export THINX_API_KEY=<device api key>
export THINX_OWNER_ID=<64-char owner id>
export THINX_OWNER_USER=<owner username>
export THINX_OWNER_PASS=<owner password>

# Owner session token for the curl steps (valid for about 1 hour; repeat when it expires)
export TOKEN=$(curl -s -X POST "$API/api/v2/login" \
  -H 'Content-Type: application/json' \
  -d "{\"username\":\"$THINX_OWNER_USER\",\"password\":\"$THINX_OWNER_PASS\"}" | jq -r .access_token)
```

The MCP server reads the same `THINX_*` variables. Start it (or restart your MCP
client) with them in its environment. To begin from a clean device identity, remove
`.thinx-device-state.json` and `./firmware/` first. The next registration then
creates a new UDID.

### 1. Register as a PlatformIO device

Call `thinx_register` with:

```json
{ "platform": "platformio", "mcu": "esp32", "firmwareVersionShort": "0.0.1", "autoDownload": false }
```

- `platform` becomes `platformio:esp32` and is saved in the state file, so later
  check-ins keep it. For an Arduino device, use `"platform": "arduino"`.
- `0.0.1` keeps the reported version below anything the builder will produce.
- `autoDownload: false` lets you watch the offer before anything is downloaded.
  Leave it out to test the automatic path (step 6a).

Expected result: `registration.status` is `"OK"` and has a `udid`. `state.platform`
is `"platformio:esp32"`. Save the UDID:

```bash
export UDID=<udid from thinx_register / thinx_status>
```

Check that the backend stored the platform:

```bash
curl -s -X POST "$API/api/v2/device" -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d "{\"udid\":\"$UDID\"}" | jq '.response // . | {platform, version, auto_update}'
```

### 2. Add and attach a firmware source

Any repository with a PlatformIO project and a `thinx.yml` works. One example is
the reference ESP32 PlatformIO firmware:

```bash
curl -s -X PUT "$API/api/v2/source" -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"alias":"mcp-ott-test","url":"https://github.com/suculent/thinx-firmware-esp32-pio","branch":"origin/master"}' | jq

# Find the new source_id
curl -s "$API/api/v2/source" -H "Authorization: Bearer $TOKEN" | jq
export SOURCE_ID=<source_id of "mcp-ott-test">

curl -s -X PUT "$API/api/v2/source/attach" -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d "{\"udid\":\"$UDID\",\"source_id\":\"$SOURCE_ID\"}" | jq
```

### 3. Enable auto-update on the device

The backend offers an update at check-in only when `device.auto_update` is true:

```bash
curl -s -X PUT "$API/api/v2/device" -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d "{\"changes\":{\"udid\":\"$UDID\",\"auto_update\":true}}" | jq
```

Step 6b (`thinx_download_firmware` with a freshly requested OTT) does **not** need
`auto_update`, because `POST /device/firmware {use:"ott"}` does no version check.

### 4. Build the firmware

```bash
curl -s -X POST "$API/api/v2/build" -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d "{\"build\":{\"udid\":\"$UDID\",\"source_id\":\"$SOURCE_ID\"}}" | jq
```

Wait for the build to finish (watch the build log in the console), then read the deployed build envelope:

```bash
curl -s -X POST "$API/api/v2/device/lastbuild" -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d "{\"udid\":\"$UDID\"}" | jq
```

Check these fields:

- `platform` is `platformio` or `arduino`. Any other value means the OTT
  redemption serves nothing.
- `version` must be newer than the version the device reports (`0.0.1`). Use it as
  `$BUILT_VERSION` below.
- `md5` is the checksum to compare the download against.

### 5. Check in and receive the update offer

Call `thinx_register` again (no arguments needed; `autoDownload: false` again if you
are following 6b first):

```json
{ "autoDownload": false }
```

Expected result:

```jsonc
{
  "registration": {
    "status": "FIRMWARE_UPDATE",
    "ott": "cccccc...cccc",        // redacted in tool output
    "version": "<BUILT_VERSION>",
    "mac": "…",
    "udid": "<UDID>"
  },
  "state": {
    "pendingUpdate": { "ott": "cccccc...cccc", "version": "<BUILT_VERSION>", "status": "FIRMWARE_UPDATE", "source": "registration" }
  }
}
```

If `status` is `"OK"` and there is no `ott`, see Troubleshooting.

### 6. Download the firmware

**6a. Automatic, like a real device.** Call `thinx_register` without
`autoDownload: false`. When the response carries an `ott`, the device downloads at
once and adds `firmwareDownload` to the result. The periodic check-in started by
`thinx_connect_mqtt` (every `checkinIntervalSeconds`, default 300) does the same.
So does an MQTT message carrying an `ott`.

**6b. Manual.** Call `thinx_download_firmware` with `{}`. It redeems the pending OTT
from step 5. With `{ "requestNew": true }`, or when nothing is pending, it first
requests a new token with `POST /device/firmware {use:"ott"}`. You can also pass a
token from elsewhere, for example `{ "ott": "<64 hex>" }`.

Expected result:

```jsonc
{
  "path": "/…/thinx-mcp-device/firmware/<UDID>-<BUILT_VERSION>-<timestamp>.bin",
  "size": 912345,
  "md5": "…",
  "expectedMd5": "…",            // x-MD5 response header
  "md5Match": true,
  "declaredLength": 912345,      // Content-Length response header
  "version": "<BUILT_VERSION>",
  "source": "pending:registration",   // or "registration", "mqtt", "request", "argument"
  "url": "https://…/device/firmware?ott=cccccc...cccc"
}
```

### 7. Verify

- `md5Match` is `true`, and `size` equals `declaredLength`.
- The file's checksum matches the build envelope: `md5 -q firmware/<file>.bin`
  (macOS) or `md5sum firmware/<file>.bin` equals `md5` from step 4.
- It is an ESP image: `xxd -l 1 firmware/<file>.bin` shows `e9`.
- `thinx_status` shows `pendingUpdate: null` and the download under
  `lastFirmwareDownload`.
- The backend log shows `[ott] issued for udid …` (step 6b) or
  `Device … has update available and enabled.` (step 5), then
  `GET request for FW update with OTT` and `Sending firmware update (<size>)`.

### 8. Repeat runs and simulated install

THiNX offers the same build at every check-in until the device reports its
version. The device does not auto-download a version it has already downloaded
(`firmwareDownload: { "skipped": true, … }`), so the MQTT check-in timer does not
fetch the binary every five minutes.

- **Simulate a successful install:** download with `{ "adoptVersion": true }` (or
  set `adoptDownloadedVersion: true` / `THINX_ADOPT_DOWNLOADED_VERSION=true` for the
  automatic path). Later check-ins report `BUILT_VERSION`, and THiNX answers `OK`
  until a newer build exists. This tests the "no update offered" branch.
- **Test the next update:** build again with a higher version, then repeat steps 4–7.
- **Start over at a low version:** call `thinx_register` with
  `{ "firmwareVersionShort": "0.0.1" }`. An adopted version is stored as
  `adoptedVersion` in `.thinx-device-state.json`. Delete it there to stop the
  override for good.

### 9. Negative cases

| Case | How | Expected |
|------|-----|----------|
| Auto-update off | `PUT /api/v2/device` with `"auto_update": false`, then `thinx_register` | `status: "OK"`, no `ott`, no download |
| Device already up to date | Report `firmwareVersionShort` ≥ built version | `status: "OK"`, no `ott` |
| Invalid token | `thinx_download_firmware` `{ "ott": "<64 random hex chars>" }` | Error `… OTT_UPDATE_NOT_FOUND`; nothing written to `./firmware` |
| Malformed token | `{ "ott": "abc123" }` | Error `… OTT_UPDATE_NOT_FOUND` (never reaches Redis) |
| Token reuse | Redeem the same `ott` twice within an hour | Both succeed (designed retry window) |
| No build yet | `thinx_download_firmware` `{ "requestNew": true }` on a device without a build | Error `… OTT_UPDATE_NOT_AVAILABLE` |
| Wrong API key | `THINX_API_KEY=<other>` then `thinx_request_ott` | Error `… OTT_API_KEY_NOT_VALID` |
| Foreign device | `thinx_request_ott` `{ "udid": "<udid of another owner>" }` | Error `… no_such_device` |

### Troubleshooting

| Symptom | Likely cause |
|---------|--------------|
| Check-in stays `OK` | `auto_update` false; build not finished or failed; built `version` not newer than the reported version (compare `lastbuild.version` with `thinx_status.reportedVersion`) |
| `Registration returned unexpected status` | The backend answered something other than `OK`/`FIRMWARE_UPDATE`; read the message for the raw response |
| `Firmware download failed … OTT_UPDATE_NOT_AVAILABLE` | No `build.json`/`.bin` in the device deploy path, or envelope platform not `arduino`/`platformio` |
| Download error mentions HTML or 404 | `THINX_CLOUD_URL` points at the console rather than the device API host, or the wrong `THINX_API_PORT` |
| TLS errors against a test server | Set `insecureTls: true` in the config or `THINX_INSECURE_TLS=1` |
| Device reports the wrong platform | An earlier `thinx_register { platform }` is saved in `.thinx-device-state.json`; register again with the right `platform` |

## Configuration

Environment overrides:

```bash
THINX_EXAMPLE_INO=/path/to/thinx-esp32-example.ino
THINX_API_KEY=...
THINX_OWNER_ID=...
THINX_OWNER_USER=...            # owner login username (env var tools)
THINX_OWNER_PASS=...            # owner login password (env var tools)
THINX_OWNER_TOKEN=...           # optional: ready-made owner JWT instead of login
THINX_API_URL=https://console.thinx.cloud
THINX_CLOUD_URL=https://app.thinx.cloud
THINX_REGISTER_PATH=/device/register
THINX_API_PORT=443
THINX_MQTT_HOST=thinx.cloud
THINX_MQTT_PORT=1883
THINX_MQTT_PROTOCOL=mqtt
THINX_DEVICE_ALIAS=thinx-mcp-device
THINX_NETWORK_INTERFACE=en0
THINX_PLATFORM=platformio       # arduino | platformio | <platform>:<mcu>
THINX_MCU=esp32
THINX_FIRMWARE_VERSION_SHORT=0.0.1
THINX_ENV_HASH=...              # optional env_hash reported at check-in
THINX_FIRMWARE_DIR=./firmware   # where OTT downloads are stored
THINX_AUTO_DOWNLOAD_FIRMWARE=true
THINX_ADOPT_DOWNLOADED_VERSION=false
THINX_AUTO_CONNECT_MQTT=true    # connect MQTT after each check-in
```

Set `THINX_API_PORT=7443` if you need to target an older THiNX deployment that still exposes the firmware-era API port.
