import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import mqtt from "mqtt";

import { DEFAULT_INO_PATH, readInoCredentials, redactSecret } from "./credentials.js";

const DEFAULT_CONFIG_PATH = fileURLToPath(new URL("../thinx-device.config.json", import.meta.url));
const DEFAULT_STATE_PATH = fileURLToPath(new URL("../.thinx-device-state.json", import.meta.url));
const DEFAULT_NETWORK_INTERFACES = ["en0", "eth0", "wlan0"];
const DEFAULT_CHECKIN_INTERVAL_SECONDS = 300;
const DEFAULT_FIRMWARE_VERSION = "thinx-mcp-device:0.1.0";
const DEFAULT_FIRMWARE_VERSION_SHORT = "0.1.0";
const DEFAULT_APP_VERSION = "thinx-mcp-device:0.1.0";

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

// THiNX sometimes wraps a rejected registration as
// { success: false, response: "<JSON string containing { registration: ... }>" }.
function unwrapRegistration(payload) {
  if (payload?.registration) {
    return payload.registration;
  }
  const inner = typeof payload?.response === "string" ? tryJson(payload.response) : payload?.response;
  return inner?.registration;
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
    this.checkinTimer = undefined;
    this.fetchImpl = options.fetch || ((...args) => fetch(...args));
    this.session = {}; // cached owner login: { accessToken, refreshToken, expiresAt, loggedInAt }
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
      platform: options.platform || process.env.THINX_PLATFORM || fileConfig.platform || "nodejs:mcp",
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
      apiUrl: options.apiUrl || process.env.THINX_API_URL || fileConfig.apiUrl
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
      version: overrides.firmwareVersionShort || this.config.firmwareVersionShort,
      commit: overrides.commitId || this.config.commitId,
      owner: overrides.ownerId || this.config.ownerId,
      alias: overrides.alias || this.state.alias || this.config.alias,
      status: overrides.status || "Registered",
      platform: overrides.platform || this.config.platform,
      fcid: overrides.fcid || this.mac
    };

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

  registerUrl(overrides = {}) {
    this.reloadConfig(overrides);
    const base = normalizeBaseUrl(overrides.cloudUrl || this.config.cloudUrl);
    const url = new URL(base);
    if (overrides.apiPort || process.env.THINX_API_PORT) {
      url.port = String(overrides.apiPort || process.env.THINX_API_PORT);
    }
    url.pathname = normalizeRegisterPath(overrides.registerPath || this.config.registerPath);
    return url;
  }

  async register(overrides = {}) {
    this.reloadConfig(overrides);
    const url = this.registerUrl(overrides);
    const body = this.registrationBody(overrides);

    if (this.config.insecureTls) {
      process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
    }

    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authentication: this.config.apiKey,
        Accept: "application/json",
        Origin: "device",
        "Content-Type": "application/json",
        "User-Agent": "THiNX-Client"
      },
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
    return {
      url: url.toString(),
      registration,
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

  async connectMqtt(overrides = {}) {
    this.reloadConfig(overrides);
    this.validateCredentials();

    if (!this.udid || !this.ownerId) {
      if (overrides.autoRegister === false) {
        throw new Error("Device has no UDID yet. Call thinx_register first or allow auto_register.");
      }
      await this.register(overrides);
    }

    if (this.mqttClient && this.mqttConnected) {
      return this.mqttSummary();
    }

    const url = buildMqttUrl(this.config, overrides);
    const statusChannel = this.statusChannel;
    const deviceChannel = this.deviceChannel;
    const subscriptions =
      overrides.subscribeWildcard === false ? [deviceChannel] : [deviceChannel, `${deviceChannel}/#`];

    await new Promise((resolve, reject) => {
      let settled = false;
      const timeout = setTimeout(() => {
        if (!settled) {
          settled = true;
          reject(new Error(`MQTT connection timed out for ${url}.`));
        }
      }, Number(overrides.timeoutMs || 20000));

      const client = mqtt.connect(url, {
        clientId: this.mac,
        clean: false,
        keepalive: 45,
        reconnectPeriod: Number(overrides.reconnectPeriodMs || 30000),
        username: this.udid,
        password: this.config.apiKey,
        will: {
          topic: statusChannel,
          payload: JSON.stringify({ status: "disconnected" }),
          qos: 0,
          retain: true
        }
      });

      this.mqttClient = client;

      client.on("connect", () => {
        this.mqttConnected = true;
        client.subscribe(subscriptions, { qos: 0 }, (error) => {
          if (error) {
            if (!settled) {
              settled = true;
              clearTimeout(timeout);
              reject(error);
            }
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
        if (topic === statusChannel) {
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
      });

      client.on("error", (error) => {
        this.emit("mqtt-error", error);
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          reject(error);
        }
      });

      client.on("close", () => {
        this.mqttConnected = false;
        this.emit("mqtt-closed");
      });
    });

    if (this.config.checkinIntervalSeconds > 0 && !this.checkinTimer) {
      this.checkinTimer = setInterval(() => {
        this.register().catch((error) => {
          this.emit("checkin-error", error);
        });
      }, this.config.checkinIntervalSeconds * 1000);
      this.checkinTimer.unref();
    }

    return this.mqttSummary();
  }

  mqttSummary() {
    return {
      connected: this.mqttConnected,
      broker: buildMqttUrl(this.config),
      clientId: this.mac,
      username: this.udid,
      deviceChannel: this.deviceChannel,
      statusChannel: this.statusChannel,
      subscriptions: this.deviceChannel ? [this.deviceChannel, `${this.deviceChannel}/#`] : []
    };
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
    this.mqttClient.end(false);
    this.mqttClient = undefined;
    this.mqttConnected = false;
    return { connected: false };
  }

  recentMessages(limit = 20) {
    return this.messages.slice(-Number(limit || 20));
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

  async ownerLogin(overrides = {}) {
    this.reloadConfig(overrides);
    const username = overrides.ownerUsername || this.config.ownerUsername;
    const password = overrides.ownerPassword || this.config.ownerPassword;
    if (!username || !password) {
      throw new Error(
        "Owner login needs a username and password. Pass ownerUsername/ownerPassword, set THINX_OWNER_USER / THINX_OWNER_PASS, or add them to thinx-device.config.json."
      );
    }

    const url = `${this.apiBaseUrl(overrides)}/api/v2/login`;
    const response = await this.fetchImpl(url, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
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
      mqttConnected: this.mqttConnected,
      deviceChannel: this.deviceChannel,
      statusChannel: this.statusChannel,
      apiBaseUrl: this.apiBaseUrl(),
      ownerCredentialsConfigured: Boolean(this.config.ownerUsername && this.config.ownerPassword),
      ownerTokenConfigured: Boolean(this.config.ownerToken),
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
