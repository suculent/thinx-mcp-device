import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import mqtt from "mqtt";

import { DEFAULT_INO_PATH, readInoCredentials, redactSecret } from "./credentials.js";
import { evaluateCommand, DEFAULT_ALLOW } from "./command-policy.js";
import { createCommandRunner } from "./command-runner.js";

const DEFAULT_CONFIG_PATH = fileURLToPath(new URL("../thinx-device.config.json", import.meta.url));
const DEFAULT_STATE_PATH = fileURLToPath(new URL("../.thinx-device-state.json", import.meta.url));
const DEFAULT_FIRMWARE_DIR = fileURLToPath(new URL("../firmware", import.meta.url));
const DEFAULT_NETWORK_INTERFACES = ["en0", "eth0", "wlan0"];
const DEFAULT_CHECKIN_INTERVAL_SECONDS = 300;
const DEFAULT_FIRMWARE_VERSION = "thinx-mcp-device:0.1.0";
const DEFAULT_FIRMWARE_VERSION_SHORT = "0.1.0";
const DEFAULT_APP_VERSION = "thinx-mcp-device:0.1.0";
const DEFAULT_MCU = "esp32";
// Platforms THiNX builds a single firmware.bin for and serves via OTT
// (device.js updateFromPath). Firmware reports them as "<platform>:<mcu>".
export const FIRMWARE_PLATFORMS = ["arduino", "platformio"];

// Most commands run or queued at once before new ones are refused as "busy".
const MAX_PENDING_COMMANDS = 10;

function parseBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  if (typeof value === "boolean") {
    return value;
  }
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

function normalizeRegisterPath(registerPath) {
  if (!registerPath) {
    return "/device/register";
  }
  return registerPath.startsWith("/") ? registerPath : `/${registerPath}`;
}

function normalizeBaseUrl(value) {
  const raw = value || "https://app.thinx.cloud";
  if (/^https?:\/\//i.test(raw)) {
    return raw.replace(/\/+$/, "");
  }
  return `https://${raw}`;
}

// "platformio" -> "platformio:esp32", the shape THiNXLib reports. Anything
// that already carries an MCU suffix (or is not a firmware platform) is kept.
export function normalizePlatform(platform, mcu = DEFAULT_MCU) {
  const value = String(platform || "").trim().toLowerCase();
  if (!value) {
    return undefined;
  }
  if (!value.includes(":") && FIRMWARE_PLATFORMS.includes(value)) {
    return `${value}:${String(mcu || DEFAULT_MCU).toLowerCase()}`;
  }
  return value;
}

function readJsonFile(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function usableMac(entry) {
  return entry && !entry.internal && entry.mac && entry.mac !== "00:00:00:00:00:00";
}

// Comma-separated string or array -> trimmed non-empty array.
function parseList(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === "string") return value.split(",").map((s) => s.trim()).filter(Boolean);
  return [];
}

// Remote command-execution settings (src/command-policy.js + command-runner.js).
// Docker-sandboxed and enabled by default; host mode must be chosen explicitly.
function resolveCommandsConfig(options, fileConfig) {
  const c = options.commands || fileConfig.commands || {};
  const d = c.docker || {};
  return {
    enabled: parseBoolean(options.commandsEnabled ?? process.env.THINX_CMD_ENABLED ?? c.enabled, true),
    mode: options.commandMode || process.env.THINX_CMD_MODE || c.mode || "docker",
    docker: {
      image: options.commandImage || process.env.THINX_CMD_IMAGE || d.image || "dhi.io/alpine-base:3.24",
      network: d.network || "none",
      readOnly: d.readOnly !== false,
      user: d.user || "65534:65534",
      memory: d.memory || "128m",
      pidsLimit: Number(d.pidsLimit) || 64,
      extraArgs: Array.isArray(d.extraArgs) ? d.extraArgs : []
    },
    allow: parseList(process.env.THINX_CMD_ALLOW).concat(parseList(c.allow)),
    deny: parseList(process.env.THINX_CMD_DENY).concat(parseList(c.deny)),
    useDefaultAllow: parseBoolean(c.useDefaultAllow, true),
    timeoutMs: Number(options.commandTimeoutMs || process.env.THINX_CMD_TIMEOUT_MS || c.timeoutMs) || 10000,
    maxOutputBytes: Number(c.maxOutputBytes) || 65536
  };
}

export function selectHardwareMac(interfaces = os.networkInterfaces(), preferredNames = DEFAULT_NETWORK_INTERFACES) {
  for (const name of preferredNames) {
    for (const entry of interfaces[name] || []) {
      if (usableMac(entry)) {
        return entry.mac;
      }
    }
  }

  for (const entries of Object.values(interfaces)) {
    for (const entry of entries || []) {
      if (usableMac(entry)) {
        return entry.mac;
      }
    }
  }

  return undefined;
}

function generateFallbackMac(seed = os.hostname()) {
  const digest = crypto.createHash("sha256").update(seed).digest("hex");
  return `02:${digest.slice(0, 2)}:${digest.slice(2, 4)}:${digest.slice(4, 6)}:${digest.slice(6, 8)}:${digest.slice(8, 10)}`;
}

function buildMqttUrl(config, options = {}) {
  const explicitUrl = options.mqttUrl || config.mqttUrl;
  if (explicitUrl) {
    return explicitUrl;
  }

  const host = options.mqttHost || config.mqttHost;
  const port = Number(options.mqttPort || config.mqttPort);
  const protocol = options.mqttProtocol || config.mqttProtocol || (port === 8883 ? "mqtts" : "mqtt");

  if (/^mqtts?:\/\//i.test(host)) {
    return host;
  }

  return `${protocol}://${host}:${port}`;
}

function tryJson(payload) {
  try {
    return JSON.parse(payload);
  } catch {
    return undefined;
  }
}

// Each Set-Cookie line of a fetch response. getSetCookie() keeps lines apart;
// the joined get() fallback is split only before a new `name=` pair, because
// Expires values contain commas.
function readSetCookies(headers) {
  if (typeof headers?.getSetCookie === "function") return headers.getSetCookie();
  const joined = headers?.get?.("set-cookie");
  return joined ? joined.split(/,\s*(?=[^;,=\s]+=)/) : [];
}

// THiNX sometimes wraps a rejected registration as
// { success: false, response: "<JSON string containing { registration: ... }>" }.
function unwrapRegistration(payload) {
  if (payload?.registration) {
    return payload.registration;
  }
  const inner = typeof payload?.response === "string" ? tryJson(payload.response) : payload?.response;
  return inner?.registration;
}

// THiNXLib accepts an update token from a check-in response
// ({ registration: { status: "FIRMWARE_UPDATE", ott } }) or an MQTT push of
// the same shape; `update.ott` and a bare `ott` are accepted as well.
export function extractFirmwareUpdate(payload) {
  if (!payload || typeof payload !== "object") {
    return undefined;
  }
  for (const node of [payload.registration, payload.update, payload]) {
    if (node && typeof node === "object" && typeof node.ott === "string" && node.ott.length > 5) {
      return {
        ott: node.ott,
        version: node.version,
        status: node.status,
        mac: node.mac
      };
    }
  }
  return undefined;
}

function decodeJwtExpiry(token) {
  try {
    const part = String(token).split(".")[1];
    if (!part) {
      return undefined;
    }
    const json = Buffer.from(part.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    const payload = JSON.parse(json);
    return typeof payload.exp === "number" ? payload.exp : undefined;
  } catch {
    return undefined;
  }
}

function tokenIsFresh(token, marginSeconds = 60) {
  if (!token || String(token).length < 10) {
    return false;
  }
  const exp = decodeJwtExpiry(token);
  if (exp === undefined) {
    return true; // opaque / non-JWT token — assume usable, let the API decide
  }
  return exp - Math.floor(Date.now() / 1000) > marginSeconds;
}

export class ThinxDeviceClient extends EventEmitter {
  constructor(options = {}) {
    super();
    this.options = options;
    this.statePath = options.statePath || process.env.THINX_STATE_PATH || DEFAULT_STATE_PATH;
    this.state = readJsonFile(this.statePath, {});
    this.messages = [];
    this.mqttClient = undefined;
    this.mqttConnected = false;
    this.mqttConnecting = undefined; // in-flight connectMqtt promise
    this.mqttSubscriptions = []; // active subscriptions [{ topic, granted, qos }]; empty while disconnected
    this.grantedTopics = []; // last grants, kept across a reconnect to repopulate the short-circuited resubscribe
    this.lastMqttError = undefined;
    this.mqttConnectImpl = options.mqttConnect || ((url, opts) => mqtt.connect(url, opts));
    this.checkinTimer = undefined;
    this.fetchImpl = options.fetch || ((...args) => fetch(...args));
    this.session = {}; // cached owner login: { accessToken, refreshToken, expiresAt, loggedInAt }
    // Remote command execution: lazy runner, a serial chain and an in-flight cap.
    this.spawnImpl = options.spawn;
    this.commandRunner = undefined;
    this.commandChain = Promise.resolve();
    this.pendingCommands = 0;
    this.config = this.resolveConfig(options);
  }

  resolveConfig(options = {}) {
    const inoPath = options.inoPath || process.env.THINX_EXAMPLE_INO || DEFAULT_INO_PATH;
    const configPath = options.configPath || process.env.THINX_CONFIG_PATH || DEFAULT_CONFIG_PATH;
    const fileConfig = readJsonFile(configPath, {});
    const inoCredentials = readInoCredentials(inoPath);

    const cloudUrl = options.cloudUrl || process.env.THINX_CLOUD_URL || fileConfig.cloudUrl || "https://app.thinx.cloud";
    const mqttPort = Number(options.mqttPort || process.env.THINX_MQTT_PORT || fileConfig.mqttPort || 1883);
    const networkInterfaces = options.networkInterfaces ||
      (process.env.THINX_NETWORK_INTERFACE ? [process.env.THINX_NETWORK_INTERFACE] : undefined) ||
      fileConfig.networkInterfaces ||
      DEFAULT_NETWORK_INTERFACES;

    return {
      inoPath,
      configPath,
      credentialSource: fileConfig.apiKey ? configPath : inoCredentials.source,
      apiKey: options.apiKey || process.env.THINX_API_KEY || fileConfig.apiKey || inoCredentials.apiKey,
      ownerId:
        options.ownerId ||
        process.env.THINX_OWNER_ID ||
        process.env.THINX_OWNER ||
        fileConfig.ownerId ||
        inoCredentials.ownerId,
      cloudUrl: normalizeBaseUrl(cloudUrl),
      registerPath: normalizeRegisterPath(
        options.registerPath || process.env.THINX_REGISTER_PATH || fileConfig.registerPath || "/device/register"
      ),
      mqttHost:
        options.mqttHost || process.env.THINX_MQTT_HOST || process.env.THINX_MQTT_URL || fileConfig.mqttHost || "thinx.cloud",
      mqttPort,
      mqttProtocol:
        options.mqttProtocol ||
        process.env.THINX_MQTT_PROTOCOL ||
        fileConfig.mqttProtocol ||
        (mqttPort === 8883 ? "mqtts" : "mqtt"),
      alias:
        options.alias ||
        process.env.THINX_DEVICE_ALIAS ||
        process.env.THINX_ALIAS ||
        fileConfig.alias ||
        "thinx-mcp-device",
      appVersion: options.appVersion || process.env.THINX_APP_VERSION || fileConfig.appVersion || DEFAULT_APP_VERSION,
      firmwareVersion:
        options.firmwareVersion || process.env.THINX_FIRMWARE_VERSION || fileConfig.firmwareVersion || DEFAULT_FIRMWARE_VERSION,
      firmwareVersionShort:
        options.firmwareVersionShort ||
        process.env.THINX_FIRMWARE_VERSION_SHORT ||
        fileConfig.firmwareVersionShort ||
        DEFAULT_FIRMWARE_VERSION_SHORT,
      commitId: options.commitId || process.env.THINX_COMMIT_ID || fileConfig.commitId || "0",
      mcu: options.mcu || process.env.THINX_MCU || fileConfig.mcu || DEFAULT_MCU,
      platform: options.platform || process.env.THINX_PLATFORM || fileConfig.platform || "nodejs:mcp",
      envHash: options.envHash || process.env.THINX_ENV_HASH || fileConfig.envHash,
      // OTT firmware downloads are stored here and never executed.
      firmwareDir: options.firmwareDir || process.env.THINX_FIRMWARE_DIR || fileConfig.firmwareDir || DEFAULT_FIRMWARE_DIR,
      autoDownloadFirmware: parseBoolean(
        options.autoDownloadFirmware ?? process.env.THINX_AUTO_DOWNLOAD_FIRMWARE ?? fileConfig.autoDownloadFirmware,
        true
      ),
      // Connect MQTT and listen on the device channel after every successful
      // check-in, like THiNXLib does after registration.
      autoConnectMqtt: parseBoolean(
        options.autoConnectMqtt ?? process.env.THINX_AUTO_CONNECT_MQTT ?? fileConfig.autoConnectMqtt,
        true
      ),
      adoptDownloadedVersion: parseBoolean(
        options.adoptDownloadedVersion ?? process.env.THINX_ADOPT_DOWNLOADED_VERSION ?? fileConfig.adoptDownloadedVersion,
        false
      ),
      autoUpdate: parseBoolean(options.autoUpdate ?? process.env.THINX_AUTO_UPDATE ?? fileConfig.autoUpdate, false),
      forcedUpdate: parseBoolean(options.forcedUpdate ?? process.env.THINX_FORCED_UPDATE ?? fileConfig.forcedUpdate, false),
      insecureTls: parseBoolean(options.insecureTls ?? process.env.THINX_INSECURE_TLS ?? fileConfig.insecureTls, false),
      deviceMac: options.mac || options.deviceMac || process.env.THINX_DEVICE_MAC || fileConfig.deviceMac,
      networkInterfaces,
      checkinIntervalSeconds: Number(
        options.checkinIntervalSeconds ||
          process.env.THINX_CHECKIN_INTERVAL_SECONDS ||
          fileConfig.checkinIntervalSeconds ||
          DEFAULT_CHECKIN_INTERVAL_SECONDS
      ),
      // Owner-authenticated API access (env var inspect/set). The device API
      // key cannot write device.environment — that needs an owner session JWT.
      ownerToken: options.ownerToken || process.env.THINX_OWNER_TOKEN || fileConfig.ownerToken,
      // Owner login credentials — let the server mint fresh tokens itself
      // instead of relying on a 1-hour token that has to be re-pasted.
      ownerUsername: options.ownerUsername || process.env.THINX_OWNER_USER || fileConfig.ownerUsername,
      ownerPassword: options.ownerPassword || process.env.THINX_OWNER_PASS || fileConfig.ownerPassword,
      // Base URL for the owner /api/v2 calls. Defaults to cloudUrl; override
      // when the console is served from a different host than registration.
      apiUrl: options.apiUrl || process.env.THINX_API_URL || fileConfig.apiUrl,
      // Remote command execution over MQTT / the thinx_exec tool.
      commands: resolveCommandsConfig(options, fileConfig)
    };
  }

  reloadConfig(overrides = {}) {
    this.config = this.resolveConfig({ ...this.options, ...overrides });
    return this.config;
  }

  validateCredentials() {
    if (!this.config.apiKey || this.config.apiKey.length < 5) {
      throw new Error(`THiNX API key is missing. Set THINX_API_KEY or update ${this.config.credentialSource}.`);
    }
    if (!this.config.ownerId || this.config.ownerId.length !== 64) {
      throw new Error(`THiNX owner ID must be 64 characters. Set THINX_OWNER_ID or update ${this.config.credentialSource}.`);
    }
  }

  get mac() {
    if (!this.state.mac) {
      this.state.mac =
        this.config.deviceMac ||
        selectHardwareMac(os.networkInterfaces(), this.config.networkInterfaces) ||
        generateFallbackMac();
      this.saveState();
    }
    return this.state.mac;
  }

  get ownerId() {
    return this.state.ownerId || this.config.ownerId;
  }

  get udid() {
    return this.state.udid;
  }

  get deviceChannel() {
    if (!this.ownerId || !this.udid) {
      return undefined;
    }
    return `/${this.ownerId}/${this.udid}`;
  }

  get statusChannel() {
    return this.deviceChannel ? `${this.deviceChannel}/status` : undefined;
  }

  get sharedChannel() {
    return this.ownerId ? `/${this.ownerId}/shared/#` : undefined;
  }

  // Command replies go here. Under /owner/shared/#, which authorize_mqtt grants
  // the device readwrite, so no server ACL change is needed to publish.
  get consoleChannel() {
    return this.ownerId && this.udid ? `/${this.ownerId}/shared/${this.udid}/console` : undefined;
  }

  // Topics the broker ACL grants a device (device.js authorize_mqtt):
  // /owner/udid, /owner/udid/status and /owner/shared/#. /owner/udid/# is not
  // granted; it is only added on explicit request and reported if refused.
  subscriptionTopics(overrides = {}) {
    const topics = [this.deviceChannel];
    if (overrides.subscribeShared !== false) {
      topics.push(this.sharedChannel);
    }
    if (overrides.subscribeWildcard === true) {
      topics.push(`${this.deviceChannel}/#`);
    }
    return topics;
  }

  // Platform reported at check-in: an explicit thinx_register argument is
  // persisted so periodic check-ins keep reporting it.
  get platform() {
    return normalizePlatform(this.state.platform || this.config.platform, this.state.mcu || this.config.mcu);
  }

  get reportedVersion() {
    return this.state.adoptedVersion || this.config.firmwareVersionShort;
  }

  saveState() {
    const directory = path.dirname(this.statePath);
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(`${this.statePath}.tmp`, `${JSON.stringify(this.state, null, 2)}\n`);
    fs.renameSync(`${this.statePath}.tmp`, this.statePath);
  }

  registrationBody(overrides = {}) {
    this.reloadConfig(overrides);
    this.validateCredentials();

    const registration = {
      mac: overrides.mac || this.mac,
      firmware: overrides.firmwareVersion || this.config.firmwareVersion,
      version: overrides.firmwareVersionShort || this.reportedVersion,
      commit: overrides.commitId || this.config.commitId,
      owner: overrides.ownerId || this.config.ownerId,
      alias: overrides.alias || this.state.alias || this.config.alias,
      status: overrides.status || "Registered",
      platform: overrides.platform ? normalizePlatform(overrides.platform, overrides.mcu || this.config.mcu) : this.platform,
      fcid: overrides.fcid || this.mac
    };

    if (overrides.envHash || this.config.envHash) {
      registration.env_hash = overrides.envHash || this.config.envHash;
    }

    const udid = overrides.udid || this.state.udid;
    if (udid && udid !== "0") {
      registration.udid = udid;
    }

    if (overrides.lat !== undefined && overrides.lon !== undefined) {
      registration.lat = overrides.lat;
      registration.lon = overrides.lon;
    }

    return { registration };
  }

  // Device API URL (registration, firmware) on cloudUrl with optional port.
  deviceApiUrl(pathname, overrides = {}) {
    const base = normalizeBaseUrl(overrides.cloudUrl || this.config.cloudUrl);
    const url = new URL(base);
    if (overrides.apiPort || process.env.THINX_API_PORT) {
      url.port = String(overrides.apiPort || process.env.THINX_API_PORT);
    }
    url.pathname = pathname;
    return url;
  }

  registerUrl(overrides = {}) {
    this.reloadConfig(overrides);
    return this.deviceApiUrl(normalizeRegisterPath(overrides.registerPath || this.config.registerPath), overrides);
  }

  applyTlsPolicy() {
    if (this.config.insecureTls) {
      process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
    }
  }

  deviceHeaders() {
    return {
      Authentication: this.config.apiKey,
      Accept: "application/json",
      Origin: "device",
      "Content-Type": "application/json",
      "User-Agent": "THiNX-Client"
    };
  }

  async register(overrides = {}) {
    this.reloadConfig(overrides);
    const url = this.registerUrl(overrides);
    const body = this.registrationBody(overrides);

    if (overrides.platform) {
      this.state.platform = body.registration.platform;
      this.saveState();
    }

    this.applyTlsPolicy();

    const response = await this.fetchImpl(url, {
      method: "POST",
      headers: this.deviceHeaders(),
      body: JSON.stringify(body)
    });

    const text = await response.text();
    const payload = tryJson(text);

    if (!response.ok) {
      const suffix = payload ? JSON.stringify(payload) : text;
      throw new Error(`Registration failed with HTTP ${response.status}: ${suffix}`);
    }

    if (!payload) {
      throw new Error(`Registration response was not JSON: ${text.slice(0, 500)}`);
    }

    const registration = this.applyRegistrationResponse(payload);
    this.emit("registered", registration);
    const firmwareDownload = await this.handleFirmwareUpdate(registration, "registration", overrides);
    const mqttResult = await this.connectAfterCheckin(overrides);
    return {
      url: url.toString(),
      registration: { ...registration, ...(registration.ott ? { ott: redactSecret(registration.ott) } : {}) },
      ...(firmwareDownload ? { firmwareDownload } : {}),
      ...(mqttResult ? { mqtt: mqttResult } : {}),
      state: this.safeState()
    };
  }

  applyRegistrationResponse(payload) {
    const registration = unwrapRegistration(payload);
    if (!registration || typeof registration !== "object") {
      throw new Error(`Registration response does not contain a registration object: ${JSON.stringify(payload)}`);
    }

    if (registration.success === false) {
      throw new Error(`Registration rejected by THiNX: ${JSON.stringify(registration)}`);
    }

    const status = registration.status;
    if (status && !["OK", "FIRMWARE_UPDATE"].includes(status) && registration.success !== true) {
      throw new Error(`Registration returned unexpected status: ${status}`);
    }

    if (registration.owner) {
      this.state.ownerId = registration.owner;
    } else if (this.config.ownerId) {
      this.state.ownerId = this.config.ownerId;
    }

    if (registration.alias && registration.alias !== "null") {
      this.state.alias = registration.alias;
    }

    if (registration.udid && String(registration.udid).length > 4) {
      this.state.udid = registration.udid;
    }

    if (registration.auto_update !== undefined) {
      this.state.autoUpdate = Boolean(registration.auto_update);
    }

    if (registration.forced_update !== undefined) {
      this.state.forcedUpdate = Boolean(registration.forced_update);
    }

    if (registration.timestamp) {
      this.state.lastCheckinTimestamp = registration.timestamp;
    }

    const update = extractFirmwareUpdate({ registration });
    if (update) {
      this.recordPendingUpdate(update, "registration");
    }

    this.state.lastRegistrationStatus = registration.status || (registration.success ? "OK" : undefined);
    this.state.lastRegisteredAt = new Date().toISOString();
    this.saveState();

    return registration;
  }

  async ensureRegistered(overrides = {}) {
    this.reloadConfig(overrides);
    if (this.udid && this.ownerId) {
      return {
        registration: {
          owner: this.ownerId,
          udid: this.udid,
          alias: this.state.alias,
          status: this.state.lastRegistrationStatus || "OK"
        },
        state: this.safeState()
      };
    }
    return this.register(overrides);
  }

  // Called after every successful check-in. Never throws: a broker problem
  // must not fail the registration. An existing client (connected or
  // auto-reconnecting) is left alone, so check-ins never open a second one.
  async connectAfterCheckin(overrides = {}) {
    const enabled = overrides.connectMqtt ?? this.config.autoConnectMqtt;
    if (!enabled) {
      return undefined;
    }
    if (this.mqttClient && !this.mqttConnecting) {
      return this.mqttSummary();
    }
    try {
      return await this.connectMqtt({ ...overrides, autoRegister: false });
    } catch (error) {
      return { ...this.mqttSummary(), error: error.message };
    }
  }

  async connectMqtt(overrides = {}) {
    if (this.mqttConnecting) {
      return this.mqttConnecting;
    }
    this.mqttConnecting = this.connectMqttWithRetry(overrides).finally(() => {
      this.mqttConnecting = undefined;
    });
    return this.mqttConnecting;
  }

  async connectMqttWithRetry(overrides = {}) {
    this.reloadConfig(overrides);
    this.validateCredentials();

    if (!this.udid || !this.ownerId) {
      if (overrides.autoRegister === false) {
        throw new Error("Device has no UDID yet. Call thinx_register first or allow auto_register.");
      }
      // connectMqtt: false — this call is already connecting.
      await this.register({ ...overrides, connectMqtt: false });
    }

    if (this.mqttClient && this.mqttConnected) {
      return this.mqttSummary();
    }

    // The backend writes the MQTT credentials (username = udid, password =
    // api key) to Redis asynchronously during check-in, so the first connect
    // right after a registration can be refused. Retry a few times.
    const attempts = Math.max(1, Number(overrides.connectAttempts ?? 3));
    const retryDelayMs = Number(overrides.retryDelayMs ?? 2000);
    let lastError;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        await this.connectMqttOnce(overrides);
        this.lastMqttError = undefined;
        this.startCheckinTimer();
        return this.mqttSummary();
      } catch (error) {
        lastError = error;
        this.lastMqttError = { message: error.message, attempt, at: new Date().toISOString() };
        if (attempt < attempts) {
          await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
        }
      }
    }
    throw new Error(`MQTT connection failed after ${attempts} attempt(s): ${lastError.message}`);
  }

  connectMqttOnce(overrides = {}) {
    const url = buildMqttUrl(this.config, overrides);
    const statusChannel = this.statusChannel;
    const topics = this.subscriptionTopics(overrides);

    return new Promise((resolve, reject) => {
      let settled = false;
      const client = this.mqttConnectImpl(url, {
        clientId: this.mac,
        clean: false,
        keepalive: 45,
        reconnectPeriod: Number(overrides.reconnectPeriodMs || 30000),
        connectTimeout: Number(overrides.timeoutMs || 20000),
        username: this.udid,
        password: this.config.apiKey,
        will: {
          topic: statusChannel,
          payload: JSON.stringify({ status: "disconnected" }),
          qos: 0,
          retain: true
        }
      });

      const fail = (error) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        // Drop the half-open client so it does not keep reconnecting with a
        // refused session alongside the next attempt.
        client.end(true);
        if (this.mqttClient === client) {
          this.mqttClient = undefined;
        }
        this.mqttConnected = false;
        reject(error);
      };

      const timeout = setTimeout(
        () => fail(new Error(`MQTT connection timed out for ${url}.`)),
        Number(overrides.timeoutMs || 20000)
      );

      this.mqttClient = client;

      // Runs on the first connect and on every automatic reconnect.
      client.on("connect", () => {
        this.mqttConnected = true;
        client.subscribe(topics, { qos: 0 }, (error, granted = []) => {
          if (error) {
            fail(error);
            return;
          }
          // On an automatic reconnect our repeat subscribe is short-circuited by
          // mqtt.js (the topics are already tracked for its own auto-resubscribe),
          // so it calls back with an empty granted array. Restore the grants
          // captured on the first connect instead of leaving the topics unlisted.
          // SUBACK 128 (0x80) or >= 0x80 under MQTT 5 means the ACL refused it.
          if (granted.length > 0) {
            this.mqttSubscriptions = topics.map((topic, index) => {
              // SUBACK return codes are in request order; fall back to it when the
              // broker echoes topics in a form that is not string-identical.
              const grant = granted.find((entry) => entry.topic === topic) ?? granted[index];
              const qos = grant ? grant.qos : undefined;
              return { topic, qos, granted: qos !== undefined && qos < 128 };
            });
            this.grantedTopics = this.mqttSubscriptions;
          } else {
            this.mqttSubscriptions = this.grantedTopics;
          }
          if (!this.mqttSubscriptions.find((entry) => entry.topic === this.deviceChannel)?.granted) {
            fail(new Error(`Broker refused subscription to ${this.deviceChannel}.`));
            return;
          }

          client.publish(statusChannel, JSON.stringify({ status: "connected" }), { qos: 0, retain: true });
          this.emit("mqtt-connected", this.mqttSummary());

          if (!settled) {
            settled = true;
            clearTimeout(timeout);
            resolve();
          }
        });
      });

      client.on("message", (topic, payloadBuffer, packet) => {
        const payload = payloadBuffer.toString("utf8");
        if (topic === statusChannel || topic === this.consoleChannel) {
          // Our own status / command replies, echoed back over shared/#.
          return;
        }
        const message = {
          topic,
          payload,
          json: tryJson(payload),
          retain: Boolean(packet?.retain),
          receivedAt: new Date().toISOString()
        };
        this.messages.push(message);
        this.messages = this.messages.slice(-100);
        this.emit("message", message);

        const update = extractFirmwareUpdate(message.json);
        if (update) {
          this.recordPendingUpdate(update, "mqtt");
          this.handleFirmwareUpdate(update, "mqtt").catch((error) => this.emit("firmware-error", error));
        }

        // A command is accepted only from the device's own channel and never
        // from a retained message (so an old command does not re-run on reconnect).
        if (topic === this.deviceChannel && !packet?.retain && message.json && typeof message.json.cmd === "string") {
          this.executeCommand(message.json.cmd, { source: "mqtt" })
            .then((reply) => this.publishConsole(reply))
            .catch((error) => this.emit("command-error", error));
        }
      });

      client.on("error", (error) => {
        this.lastMqttError = { message: error.message, at: new Date().toISOString() };
        this.emit("mqtt-error", error);
        fail(error);
      });

      client.on("close", () => {
        this.mqttConnected = false;
        // No active subscriptions while disconnected; grantedTopics is kept so an
        // automatic reconnect can repopulate the short-circuited resubscribe.
        this.mqttSubscriptions = [];
        this.emit("mqtt-closed");
      });
    });
  }

  // Periodic check-in, as THiNXLib does. Registration reconnects MQTT if the
  // client was dropped; an existing client reconnects on its own.
  startCheckinTimer() {
    if (this.config.checkinIntervalSeconds > 0 && !this.checkinTimer) {
      this.checkinTimer = setInterval(() => {
        this.register().catch((error) => {
          this.emit("checkin-error", error);
        });
      }, this.config.checkinIntervalSeconds * 1000);
      this.checkinTimer.unref();
    }
  }

  mqttSummary() {
    return {
      connected: this.mqttConnected,
      broker: buildMqttUrl(this.config),
      clientId: this.mac,
      username: this.udid,
      deviceChannel: this.deviceChannel,
      statusChannel: this.statusChannel,
      subscriptions: this.mqttSubscriptions,
      lastError: this.lastMqttError || null
    };
  }

  //
  // Remote command execution
  //
  // A {"cmd": "..."} message on the device channel (or a thinx_exec call) runs
  // the command through command-policy and command-runner, then replies on the
  // console channel. Commands run one at a time, in order.
  //

  getCommandRunner() {
    if (!this.commandRunner) {
      this.commandRunner = createCommandRunner(
        { ...this.config.commands, udid: this.udid },
        { spawn: this.spawnImpl }
      );
    }
    return this.commandRunner;
  }

  async closeCommandRunner() {
    if (this.commandRunner) {
      await this.commandRunner.close();
      this.commandRunner = undefined;
    }
  }

  async executeCommand(command, { source = "tool" } = {}) {
    const base = { udid: this.udid, cmd: command, source, at: new Date().toISOString() };
    const cfg = this.config.commands;
    if (!cfg.enabled) {
      return { ...base, status: "disabled", reason: "command execution is disabled" };
    }
    if (cfg.mode !== "docker" && cfg.mode !== "host") {
      return { ...base, status: "disabled", reason: `unknown command mode "${cfg.mode}"` };
    }
    const policy = evaluateCommand(command, cfg);
    if (!policy.allowed) {
      return { ...base, status: "refused", reason: policy.reason, segment: policy.segment };
    }
    if (this.pendingCommands >= MAX_PENDING_COMMANDS) {
      return { ...base, status: "busy", reason: `too many pending commands (max ${MAX_PENDING_COMMANDS})` };
    }

    this.pendingCommands++;
    const task = this.commandChain.then(() => this.getCommandRunner().run(command));
    this.commandChain = task.then(() => {}, () => {}); // keep the chain alive past failures
    let reply;
    try {
      const r = await task;
      reply = {
        ...base,
        status: r.timedOut ? "timeout" : "ok",
        exitCode: r.exitCode,
        stdout: r.stdout,
        stderr: r.stderr,
        timedOut: r.timedOut,
        truncated: r.truncated,
        durationMs: r.durationMs
      };
    } catch (err) {
      reply = (err && err.code === "DOCKER_UNAVAILABLE")
        ? { ...base, status: "unavailable", message: err.message }
        : { ...base, status: "error", message: err ? err.message : "unknown error" };
    } finally {
      this.pendingCommands--;
    }
    this.emit("command-run", reply);
    return reply;
  }

  // thinx_exec entry point: dryRun returns only the policy decision.
  async dispatchCommand(command, { dryRun = false } = {}) {
    if (typeof command !== "string" || command.trim() === "") {
      return { cmd: command, status: "refused", reason: "empty command" };
    }
    if (dryRun) {
      return { cmd: command, dryRun: true, ...evaluateCommand(command, this.config.commands) };
    }
    return this.executeCommand(command, { source: "tool" });
  }

  publishConsole(reply) {
    if (!this.mqttClient || !this.mqttConnected || !this.consoleChannel) {
      return undefined;
    }
    const payload = JSON.stringify(reply);
    this.mqttClient.publish(this.consoleChannel, payload, { qos: 0, retain: false });
    return { topic: this.consoleChannel, payload };
  }

  publishStatus(message, options = {}) {
    if (!this.mqttClient || !this.mqttConnected) {
      throw new Error("MQTT is not connected.");
    }
    const payload = typeof message === "string" ? message : JSON.stringify(message);
    this.mqttClient.publish(this.statusChannel, payload, {
      qos: 0,
      retain: options.retain !== false
    });
    return {
      topic: this.statusChannel,
      payload,
      retain: options.retain !== false
    };
  }

  disconnectMqtt() {
    if (this.checkinTimer) {
      clearInterval(this.checkinTimer);
      this.checkinTimer = undefined;
    }
    if (!this.mqttClient) {
      this.mqttConnected = false;
      return { connected: false };
    }
    // A clean disconnect suppresses the last will, so publish it ourselves;
    // end(false) flushes it before closing.
    if (this.mqttConnected && this.statusChannel) {
      this.mqttClient.publish(this.statusChannel, JSON.stringify({ status: "disconnected" }), { qos: 0, retain: true });
    }
    this.mqttClient.end(false);
    this.mqttClient = undefined;
    this.mqttConnected = false;
    // Intentional disconnect: forget subscriptions entirely (a later fresh
    // connect gets real grants from a non-short-circuited subscribe).
    this.mqttSubscriptions = [];
    this.grantedTopics = [];
    return { connected: false };
  }

  recentMessages(limit = 20) {
    return this.messages.slice(-Number(limit || 20));
  }

  //
  // OTT firmware updates
  //
  // Mirrors THiNXLib: a check-in answering status FIRMWARE_UPDATE (or an MQTT
  // push) carries a one-time token; the device fetches the binary from
  // GET /device/firmware?ott=<token>. A token can also be requested directly
  // with POST /device/firmware { use: "ott", owner, udid }. The downloaded
  // binary is only stored on disk — nothing is flashed or executed.
  //

  recordPendingUpdate(update, source) {
    this.state.pendingUpdate = {
      ott: update.ott,
      version: update.version,
      status: update.status,
      source,
      receivedAt: new Date().toISOString()
    };
    this.saveState();
    this.emit("firmware-update", { ...this.state.pendingUpdate, ott: redactSecret(update.ott) });
    return this.state.pendingUpdate;
  }

  // Auto-downloads an offered update unless disabled or that version was
  // already downloaded (THiNX re-offers it on every check-in until the device
  // reports the new version). Never throws: errors are returned/emitted.
  async handleFirmwareUpdate(registration, source, overrides = {}) {
    const update = extractFirmwareUpdate({ registration });
    const enabled = overrides.autoDownload ?? this.config.autoDownloadFirmware;
    if (!update || !enabled) {
      return undefined;
    }
    const last = this.state.lastFirmwareDownload;
    if (update.version && last?.version === update.version && last.path && fs.existsSync(last.path)) {
      return { skipped: true, reason: `version ${update.version} already downloaded`, path: last.path };
    }
    try {
      return await this.downloadFirmware({
        ott: update.ott,
        version: update.version,
        source,
        adoptVersion: overrides.adoptVersion ?? this.config.adoptDownloadedVersion
      });
    } catch (error) {
      this.emit("firmware-error", error);
      return { error: error.message };
    }
  }

  async requestOtt(overrides = {}) {
    this.reloadConfig(overrides);
    this.validateCredentials();
    const udid = this.resolveUdid(overrides);
    const url = this.deviceApiUrl("/device/firmware", overrides);
    this.applyTlsPolicy();

    const response = await this.fetchImpl(url, {
      method: "POST",
      headers: this.deviceHeaders(),
      body: JSON.stringify({ use: "ott", owner: this.ownerId, udid, mac: this.mac })
    });
    const text = await response.text();
    const payload = tryJson(text);
    const ott = payload?.ott || payload?.response?.ott;

    if (!response.ok || typeof ott !== "string") {
      throw new Error(`OTT request failed with HTTP ${response.status}: ${text.slice(0, 300)}`);
    }

    const pending = this.recordPendingUpdate({ ott }, "request");
    return { udid, url: url.toString(), ott, pendingUpdate: { ...pending, ott: redactSecret(ott) } };
  }

  async downloadFirmware(overrides = {}) {
    this.reloadConfig(overrides);
    let ott = overrides.ott;
    let version = overrides.version;
    let source = overrides.source || "argument";
    if (!ott && !overrides.requestNew && this.state.pendingUpdate?.ott) {
      ott = this.state.pendingUpdate.ott;
      version = version || this.state.pendingUpdate.version;
      source = `pending:${this.state.pendingUpdate.source}`;
    }
    if (!ott) {
      ({ ott } = await this.requestOtt(overrides));
      source = "request";
    }

    const url = this.deviceApiUrl("/device/firmware", overrides);
    url.searchParams.set("ott", ott);
    this.applyTlsPolicy();

    const response = await this.fetchImpl(url, {
      method: "GET",
      headers: { Accept: "application/octet-stream", "User-Agent": "THiNX-Client" }
    });

    const contentType = response.headers?.get?.("content-type") || "";
    // Refusals come back as a bare string or JSON envelope, not octet-stream.
    if (!response.ok || !contentType.includes("application/octet-stream")) {
      const text = await response.text();
      throw new Error(`Firmware download failed with HTTP ${response.status}: ${text.slice(0, 300)}`);
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    const md5 = crypto.createHash("md5").update(buffer).digest("hex");
    const expectedMd5 = response.headers.get("x-md5") || undefined;
    const declaredLength = response.headers.get("content-length");
    const outputDir = overrides.firmwareDir || this.config.firmwareDir;
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const safeVersion = String(version || "unknown").replace(/[^A-Za-z0-9._-]/g, "_");
    const filePath = path.join(outputDir, `${this.udid || "device"}-${safeVersion}-${stamp}.bin`);

    fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(filePath, buffer);

    const download = {
      path: filePath,
      size: buffer.length,
      md5,
      expectedMd5,
      md5Match: expectedMd5 ? expectedMd5.toLowerCase() === md5 : null,
      declaredLength: declaredLength ? Number(declaredLength) : null,
      version,
      source,
      url: `${url.origin}${url.pathname}?ott=${redactSecret(ott)}`,
      downloadedAt: new Date().toISOString()
    };

    this.state.lastFirmwareDownload = download;
    this.state.firmwareDownloads = [...(this.state.firmwareDownloads || []), download].slice(-10);
    if (this.state.pendingUpdate?.ott === ott) {
      delete this.state.pendingUpdate;
    }
    // Pretend the update was installed: later check-ins report this version.
    if (overrides.adoptVersion && version) {
      this.state.adoptedVersion = version;
      download.adoptedVersion = version;
    }
    this.saveState();
    this.emit("firmware-downloaded", download);
    return download;
  }

  //
  // Owner-authenticated device environment variables
  //
  // device.environment is owner-pushed state, not device-reported. The device
  // API key cannot write it, so these calls use an owner session JWT and the
  // same /api/v2 routes the THiNX console uses:
  //   - inspect: POST /api/v2/device  (getDeviceDetail)
  //   - set:     PUT  /api/v2/device  (editDevice -> couch "modify")
  //

  apiBaseUrl(overrides = {}) {
    return normalizeBaseUrl(
      overrides.apiUrl || this.config.apiUrl || overrides.cloudUrl || this.config.cloudUrl
    );
  }

  ownerAuthHeaders(token) {
    return {
      Authorization: String(token).startsWith("Bearer ") ? String(token) : `Bearer ${token}`,
      Accept: "application/json",
      "Content-Type": "application/json"
    };
  }

  // The API enforces double-submit CSRF on /api/v2/login: GET /api/v2/csrf-token
  // sets XSRF-TOKEN plus the x-thx-core session cookie (the token is bound to that
  // session in signed mode), and the login POST must send both cookies back with
  // the token echoed in X-XSRF-TOKEN.
  async primeCsrf(overrides = {}) {
    const url = `${this.apiBaseUrl(overrides)}/api/v2/csrf-token`;
    const response = await this.fetchImpl(url, { method: "GET", headers: { Accept: "application/json" } });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`CSRF token request failed with HTTP ${response.status}: ${text.slice(0, 300)}`);
    }

    const cookies = {};
    for (const line of readSetCookies(response.headers)) {
      const pair = line.split(";")[0];
      const eq = pair.indexOf("=");
      if (eq > 0) cookies[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
    }
    const payload = tryJson(text);
    const token = cookies["XSRF-TOKEN"] || payload?.response?.csrf_token || payload?.csrf_token;
    if (!token) {
      throw new Error("CSRF token request returned no XSRF-TOKEN.");
    }
    cookies["XSRF-TOKEN"] = token;
    const cookie = Object.entries(cookies)
      .map(([name, value]) => `${name}=${value}`)
      .join("; ");
    return { token, cookie };
  }

  async ownerLogin(overrides = {}) {
    this.reloadConfig(overrides);
    const username = overrides.ownerUsername || this.config.ownerUsername;
    const password = overrides.ownerPassword || this.config.ownerPassword;
    if (!username || !password) {
      throw new Error(
        "Owner login needs a username and password. Pass ownerUsername/ownerPassword, set THINX_OWNER_USER / THINX_OWNER_PASS, or add them to thinx-device.config.json."
      );
    }

    const csrf = await this.primeCsrf(overrides);
    const url = `${this.apiBaseUrl(overrides)}/api/v2/login`;
    const response = await this.fetchImpl(url, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Cookie: csrf.cookie,
        "X-XSRF-TOKEN": csrf.token
      },
      body: JSON.stringify({ username, password })
    });
    const text = await response.text();
    const payload = tryJson(text);

    if (!response.ok || !payload || payload.success !== true) {
      const suffix = payload ? JSON.stringify(payload) : text.slice(0, 300);
      throw new Error(`Owner login failed with HTTP ${response.status}: ${suffix}`);
    }
    if (!payload.access_token) {
      throw new Error("Owner login succeeded but the response carried no access_token.");
    }

    this.session = {
      accessToken: payload.access_token,
      refreshToken: payload.refresh_token,
      expiresAt: decodeJwtExpiry(payload.access_token),
      loggedInAt: new Date().toISOString()
    };
    return this.session;
  }

  // Returns a usable owner access token, logging in or reusing a cached/static
  // token as needed. Precedence: explicit arg -> fresh cached session ->
  // fresh static config token -> fresh login -> stale static token.
  async resolveOwnerToken(overrides = {}) {
    if (overrides.ownerToken && String(overrides.ownerToken).length >= 10) {
      return overrides.ownerToken;
    }
    if (this.session.accessToken && tokenIsFresh(this.session.accessToken)) {
      return this.session.accessToken;
    }
    if (this.config.ownerToken && tokenIsFresh(this.config.ownerToken)) {
      return this.config.ownerToken;
    }
    const haveCredentials =
      (overrides.ownerUsername || this.config.ownerUsername) &&
      (overrides.ownerPassword || this.config.ownerPassword);
    if (haveCredentials) {
      const session = await this.ownerLogin(overrides);
      return session.accessToken;
    }
    if (this.config.ownerToken) {
      return this.config.ownerToken; // stale — let the API return a clear 401/403
    }
    throw new Error(
      "No owner credentials. Provide ownerToken, or ownerUsername + ownerPassword (THINX_OWNER_USER / THINX_OWNER_PASS) so the server can log in."
    );
  }

  resolveUdid(overrides = {}) {
    const udid = overrides.udid || this.state.udid;
    if (!udid || String(udid).length < 5) {
      throw new Error("No device UDID. Call thinx_register first or pass an explicit udid.");
    }
    return udid;
  }

  async getEnvironment(overrides = {}) {
    this.reloadConfig(overrides);
    const udid = this.resolveUdid(overrides);
    const token = await this.resolveOwnerToken(overrides);
    const url = `${this.apiBaseUrl(overrides)}/api/v2/device`;

    const response = await this.fetchImpl(url, {
      method: "POST",
      headers: this.ownerAuthHeaders(token),
      body: JSON.stringify({ udid })
    });
    const text = await response.text();
    const payload = tryJson(text);

    if (!response.ok) {
      const suffix = payload ? JSON.stringify(payload) : text.slice(0, 300);
      throw new Error(`Get environment failed with HTTP ${response.status}: ${suffix}`);
    }

    const device = payload?.response || payload || {};
    return {
      udid,
      url,
      environment: device.environment || {},
      env_hash: device.env_hash || null
    };
  }

  async setEnvironment(environment, overrides = {}) {
    this.reloadConfig(overrides);
    const udid = this.resolveUdid(overrides);

    if (!environment || typeof environment !== "object" || Array.isArray(environment)) {
      throw new Error("environment must be a key-value object, for example { \"ssid\": \"office\" }.");
    }

    const token = await this.resolveOwnerToken(overrides);
    const merge = overrides.merge !== false;
    let nextEnvironment = { ...environment };
    if (merge) {
      const current = await this.getEnvironment({ ...overrides, ownerToken: token });
      nextEnvironment = { ...current.environment, ...environment };
    }

    const url = `${this.apiBaseUrl(overrides)}/api/v2/device`;
    const response = await this.fetchImpl(url, {
      method: "PUT",
      headers: this.ownerAuthHeaders(token),
      body: JSON.stringify({ changes: { udid, environment: nextEnvironment } })
    });
    const text = await response.text();
    const payload = tryJson(text);

    if (!response.ok) {
      const suffix = payload ? JSON.stringify(payload) : text.slice(0, 300);
      throw new Error(`Set environment failed with HTTP ${response.status}: ${suffix}`);
    }

    return {
      udid,
      url,
      merged: merge,
      environment: nextEnvironment,
      keys: Object.keys(nextEnvironment),
      response: payload
    };
  }

  safeState() {
    return {
      statePath: this.statePath,
      configPath: this.config.configPath,
      credentialSource: this.config.credentialSource,
      apiKey: redactSecret(this.config.apiKey),
      ownerId: this.ownerId,
      udid: this.udid,
      alias: this.state.alias || this.config.alias,
      mac: this.state.mac,
      lastRegistrationStatus: this.state.lastRegistrationStatus,
      lastRegisteredAt: this.state.lastRegisteredAt,
      platform: this.platform,
      reportedVersion: this.reportedVersion,
      firmwareDir: this.config.firmwareDir,
      autoDownloadFirmware: this.config.autoDownloadFirmware,
      pendingUpdate: this.state.pendingUpdate
        ? { ...this.state.pendingUpdate, ott: redactSecret(this.state.pendingUpdate.ott) }
        : null,
      lastFirmwareDownload: this.state.lastFirmwareDownload || null,
      mqttConnected: this.mqttConnected,
      autoConnectMqtt: this.config.autoConnectMqtt,
      mqttSubscriptions: this.mqttSubscriptions,
      lastMqttError: this.lastMqttError || null,
      deviceChannel: this.deviceChannel,
      statusChannel: this.statusChannel,
      apiBaseUrl: this.apiBaseUrl(),
      ownerCredentialsConfigured: Boolean(this.config.ownerUsername && this.config.ownerPassword),
      ownerTokenConfigured: Boolean(this.config.ownerToken),
      commands: {
        enabled: this.config.commands.enabled,
        mode: this.config.commands.mode,
        image: this.config.commands.docker.image,
        useDefaultAllow: this.config.commands.useDefaultAllow,
        allow: this.config.commands.allow,
        deny: this.config.commands.deny,
        defaultAllow: DEFAULT_ALLOW,
        pending: this.pendingCommands,
        consoleChannel: this.consoleChannel,
        runner: this.commandRunner ? this.commandRunner.status() : null
      },
      ownerSession: this.session.accessToken
        ? {
            loggedInAt: this.session.loggedInAt,
            expiresAt: this.session.expiresAt,
            fresh: tokenIsFresh(this.session.accessToken),
            accessToken: redactSecret(this.session.accessToken)
          }
        : null
    };
  }
}
