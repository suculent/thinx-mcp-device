// Claude-style command allow/deny policy. Pure: no side effects, no I/O.
//
// A command is split into segments at top-level separators (; && || | & \n).
// Every segment must pass: it is refused by the built-in deny list, a configured
// deny rule, the find-exec guard, or for not matching any allow rule — and the
// whole command is allowed only when every segment is allowed. Constructs that
// cannot be statically checked (command/process substitution, output redirects,
// unterminated quotes) refuse the whole command.
//
// Rule syntax (like Claude's tool permissions):
//   "foo"     exact: matches the segment "foo" only
//   "foo *"   prefix: matches "foo" alone or "foo " followed by anything
//   "foo*"    raw prefix: matches any segment starting with "foo"

export const DEFAULT_ALLOW = [
  "whoami", "id", "hostname", "pwd", "uptime", "date", "env", "printenv",
  "ls *", "cat *", "head *", "tail *", "wc *", "grep *", "find *", "stat *",
  "uname *", "df *", "du *", "free *", "ps *", "echo *", "which *", "file *",
  "md5sum *", "sha256sum *"
];

const DANGEROUS_PATHS = new Set(["/", "/*", "~", ".", "..", "/.", "/root", "/etc", "/*/"]);
const KILL_SWITCHES = ["shutdown", "reboot", "halt", "poweroff", "init"];
const FIND_EXEC_FLAGS = new Set(["-exec", "-execdir", "-ok", "-okdir", "-delete"]);

// Split a command into top-level segments, honouring quotes and rejecting
// constructs we cannot reason about. Returns { ok, segments } or { ok:false, reason }.
export function splitSegments(command) {
  const segments = [];
  let cur = "";
  let single = false;
  let dbl = false;
  let escaped = false;
  const lastNonSpace = () => {
    for (let k = cur.length - 1; k >= 0; k--) {
      if (cur[k] !== " " && cur[k] !== "\t") return cur[k];
    }
    return "";
  };
  const push = () => { segments.push(cur); cur = ""; };

  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    const n = command[i + 1];
    if (escaped) { cur += c; escaped = false; continue; }
    if (c === "\\" && !single) { escaped = true; cur += c; continue; }
    if (single) { if (c === "'") single = false; cur += c; continue; }
    if (dbl) {
      if (c === "`") return { ok: false, reason: "command substitution (backticks)" };
      if (c === "$" && n === "(") return { ok: false, reason: "command substitution" };
      if (c === '"') dbl = false;
      cur += c; continue;
    }
    if (c === "'") { single = true; cur += c; continue; }
    if (c === '"') { dbl = true; cur += c; continue; }
    if (c === "`") return { ok: false, reason: "command substitution (backticks)" };
    if (c === "$" && n === "(") return { ok: false, reason: "command substitution" };
    if ((c === "<" || c === ">") && n === "(") return { ok: false, reason: "process substitution" };
    if (c === ">") {
      if (n === "&") { cur += c; continue; } // fd duplication, e.g. 2>&1
      return { ok: false, reason: "output redirect" };
    }
    if (c === "&") {
      if (lastNonSpace() === ">") { cur += c; continue; } // part of >& fd dup
      if (n === "&") { push(); i++; continue; }           // &&
      push(); continue;                                   // background &
    }
    if (c === "|") { if (n === "|") i++; push(); continue; } // | and ||
    if (c === ";" || c === "\n") { push(); continue; }
    cur += c;
  }
  if (single || dbl || escaped) return { ok: false, reason: "unterminated quote or escape" };
  push();
  const trimmed = segments.map((s) => s.trim()).filter((s) => s.length > 0);
  return { ok: true, segments: trimmed };
}

// Words of a segment, surrounding quotes stripped. Good enough for flag/target
// inspection by the deny rules (not a full shell parser).
function words(segment) {
  const out = [];
  let cur = "";
  let single = false;
  let dbl = false;
  for (const c of segment) {
    if (single) { if (c === "'") single = false; else cur += c; continue; }
    if (dbl) { if (c === '"') dbl = false; else cur += c; continue; }
    if (c === "'") { single = true; continue; }
    if (c === '"') { dbl = true; continue; }
    if (c === " " || c === "\t") { if (cur) { out.push(cur); cur = ""; } continue; }
    cur += c;
  }
  if (cur) out.push(cur);
  return out;
}

const basename = (w) => w.split("/").pop();

// A non-configurable reason the segment is forbidden, or null.
function builtinDeny(segment) {
  // Shell function definition / fork bomb, detected before word-splitting.
  if (/[\w:.-]*\(\)\s*\{/.test(segment)) return "shell function definition / fork bomb";
  const w = words(segment);
  if (w.length === 0) return null;
  const base = basename(w[0]);

  if (base === "rm") {
    const flagChars = w.filter((x) => /^-[^-]/.test(x)).join("");
    const longFlags = w.filter((x) => x.startsWith("--"));
    if (longFlags.includes("--no-preserve-root")) return "rm --no-preserve-root";
    const recursive = flagChars.includes("r") || flagChars.includes("R") || longFlags.includes("--recursive");
    const force = flagChars.includes("f") || longFlags.includes("--force");
    const targets = w.slice(1).filter((x) => !x.startsWith("-"));
    if (recursive && force && (targets.length === 0 || targets.some((t) => DANGEROUS_PATHS.has(t)))) {
      return "recursive force remove of a dangerous path";
    }
    if (recursive && targets.some((t) => DANGEROUS_PATHS.has(t))) {
      return "recursive remove of a dangerous path";
    }
  }
  if (base.startsWith("mkfs")) return "filesystem creation";
  if (base === "dd" && w.some((x) => /^of=\/dev\//.test(x))) return "dd to a device";
  if (KILL_SWITCHES.includes(base)) return `power control (${base})`;
  return null;
}

function matchesRule(segment, rule) {
  const seg = segment.replace(/\s+/g, " ").trim();
  if (rule.endsWith(" *")) {
    const prefix = rule.slice(0, -2);
    return seg === prefix || seg.startsWith(prefix + " ");
  }
  if (rule.endsWith("*")) return seg.startsWith(rule.slice(0, -1));
  return seg === rule;
}

const matchesAny = (segment, rules) => rules.some((r) => matchesRule(segment, r));

export function evaluateCommand(command, { allow = [], deny = [], useDefaultAllow = true } = {}) {
  if (typeof command !== "string" || command.trim() === "") {
    return { allowed: false, reason: "empty command" };
  }
  const split = splitSegments(command);
  if (!split.ok) return { allowed: false, reason: `cannot evaluate: ${split.reason}` };

  const allowRules = (useDefaultAllow ? DEFAULT_ALLOW : []).concat(allow);
  for (const segment of split.segments) {
    const denyReason = builtinDeny(segment);
    if (denyReason) return { allowed: false, segment, reason: `built-in deny: ${denyReason}` };
    if (matchesAny(segment, deny)) return { allowed: false, segment, reason: "matches a deny rule" };

    const w = words(segment);
    if (basename(w[0] || "") === "find" && w.some((x) => FIND_EXEC_FLAGS.has(x))) {
      return { allowed: false, segment, reason: "find with -exec/-delete is not allowed" };
    }
    if (!matchesAny(segment, allowRules)) {
      return { allowed: false, segment, reason: "not in allow-list" };
    }
  }
  return { allowed: true };
}
