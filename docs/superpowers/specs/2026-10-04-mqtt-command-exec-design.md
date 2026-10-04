# MQTT command execution — design

Date: 2026-10-04
Status: approved in conversation, pending spec review

## Goal

When the emulated device receives `{"cmd": "<shell command>"}` on its MQTT
device channel, it runs the command in a sandboxed shell and publishes stdout,
stderr and the exit code. The same pipeline is exposed as an MCP tool
(`thinx_exec`) for local testing.

## Decisions

| Topic | Decision |
|---|---|
| Default backend | Long-lived Docker container, commands via `docker exec` |
| Fallback backend | Host shell, only when the operator sets `commands.mode = "host"` |
| Docker access | Docker CLI via `child_process.spawn` with argv arrays, never a shell |
| Permissions | Claude-style rules, applied in both backends |
| Reply topic | `/<owner>/shared/<udid>/console` |
| MCP tool | `thinx_exec` (returns result, never publishes) |

## Components

### `src/command-policy.js` (pure)

`evaluate(command, rules) -> { allowed: true } | { allowed: false, segment, reason }`

1. Reject constructs that cannot be checked reliably: `$(…)`, backticks,
   `<(…)`, `>(…)`, and output redirects (`>`, `>>`, `>|`). Input redirect
   `<` and `2>&1` are allowed.
2. Split into segments on `;`, `&&`, `||`, `|`, `&` and newlines (but not the `&` inside `2>&1`), respecting
   single and double quotes. Trim each segment; empty segments are ignored.
3. For each segment, in order:
   1. Built-in deny (not configurable): `rm` with recursive+force flags in any
      form (`-rf`, `-fr`, `-r -f`, `--recursive --force`) targeting `/`, `/*`,
      `~`, `.` or `..`; any `rm` with `--no-preserve-root`; `mkfs*`;
      `dd` with `of=/dev/…`; `shutdown`, `reboot`, `halt`, `poweroff`;
      the classic fork bomb `:(){ :|:& };:`.
   2. Built-in exception: `find` with `-exec`, `-execdir`, `-ok`, `-okdir` or
      `-delete` is refused even when `find *` is allowed.
   3. Configured deny rules.
   4. Allow rules (defaults unless `useDefaultAllow: false`, plus configured).
   5. No match → refused (`not in allow-list`).
4. Every segment must pass for the command to run.

Rule syntax: `foo` matches the segment `foo` exactly (whitespace-normalized);
`foo *` matches `foo` alone or `foo` followed by whitespace and anything.
A trailing `*` without a space (`foo*`) matches any segment starting with `foo`.

Default allow-list:

- exact: `whoami`, `id`, `hostname`, `pwd`, `uptime`, `date`, `env`, `printenv`
- prefix: `ls *`, `cat *`, `head *`, `tail *`, `wc *`, `grep *`, `find *`,
  `stat *`, `uname *`, `df *`, `du *`, `free *`, `ps *`, `echo *`, `which *`,
  `file *`, `md5sum *`, `sha256sum *`

### `src/command-runner.js`

`createRunner(config, { spawn }) -> { run(command), status(), close() }`

`run` resolves to
`{ stdout, stderr, exitCode, timedOut, truncated, durationMs }`.

**Docker backend**

- Start lazily on first command:
  `docker run -d --rm --name thinx-mcp-<udid8> --network none --read-only
  --tmpfs /tmp:rw,size=16m --cap-drop ALL --security-opt no-new-privileges
  --user 65534:65534 --memory 128m --pids-limit 64 [extraArgs…] <image>
  sleep infinity`
- Run: `docker exec -w /tmp <id> timeout -s KILL <secs> sh -c <command>`,
  plus a host-side kill timer (timeout + 2 s) as a backstop.
- If `exec` reports the container missing, recreate once and retry.
- `close()` runs `docker rm -f <id>`; called on MCP server shutdown.
- Docker missing or the image unavailable → `unavailable`. Never falls back
  to host mode.

**Host backend**

- `spawn("sh", ["-c", command])` with a kill timer and the same output cap.
- The child environment drops variables whose names match
  `/PASS|TOKEN|KEY|SECRET/i`.

Output is capped per stream at `maxOutputBytes`; excess sets `truncated`.

### Client integration (`thinx-device-client.js`)

- On an MQTT message with a JSON object carrying a string `cmd`:
  - accept only on the device channel `/<owner>/<udid>`;
  - ignore retained messages;
  - ignore messages on the device's own console topic;
  - queue serially (max 10 pending; beyond that reply `busy`).
- Reply on `/<owner>/shared/<udid>/console` (not retained):

```json
{ "udid": "…", "cmd": "whoami", "status": "ok", "exitCode": 0,
  "stdout": "nobody\n", "stderr": "", "timedOut": false,
  "truncated": false, "durationMs": 112, "at": "2026-10-04T…Z" }
```

`status` is one of `ok`, `refused` (with `reason`, `segment`), `disabled`,
`unavailable`, `timeout`, `busy`, `error` (with `message`, no stack).

- Each command is logged to stderr: timestamp, source (`mqtt` / `tool`),
  decision, exit code.

### MCP surface (`mcp-server.js`)

- `thinx_exec { command, dryRun? }` runs policy + runner and returns the reply
  object; `dryRun` returns only the policy decision. Never publishes.
- `thinx_status` gains a `commands` block: enabled, mode, image, container
  state, effective allow/deny rules.

## Configuration

`thinx-device.config.json`:

```json
"commands": {
  "enabled": true,
  "mode": "docker",
  "docker": {
    "image": "dhi.io/alpine-base:3.24",
    "network": "none",
    "readOnly": true,
    "user": "65534:65534",
    "memory": "128m",
    "pidsLimit": 64,
    "extraArgs": []
  },
  "allow": [],
  "deny": [],
  "useDefaultAllow": true,
  "timeoutMs": 10000,
  "maxOutputBytes": 65536
}
```

Environment overrides: `THINX_CMD_ENABLED`, `THINX_CMD_MODE`,
`THINX_CMD_IMAGE`, `THINX_CMD_ALLOW` / `THINX_CMD_DENY` (comma-separated),
`THINX_CMD_TIMEOUT_MS`. An unknown `mode` disables execution (`disabled`).

## Security notes

- `shared/#` is readable by all of the owner's devices, so command output is
  visible to them; another owned device could also publish forged console
  output. Accepted for this emulator. Tightening needs a server ACL change.
- Commands are accepted only from the device's own channel, never `shared/`.
- The policy is defense in depth; the container is the primary boundary in
  the default mode.

## Testing

- `command-policy`: table tests for allow (exact, prefix, allowed chains) and
  refusal (mixed chains, substitutions, write redirects, all `rm -rf /`
  variants even with `rm *` allowed, deny over allow, `find -exec`).
- `command-runner`: fake spawn recording argv — hardened `docker run` flags,
  `exec` form, recreate-on-missing, timeout, truncation, host mode refused
  unless configured, secret env stripping.
- Client: `cmd` on device channel → console publish; retained ignored;
  `shared/` ignored; own console topic ignored; queue limit → `busy`.
- Live: `thinx_exec` against `dhi.io/alpine-base:3.24`; one MQTT round trip
  confirming the console topic is writable.

## Documentation

README gains a "Remote commands" section: message format, reply topic and
schema, config keys and env overrides, default allow-list, rule syntax,
built-in denies, host-mode warning, and the `thinx_exec` tool.
