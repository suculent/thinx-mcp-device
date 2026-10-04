# THiNX MCP Device

Simple MCP stdio server that acts like a THiNX device client:

- includes the public test `apikey` and `owner_id` from the ESP32 example `.ino` file
- still supports reading credentials from the `.ino` file as a fallback
- calls THiNX registration using the firmware-compatible `registration` body
- stores the returned UDID in `.thinx-device-state.json`
- connects to MQTT with `username = udid` and `password = api_key`
- subscribes to `/<owner>/<udid>` and `/<owner>/<udid>/#`
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

- `thinx_register`: POSTs to THiNX registration and saves the returned UDID.
- `thinx_connect_mqtt`: connects MQTT and starts listening.
- `thinx_status`: shows redacted API key, UDID, topics, and connection state.
- `thinx_recent_messages`: returns received MQTT messages buffered by the server.
- `thinx_publish_status`: publishes to `/<owner>/<udid>/status`.
- `thinx_disconnect_mqtt`: closes MQTT.
- `thinx_login`: logs in as the device owner and caches a session token.
- `thinx_get_environment`: inspects the device's environment variables via `POST /api/v2/device`.
- `thinx_set_environment`: sets environment variables via `PUT /api/v2/device` (merges by default).

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
```

Set `THINX_API_PORT=7443` if you need to target an older THiNX deployment that still exposes the firmware-era API port.
