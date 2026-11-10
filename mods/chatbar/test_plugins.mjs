// Run: node --test test_plugins.mjs
import assert from "node:assert/strict";
import { mergeProviders, infoFor, goTo, readRequest, gotoItems, progressLine } from "./plugins.js";

const agent = { address: "t4", space: "s1", space_name: "shop", tab_name: "api", title: "✳ Fix login", status: "blocked", program: { name: "Claude Code" } };

// No providers, no hook: Herdr's own data, no tag, never hidden.
assert.deepEqual(infoFor(agent, undefined, null), { title: "Fix login", context: null, label: null, color: null, hidden: false, progress: null, doing: null, session: null });
assert.equal(infoFor({ ...agent, title: "" }, undefined, null).title, "api");
assert.equal(infoFor({ ...agent, title: "t4" }, undefined, null).title, "api"); // untitled: Herdr titles it by its address
assert.equal(infoFor({ ...agent, title: "", tab_name: "" }, undefined, null).title, "Claude Code");

// The hook: context per space, its label and colour, hidden while another context is current.
const hook = { request: "ctx.go", layouts: ["main"], current: "red", spaces: { s1: "blue" }, labels: { blue: "Blue" }, colors: { blue: "ansi4" } };
assert.deepEqual(infoFor(agent, undefined, hook), { title: "Fix login", context: "blue", label: "Blue", color: "ansi4", hidden: true, progress: null, doing: null, session: null });
assert.equal(infoFor(agent, undefined, { ...hook, current: null }).hidden, false);
assert.equal(infoFor(agent, undefined, { ...hook, terminals: { t4: "red" } }).hidden, false);

// Providers: merged in order (later wins per field, nulls skipped), and they beat the hook.
const extra = mergeProviders(["a", "b", "missing"], (n) => ({ a: { t4: { title: "A", context: "red" } }, b: { t4: { title: "B", hidden: null } } })[n]);
assert.deepEqual(extra, { t4: { title: "B", context: "red" } });
assert.deepEqual(infoFor(agent, extra.t4, hook), { title: "B", context: "red", label: "red", color: null, hidden: false, progress: null, doing: null, session: null });
assert.equal(infoFor(agent, { hidden: true, label: "X", color: "#ff0000" }, null).color, "#ff0000");

// Go to: through the hook only where it listens.
assert.deepEqual(goTo("t4", "blue", hook, "main", 5), { request: { key: "ctx.go", value: { context: "blue", run: [["pane.focus", { terminal: "t4" }]], at: 5 } }, run: [] });
assert.deepEqual(goTo("t4", "blue", hook, "review", 5), { request: null, run: [["pane.focus", { terminal: "t4" }]] });
assert.deepEqual(goTo("t4", null, null, "main", 5).run, [["pane.focus", { terminal: "t4" }]]);

// Requests: pr-review's draft, Go to's open, junk.
assert.deepEqual(readRequest({ action: "draft", terminal: "t7", text: "look at this", from: "pr-review", at: 1 }), { terminal: "t7", text: "look at this", append: false });
assert.deepEqual(readRequest({ action: "open", terminal: "t7" }), { terminal: "t7", text: null, append: false });
// Dictation's answer: appended to what is typed.
assert.deepEqual(readRequest({ action: "draft", terminal: "t7", append: true, text: "and the footer" }), { terminal: "t7", text: "and the footer", append: true });
assert.equal(readRequest({ action: "open", terminal: "t7", append: true }).append, false);
assert.equal(readRequest({ action: "send", terminal: "t7" }), null);
assert.equal(readRequest({ action: "open" }), null);
assert.equal(readRequest(null), null);

// Go to items: needs you and finished only; picking one writes an open request.
const items = gotoItems([
  { a: agent, info: infoFor(agent, undefined, hook) },
  { a: { ...agent, address: "t5", status: "working" }, info: { title: "busy" } },
]);
assert.equal(items.length, 1);
assert.equal(items[0].title, "Reply to Fix login");
assert.equal(items[0].context, "blue");
assert.deepEqual(readRequest(items[0].run[0][1].value), { terminal: "t4", text: null, append: false });

// Progress from a provider: kept when it has a total, "now doing" and the transcript pass through.
const prog = infoFor(agent, { progress: { done: 3, total: 7, eta: 4 }, doing: "Running tests", session: "/x/s.jsonl" }, null);
assert.deepEqual([prog.progress, prog.doing, prog.session], [{ done: 3, total: 7, eta: 4 }, "Running tests", "/x/s.jsonl"]);
assert.equal(infoFor(agent, { progress: { done: 0, total: 0 }, doing: "" }, null).progress, null);
assert.equal(progressLine({ done: 3, total: 7, eta: 4 }), "3/7 · ~4 min left");
assert.equal(progressLine({ done: 3, total: 7, eta: null }), "3/7");
assert.equal(progressLine(null), null);

console.log("ok");
