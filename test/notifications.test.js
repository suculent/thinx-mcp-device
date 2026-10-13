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
