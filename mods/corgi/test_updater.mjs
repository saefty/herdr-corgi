// node --test mods/corgi/test_updater.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { DAY, due, readStatus, summary, decide, shortDate, entries } from "./updater.js";

const status = (mods, updates, pending = []) => ({ code: 0, stdout: JSON.stringify({ mods, updates, pending, unmanaged: [] }), stderr: "" });
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
    pending: [],
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

test("an update goes to the newest release past its waiting period; newer ones are pending", () => {
  const r = readStatus(status({
    goto: mod({ latest: "1.3.0", next: "1.2.0", update: true }),
    chatbar: mod({ latest: "1.1.0" }),
  }, ["goto"], [{ name: "goto", version: "1.3.0", available_on: "2026-11-13" },
                { name: "chatbar", version: "1.1.0", available_on: "2026-11-12" },
                { name: "gone", version: "9.0.0", available_on: "2026-11-12" }]));
  assert.deepEqual(r.updates.map((u) => `${u.name} ${u.to}`), ["goto 1.2.0"]);
  assert.deepEqual(r.pending.map((p) => p.name), ["goto", "chatbar"]);
  assert.equal(shortDate("2026-11-13"), "Nov 13");
});

test("pending releases never notify; they do once they become updates", () => {
  const pendingOnly = { updates: [], pending: [{ name: "goto", version: "1.3.0", available_on: "2026-11-13" }], errors: [], error: null };
  assert.deepEqual(decide(pendingOnly, null), { title: null, notified: null });
  const eligible = { updates: [{ name: "goto", to: "1.3.0" }], pending: [], errors: [], error: null };
  assert.equal(decide(eligible, null).title, "Update: goto 1.3.0");
});

test("lists the rows other mods publish, and skips what is malformed", () => {
  const state = {
    "corgi.items.resume": [{ id: "hooks", title: "Resume Claude sessions", subtitle: "Claude Code hooks not set up", run: [["mod.open", { name: "resume" }]] }],
    "corgi.items.other": [{ title: "No id", run: [["x.y"]] }, { title: "no run" }, { title: "empty run", run: [] }, { run: [["x.y"]] }, { title: "bad run", run: ["x.y"] }, null],
    "corgi.items.broken": "not a list",
  };
  const rows = entries(["resume", "other", "broken", "gone"], (k) => state[k]);
  assert.deepEqual(rows, [
    { key: "resume-hooks", title: "Resume Claude sessions", subtitle: "Claude Code hooks not set up", run: [["mod.open", { name: "resume" }]] },
    { key: "other-No id", title: "No id", subtitle: "", run: [["x.y"]] },
  ]);
  assert.deepEqual(entries(undefined, () => null), []);
  assert.deepEqual(entries("resume", () => null), []);
});
