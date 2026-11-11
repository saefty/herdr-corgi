// Run: node test_hint.mjs
import assert from "node:assert/strict";
import { HOUR, startState, shouldShow, withShown, withUse, withDismissed, toggleKeys, waiting } from "./hints.js";

const at = (d, h) => new Date(2026, 0, 1 + d, h).getTime();
const s0 = startState(at(0, 8));

// Inside and after the 28 days.
assert.ok(shouldShow(s0, at(0, 9)));
assert.ok(shouldShow(s0, at(27, 9)));
assert.ok(!shouldShow(s0, at(29, 9)));

// At least 2 h apart, at most 2 a day, a new day starts over.
const a = withShown(s0, at(1, 9));
assert.ok(!shouldShow(a, at(1, 9) + HOUR));
assert.ok(shouldShow(a, at(1, 9) + 2 * HOUR));
const b = withShown(a, at(1, 12));
assert.ok(!shouldShow(b, at(1, 20)));
assert.ok(shouldShow(b, at(2, 9)));

// Three dictations, a dismissal, or no state at all: never.
assert.ok(shouldShow(withUse(withUse(s0)), at(1, 9)));
assert.ok(!shouldShow(withUse(withUse(withUse(s0))), at(1, 9)));
assert.ok(!shouldShow(withDismissed(s0), at(1, 9)));
assert.ok(!shouldShow(null, at(1, 9)));

// The key as shown, and none when unbound.
const keys = [{ section: "global", keys: "cmd-shift-m", action: "dictate.toggle" }];
assert.equal(toggleKeys(keys), "⌘⇧M");
assert.equal(toggleKeys([{ section: "global", keys: "ctrl-alt-f5", action: "dictate.toggle" }]), "⌃⌥f5");
assert.equal(toggleKeys([]), null);

// Only an agent that was working and now waits counts.
assert.ok(waiting("working", "done") && waiting("working", "blocked") && waiting("working", "idle"));
assert.ok(!waiting("idle", "done") && !waiting(undefined, "idle") && !waiting("working", "working"));
console.log("ok");
