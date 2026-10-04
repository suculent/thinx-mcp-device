import assert from "node:assert/strict";
import { test } from "node:test";
import { evaluateCommand, splitSegments, DEFAULT_ALLOW } from "../src/command-policy.js";

const allowed = (cmd, opts) => evaluateCommand(cmd, opts).allowed;

test("default allow-list permits read-only commands and their args", () => {
  for (const cmd of ["whoami", "ls", "ls -la /tmp", "cat /etc/hostname", "uname -a", "echo hi"]) {
    assert.equal(allowed(cmd), true, cmd);
  }
});

test("DEFAULT_ALLOW is exported and non-empty", () => {
  assert.ok(Array.isArray(DEFAULT_ALLOW) && DEFAULT_ALLOW.length > 0);
});

test("commands outside the allow-list are refused", () => {
  const r = evaluateCommand("curl http://x");
  assert.equal(r.allowed, false);
  assert.match(r.reason, /allow-list/);
});

test("a dangerous segment refuses the whole chain", () => {
  const r = evaluateCommand("ls; rm -rf /");
  assert.equal(r.allowed, false);
  assert.equal(r.segment, "rm -rf /");
  assert.match(r.reason, /built-in deny/);
});

test("rm -rf of root is denied even when rm * is allowed", () => {
  for (const cmd of [
    "rm -rf /",
    "rm -fr /*",
    "rm -r -f /",
    "rm --recursive --force /",
    "rm --no-preserve-root -rf /"
  ]) {
    assert.equal(evaluateCommand(cmd, { allow: ["rm *"] }).allowed, false, cmd);
  }
});

test("other built-in denies", () => {
  for (const cmd of [
    "mkfs.ext4 /dev/sda",
    "dd if=/dev/zero of=/dev/sda",
    "shutdown now",
    ":(){ :|:& };:"
  ]) {
    assert.equal(evaluateCommand(cmd, { allow: ["mkfs*", "dd *", "shutdown *"] }).allowed, false, cmd);
  }
});

test("command substitution and write redirects are refused", () => {
  for (const cmd of ["cat $(ls)", "echo `id`", "echo x > /tmp/f", "cat a >> b", "cat <(ls)"]) {
    assert.equal(evaluateCommand(cmd, { allow: ["cat *", "echo *"] }).allowed, false, cmd);
  }
});

test("input redirect and stderr merge are allowed", () => {
  assert.equal(allowed("cat < /etc/hostname", { allow: ["cat *"] }), true);
  assert.equal(allowed("ls /nope 2>&1", { allow: ["ls *"] }), true);
});

test("find with -exec/-delete is refused despite find *", () => {
  assert.equal(allowed("find . -name x", { allow: ["find *"] }), true);
  assert.equal(allowed("find . -delete", { allow: ["find *"] }), false);
  assert.equal(allowed("find . -exec rm {} ;", { allow: ["find *"] }), false);
});

test("deny rules win over allow rules", () => {
  assert.equal(allowed("cat /etc/shadow", { allow: ["cat *"], deny: ["cat /etc/shadow"] }), false);
});

test("useDefaultAllow:false means only configured allow applies", () => {
  assert.equal(allowed("whoami", { useDefaultAllow: false }), false);
  assert.equal(allowed("whoami", { useDefaultAllow: false, allow: ["whoami"] }), true);
});

test("exact rule does not match when arguments are present", () => {
  assert.equal(allowed("whoami --help"), false);
});

test("splitSegments splits on separators and reports unterminated quotes", () => {
  assert.deepEqual(splitSegments("a && b | c ; d").segments, ["a", "b", "c", "d"]);
  assert.equal(splitSegments("echo 'open").ok, false);
});
