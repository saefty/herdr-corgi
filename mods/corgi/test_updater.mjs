// node --test mods/corgi/test_updater.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { DAY, due, readStatus, summary, decide } from "./updater.js";

const status = (mods, updates) => ({ code: 0, stdout: JSON.stringify({ mods, updates, unmanaged: [] }), stderr: "" });
const mod = (o) => ({ version: "1.0.0", dev: null, installed: true, changed: [], latest: "1.0.0", update: false, changelog: "", error: null, ...o });

test("checks once a day", () => {
  assert.equal(due(null, 1000), true);
  assert.equal(due(1000, 1000 + DAY - 1), false);
  assert.equal(due(1000, 1000 + DAY), true);
});

test("reads updates and per-mod errors from status --json", () => {
  const r = readStatus(status({
    goto: mod({ latest: "1.3.0", update: true, changelog: "## 1.3.0\n- feat: x" }),
    chatbar: mod({ error: "could not fetch" }),
    dictate: mod({}),
  }, ["goto"]));
  assert.deepEqual(r, {
    updates: [{ name: "goto", from: "1.0.0", to: "1.3.0", changelog: "## 1.3.0\n- feat: x" }],
    errors: [{ name: "chatbar", error: "could not fetch" }],
    error: null,
  });
});

test("a failed status run is an error, not a crash", () => {
  assert.equal(readStatus({ code: 1, stdout: "", stderr: "Traceback\ncorgi: no manifest at x\n" }).error, "corgi: no manifest at x");
  assert.equal(readStatus({ code: 0, stdout: "not json", stderr: "" }).error, "corgi status failed (exit 0)");
});

test("formats the notification", () => {
  assert.equal(summary([{ name: "goto", to: "1.3.0" }]), "Update: goto 1.3.0");
  assert.equal(summary([{ name: "goto", to: "1.3.0" }, { name: "chatbar", to: "1.1.0" }]), "2 updates: goto 1.3.0, chatbar 1.1.0");
});

test("notifies once per new set of updates, never on errors", () => {
  const two = { updates: [{ name: "goto", to: "1.3.0" }, { name: "chatbar", to: "1.1.0" }], errors: [], error: null };
  const first = decide(two, null);
  assert.equal(first.title, "2 updates: goto 1.3.0, chatbar 1.1.0");
  assert.equal(first.notified, "chatbar@1.1.0,goto@1.3.0");
  assert.deepEqual(decide(two, first.notified), { title: null, notified: first.notified });
  const newer = { ...two, updates: [{ name: "goto", to: "1.4.0" }] };
  assert.equal(decide(newer, first.notified).title, "Update: goto 1.4.0");
  // network down: silent, and the same set doesn't notify again once it's back
  assert.deepEqual(decide({ updates: [], errors: [], error: "offline" }, first.notified), { title: null, notified: first.notified });
  assert.deepEqual(decide({ updates: [], errors: [{ name: "goto", error: "x" }], error: null }, first.notified), { title: null, notified: first.notified });
  // all up to date: forget, so a later release notifies
  assert.deepEqual(decide({ updates: [], errors: [], error: null }, first.notified), { title: null, notified: null });
});
