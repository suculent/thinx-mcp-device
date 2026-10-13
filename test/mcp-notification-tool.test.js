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
