import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Falls back to the Arduino example bundled in this repo. Override with the
// THINX_EXAMPLE_INO environment variable (see thinx-device-client.js).
export const DEFAULT_INO_PATH = path.resolve(
  __dirname,
  "../docs/thinx-firmware-esp32/examples/thinx-esp32-example/thinx-esp32-example.ino"
);

const CONSTANT_NAMES = {
  apiKey: ["apikey", "api_key", "THINX_API_KEY"],
  ownerId: ["owner_id", "owner", "THINX_OWNER"],
  ssid: ["ssid", "THINX_ENV_SSID"],
  password: ["pass", "password", "THINX_ENV_PASS"]
};

function decodeCString(raw) {
  try {
    return JSON.parse(`"${raw}"`);
  } catch {
    return raw;
  }
}

export function extractArduinoStringConstant(source, names) {
  for (const name of names) {
    const pattern = new RegExp(
      `(?:const\\s+)?(?:char\\s*\\*\\s*|String\\s+)${name}\\s*=\\s*"((?:\\\\.|[^"\\\\])*)"\\s*;`
    );
    const match = source.match(pattern);
    if (match) {
      return decodeCString(match[1]);
    }
  }
  return undefined;
}

export function readInoCredentials(inoPath = DEFAULT_INO_PATH) {
  if (!inoPath || !fs.existsSync(inoPath)) {
    return {
      source: inoPath,
      apiKey: undefined,
      ownerId: undefined,
      ssid: undefined,
      password: undefined
    };
  }

  const source = fs.readFileSync(inoPath, "utf8");
  return {
    source: inoPath,
    apiKey: extractArduinoStringConstant(source, CONSTANT_NAMES.apiKey),
    ownerId: extractArduinoStringConstant(source, CONSTANT_NAMES.ownerId),
    ssid: extractArduinoStringConstant(source, CONSTANT_NAMES.ssid),
    password: extractArduinoStringConstant(source, CONSTANT_NAMES.password)
  };
}

export function redactSecret(value, visiblePrefix = 6, visibleSuffix = 4) {
  if (!value || typeof value !== "string") {
    return undefined;
  }
  if (value.length <= visiblePrefix + visibleSuffix) {
    return "*".repeat(value.length);
  }
  return `${value.slice(0, visiblePrefix)}...${value.slice(-visibleSuffix)}`;
}
