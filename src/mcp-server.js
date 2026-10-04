import readline from "node:readline";

import { ThinxDeviceClient } from "./thinx-device-client.js";

const JSONRPC_VERSION = "2.0";
const MCP_PROTOCOL_VERSION = "2024-11-05";

function textResult(value, isError = false) {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return {
    content: [{ type: "text", text }],
    isError
  };
}

function tool(name, description, inputSchema) {
  return { name, description, inputSchema };
}

const tools = [
  tool("thinx_register", "Register this emulated THiNX device and persist the returned UDID.", {
    type: "object",
    additionalProperties: false,
    properties: {
      cloudUrl: { type: "string", description: "Override THiNX API base URL, for example https://app.thinx.cloud." },
      registerPath: { type: "string", description: "Override registration path. Defaults to /device/register." },
      apiPort: { type: ["number", "string"], description: "Optional API port override." },
      alias: { type: "string", description: "Optional device alias to report." },
      udid: { type: "string", description: "Optional existing UDID to report during check-in." },
      mac: { type: "string", description: "Optional device MAC/client id override." },
      platform: {
        type: "string",
        description:
          "Platform to report, e.g. \"platformio\" or \"arduino\" (expanded to \"<platform>:<mcu>\"). Persisted for later check-ins. THiNX builds/serves OTT firmware only for arduino and platformio."
      },
      mcu: { type: "string", description: "MCU suffix for arduino/platformio platforms. Defaults to esp32." },
      firmwareVersionShort: {
        type: "string",
        description: "Semver version to report. THiNX offers an OTT update only when the built firmware version is newer."
      },
      envHash: { type: "string", description: "Optional env_hash to report." },
      autoDownload: {
        type: "boolean",
        description: "Download the firmware when the check-in returns FIRMWARE_UPDATE with an OTT. Defaults to config autoDownloadFirmware (true)."
      },
      adoptVersion: {
        type: "boolean",
        description: "After an automatic download, report the downloaded version on later check-ins (simulates a successful install)."
      }
    }
  }),
  tool("thinx_connect_mqtt", "Connect to THiNX MQTT as the registered device and listen on device channels.", {
    type: "object",
    additionalProperties: false,
    properties: {
      autoRegister: { type: "boolean", description: "Register first if no UDID has been saved. Defaults to true." },
      mqttUrl: { type: "string", description: "Full MQTT URL override, for example mqtt://thinx.cloud:1883." },
      mqttHost: { type: "string", description: "MQTT host override." },
      mqttPort: { type: ["number", "string"], description: "MQTT port override. 1883 for MQTT, 8883 for MQTTS." },
      mqttProtocol: { type: "string", enum: ["mqtt", "mqtts"], description: "MQTT protocol override." },
      subscribeWildcard: { type: "boolean", description: "Subscribe to /owner/udid/# in addition to /owner/udid." },
      timeoutMs: { type: "number", description: "Connection timeout in milliseconds." }
    }
  }),
  tool("thinx_status", "Return redacted device registration and MQTT status.", {
    type: "object",
    additionalProperties: false,
    properties: {}
  }),
  tool("thinx_recent_messages", "Return recently received MQTT messages.", {
    type: "object",
    additionalProperties: false,
    properties: {
      limit: { type: "number", description: "Maximum number of messages to return. Defaults to 20." }
    }
  }),
  tool("thinx_publish_status", "Publish a status payload to /owner/udid/status.", {
    type: "object",
    additionalProperties: false,
    required: ["message"],
    properties: {
      message: {
        description: "String or JSON-compatible status payload.",
        oneOf: [{ type: "string" }, { type: "object" }, { type: "array" }, { type: "number" }, { type: "boolean" }]
      },
      retain: { type: "boolean", description: "Retain the MQTT status message. Defaults to true." }
    }
  }),
  tool(
    "thinx_request_ott",
    "Request a one-time firmware token via POST /device/firmware { use: \"ott\" } using the device API key. Stores it as the pending update.",
    {
      type: "object",
      additionalProperties: false,
      properties: {
        udid: { type: "string", description: "Device UDID. Defaults to the registered device." },
        cloudUrl: { type: "string", description: "Override THiNX device API base URL." },
        apiPort: { type: ["number", "string"], description: "Optional API port override." }
      }
    }
  ),
  tool(
    "thinx_download_firmware",
    "Download firmware via GET /device/firmware?ott=<token> and store the binary on disk (never flashed or executed). Uses the given ott, else the pending OTT from the last FIRMWARE_UPDATE check-in/MQTT push, else requests a new OTT.",
    {
      type: "object",
      additionalProperties: false,
      properties: {
        ott: { type: "string", description: "One-time token. Defaults to the pending update token." },
        requestNew: { type: "boolean", description: "Ignore any pending token and request a fresh OTT first." },
        version: { type: "string", description: "Version label for the stored file. Defaults to the version offered with the OTT." },
        adoptVersion: {
          type: "boolean",
          description: "Report the downloaded version on later check-ins (simulates a successful install)."
        },
        firmwareDir: { type: "string", description: "Directory to store the binary. Defaults to ./firmware." },
        cloudUrl: { type: "string", description: "Override THiNX device API base URL." },
        apiPort: { type: ["number", "string"], description: "Optional API port override." }
      }
    }
  ),
  tool("thinx_disconnect_mqtt", "Disconnect the MQTT client.", {
    type: "object",
    additionalProperties: false,
    properties: {}
  }),
  tool(
    "thinx_login",
    "Log in as the device owner and cache a session token for the environment tools. Uses ownerUsername/ownerPassword or THINX_OWNER_USER / THINX_OWNER_PASS.",
    {
      type: "object",
      additionalProperties: false,
      properties: {
        ownerUsername: { type: "string", description: "Owner account username. Defaults to THINX_OWNER_USER." },
        ownerPassword: { type: "string", description: "Owner account password. Defaults to THINX_OWNER_PASS." },
        apiUrl: { type: "string", description: "API base URL override, for example https://console.thinx.cloud." }
      }
    }
  ),
  tool(
    "thinx_get_environment",
    "Inspect the device's environment variables via the THiNX API (POST /api/v2/device). Requires an owner session token.",
    {
      type: "object",
      additionalProperties: false,
      properties: {
        udid: { type: "string", description: "Device UDID. Defaults to the registered device." },
        ownerToken: { type: "string", description: "Owner session JWT. Defaults to THINX_OWNER_TOKEN or config ownerToken." },
        apiUrl: { type: "string", description: "API base URL override, for example https://console.thinx.cloud." }
      }
    }
  ),
  tool(
    "thinx_set_environment",
    "Set environment variables on the device via the THiNX API (PUT /api/v2/device). Requires an owner session token. Merges with existing values by default.",
    {
      type: "object",
      additionalProperties: false,
      required: ["environment"],
      properties: {
        environment: {
          type: "object",
          description: "Key-value environment variables to set, for example { \"ssid\": \"office\", \"region\": \"eu\" }."
        },
        udid: { type: "string", description: "Device UDID. Defaults to the registered device." },
        ownerToken: { type: "string", description: "Owner session JWT. Defaults to THINX_OWNER_TOKEN or config ownerToken." },
        apiUrl: { type: "string", description: "API base URL override, for example https://console.thinx.cloud." },
        merge: { type: "boolean", description: "Merge with existing environment (default true). Set false to replace it entirely." }
      }
    }
  )
];

export class McpJsonRpcServer {
  constructor({ input = process.stdin, output = process.stdout, client = new ThinxDeviceClient() } = {}) {
    this.input = input;
    this.output = output;
    this.client = client;
  }

  send(message) {
    this.output.write(`${JSON.stringify(message)}\n`);
  }

  sendResult(id, result) {
    this.send({ jsonrpc: JSONRPC_VERSION, id, result });
  }

  sendError(id, code, message, data) {
    this.send({
      jsonrpc: JSONRPC_VERSION,
      id,
      error: { code, message, ...(data === undefined ? {} : { data }) }
    });
  }

  async handleToolCall(name, args = {}) {
    switch (name) {
      case "thinx_register":
        return textResult(await this.client.register(args));
      case "thinx_connect_mqtt":
        return textResult(await this.client.connectMqtt(args));
      case "thinx_status":
        return textResult(this.client.safeState());
      case "thinx_recent_messages":
        return textResult(this.client.recentMessages(args.limit));
      case "thinx_publish_status":
        return textResult(this.client.publishStatus(args.message, { retain: args.retain }));
      case "thinx_request_ott":
        return textResult(await this.client.requestOtt(args));
      case "thinx_download_firmware":
        return textResult(await this.client.downloadFirmware(args));
      case "thinx_disconnect_mqtt":
        return textResult(this.client.disconnectMqtt());
      case "thinx_login":
        await this.client.ownerLogin(args);
        return textResult(this.client.safeState());
      case "thinx_get_environment":
        return textResult(await this.client.getEnvironment(args));
      case "thinx_set_environment":
        return textResult(await this.client.setEnvironment(args.environment, args));
      default:
        return textResult(`Unknown tool: ${name}`, true);
    }
  }

  async handleRequest(message) {
    const { id, method, params = {} } = message;

    try {
      switch (method) {
        case "initialize":
          this.sendResult(id, {
            protocolVersion: params.protocolVersion || MCP_PROTOCOL_VERSION,
            capabilities: { tools: {} },
            serverInfo: {
              name: "thinx-mcp-device",
              version: "0.1.0"
            }
          });
          return;
        case "ping":
          this.sendResult(id, {});
          return;
        case "tools/list":
          this.sendResult(id, { tools });
          return;
        case "tools/call":
          this.sendResult(id, await this.handleToolCall(params.name, params.arguments || {}));
          return;
        case "resources/list":
          this.sendResult(id, { resources: [] });
          return;
        case "prompts/list":
          this.sendResult(id, { prompts: [] });
          return;
        case "shutdown":
          this.client.disconnectMqtt();
          this.sendResult(id, {});
          return;
        default:
          this.sendError(id, -32601, `Method not found: ${method}`);
      }
    } catch (error) {
      if (method === "tools/call") {
        this.sendResult(id, textResult(error.message, true));
      } else {
        this.sendError(id, -32000, error.message);
      }
    }
  }

  async handleMessage(message) {
    if (Array.isArray(message)) {
      await Promise.all(message.map((item) => this.handleMessage(item)));
      return;
    }

    if (!message || message.jsonrpc !== JSONRPC_VERSION) {
      this.sendError(null, -32600, "Invalid JSON-RPC message.");
      return;
    }

    if (message.id === undefined || message.id === null) {
      if (message.method === "notifications/cancelled") {
        return;
      }
      return;
    }

    await this.handleRequest(message);
  }

  run() {
    const rl = readline.createInterface({ input: this.input, crlfDelay: Infinity });
    rl.on("line", (line) => {
      const trimmed = line.trim();
      if (!trimmed) {
        return;
      }
      let message;
      try {
        message = JSON.parse(trimmed);
      } catch (error) {
        this.sendError(null, -32700, `Parse error: ${error.message}`);
        return;
      }
      this.handleMessage(message).catch((error) => {
        this.sendError(null, -32000, error.message);
      });
    });

    this.client.on("mqtt-error", (error) => {
      process.stderr.write(`[thinx-mcp-device] MQTT error: ${error.message}\n`);
    });

    this.client.on("checkin-error", (error) => {
      process.stderr.write(`[thinx-mcp-device] Check-in error: ${error.message}\n`);
    });

    this.client.on("firmware-error", (error) => {
      process.stderr.write(`[thinx-mcp-device] Firmware download error: ${error.message}\n`);
    });

    this.client.on("firmware-downloaded", (download) => {
      process.stderr.write(`[thinx-mcp-device] Firmware stored: ${download.path} (${download.size} bytes, md5 ${download.md5})\n`);
    });
  }
}

export function runMcpServer() {
  new McpJsonRpcServer().run();
}
