// Run: node --test test_route.mjs
import assert from "node:assert/strict";
import { readRequest, oneLine, deliver, clock, setupHint } from "./route.js";

// Requests: a reply target is kept only when it is a key and an object.
const reply = { key: "chatbar.request", value: { action: "draft", terminal: "t7", append: true } };
assert.deepEqual(readRequest({ action: "toggle", id: "chatbar:t7", reply, at: 1 }), { action: "toggle", id: "chatbar:t7", reply });
assert.deepEqual(readRequest({ action: "cancel" }), { action: "cancel", id: null, reply: null });
assert.equal(readRequest({ action: "toggle", reply: { key: "x", value: "text" } }).reply, null);
assert.equal(readRequest({ action: "toggle", reply: { key: "", value: {} } }).reply, null);
assert.equal(readRequest({ action: "send" }), null);
assert.equal(readRequest(null), null);

// No Enter, ever: line breaks and control characters are gone, whatever the model returns.
assert.equal(oneLine("Fix the login\nthen run tests\r\n"), "Fix the login then run tests");
assert.equal(oneLine("a\rb\u2028c\u0003d\u001b[1m"), "a b cd[1m");
assert.equal(oneLine("  naïve café  "), "naïve café");
for (const raw of ["x\n", "\r", "a\r\nb", "\n\n\n"]) assert.ok(!/[\r\n]/.test(deliver(raw, null, "t1")?.text ?? ""));

// Routing: the requester's key, else the focused terminal, else the clipboard; nothing for silence.
assert.deepEqual(deliver("and the footer\n", reply, "t3"),
  { kind: "reply", key: "chatbar.request", value: { action: "draft", terminal: "t7", append: true, text: "and the footer" } });
assert.deepEqual(deliver("ls the folder", null, "t3"), { kind: "paste", terminal: "t3", text: "ls the folder" });
assert.deepEqual(deliver("hello", null, null), { kind: "clipboard", text: "hello" });
assert.equal(deliver("  \n ", null, "t3"), null);
// A reply never turns into a send: the requester's value is kept as given, only text is added.
assert.equal(deliver("hi", reply, null).value.action, "draft");

assert.equal(clock(7400), "0:07");
assert.equal(clock(83000), "1:23");
assert.equal(setupHint({ macos: true, ffmpeg: true, parakeet: true }), null);
assert.equal(setupHint({ macos: true, ffmpeg: false, parakeet: false }), "Dictation needs: brew install ffmpeg · uv tool install parakeet-mlx");
assert.equal(setupHint({ macos: false }), "Dictation works on macOS only.");

console.log("ok");
