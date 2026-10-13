// Faithful to thinx-device-api messenger.js and THiNXLib32.cpp:
// a notification with no truthy `response` is "from device" (an echo of our
// own emit looping back); one with a defined, non-false `response` is a reply
// aimed at the device.

const EMIT_RESPONSE_TYPES = new Set(["bool", "string"]);

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function classifyNotification(json) {
  if (!isPlainObject(json)) {
    return undefined;
  }
  if (isPlainObject(json.notification)) {
    const n = json.notification;
    const hasResponse = n.response !== undefined && n.response !== false;
    if (!hasResponse) {
      return { kind: "echo" };
    }
    return {
      kind: "response",
      responseType: n.response_type,
      response: n.response,
      nid: n.nid,
      via: "notification"
    };
  }
  if (json.nid !== undefined && json.reply !== undefined) {
    return { kind: "response", responseType: undefined, response: json.reply, nid: json.nid, via: "reply" };
  }
  return undefined;
}

export function isApproval(responseType, response) {
  const type = String(responseType || "").toLowerCase();
  if (type === "bool" || type === "boolean") {
    if (response === true) return true;
    if (response === false) return false;
    return undefined;
  }
  if (type === "string") {
    if (response === "yes") return true;
    if (response === "no") return false;
    return undefined;
  }
  return undefined;
}

export function buildNotificationPayload({ title, body, responseType = "bool" } = {}) {
  if (typeof body !== "string" || body.trim() === "") {
    throw new Error("notification body must be a non-empty string");
  }
  if (!EMIT_RESPONSE_TYPES.has(responseType)) {
    throw new Error(`notification response_type must be one of ${[...EMIT_RESPONSE_TYPES].join(", ")}`);
  }
  const notification = { body, response_type: responseType };
  if (typeof title === "string" && title.length > 0) {
    notification.title = title;
  }
  return { notification };
}
