// Run: node --test test_progress.mjs  (needs python3)
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "chatbar-progress-"));
const script = new URL("./progress.py", import.meta.url).pathname;
const T0 = Date.parse("2026-01-01T10:00:00Z");
const at = (min) => new Date(T0 + min * 60000).toISOString();
const line = (r) => JSON.stringify(r) + "\n";
const tool = (min, name, input, extra = {}) => line({ type: "assistant", timestamp: at(min), cwd: "/work/shop", isSidechain: false,
  message: { content: [{ type: "tool_use", id: `toolu_${name}_${min}`, name, input }] }, ...extra });
const result = (min, id, text, toolUseResult) => line({ type: "user", timestamp: at(min),
  message: { content: [{ type: "tool_result", tool_use_id: id, content: text }] }, toolUseResult });
const run = (file, nowMin, cache) => JSON.parse(execFileSync("python3", [script, "--file", file, "--now", String(T0 + nowMin * 60000),
  ...(cache ? ["--cache", cache] : [])], { encoding: "utf8" }));
const todos = (...st) => ({ todos: st.map((status, i) => ({ content: `Step ${i + 1}`, activeForm: `Doing step ${i + 1}`, status })) });

// TodoWrite: the latest list counts; the in-progress item is "now doing"; ETA from the pace so far.
{
  const f = join(dir, "todo.jsonl");
  writeFileSync(f, [
    tool(0, "TodoWrite", todos("in_progress", "pending", "pending", "pending")),
    tool(1, "Read", { file_path: "/work/shop/src/a.ts" }),
    tool(4, "TodoWrite", todos("completed", "in_progress", "pending", "pending")),
    tool(8, "TodoWrite", todos("completed", "completed", "in_progress", "pending")),
  ].join(""));
  const r = run(f, 9);
  assert.equal(r.done, 2);
  assert.equal(r.total, 4);
  assert.equal(r.doing, "Doing step 3");
  assert.equal(r.eta, 8); // 4 min per step, 2 left
  // Stalled far longer than its pace: no guess.
  assert.equal(run(f, 60).eta, null);
}

// One completion only: no ETA yet. A finished list, then a new one, starts counting again.
{
  const f = join(dir, "todo2.jsonl");
  writeFileSync(f, tool(0, "TodoWrite", todos("completed", "in_progress")));
  assert.equal(run(f, 1).eta, null);
  appendFileSync(f, tool(2, "TodoWrite", todos("completed", "completed")) + tool(3, "TodoWrite", todos("in_progress", "pending", "pending")));
  const r = run(f, 4);
  assert.deepEqual([r.done, r.total, r.doing], [0, 3, "Doing step 1"]);
}

// TaskCreate / TaskUpdate: ids come from the results; deleted tasks leave the count.
{
  const f = join(dir, "tasks.jsonl");
  writeFileSync(f, [
    tool(0, "TaskCreate", { subject: "Write the parser", description: "x", activeForm: "Writing the parser" }),
    result(0, "toolu_TaskCreate_0", "Task #1 created successfully: Write the parser", { task: { id: "1", subject: "Write the parser" } }),
    tool(1, "TaskCreate", { subject: "Add tests", description: "x" }),
    result(1, "toolu_TaskCreate_1", "Task #2 created successfully: Add tests"),
    tool(2, "TaskCreate", { subject: "Drop the old path", description: "x" }),
    result(2, "toolu_TaskCreate_2", "Task #3 created successfully: Drop the old path"),
    tool(3, "TaskUpdate", { taskId: "1", status: "in_progress" }),
    tool(5, "TaskUpdate", { taskId: "1", status: "completed" }),
    tool(6, "TaskUpdate", { taskId: "3", status: "deleted" }),
    tool(7, "TaskUpdate", { taskId: "2", status: "in_progress" }),
  ].join(""));
  const r = run(f, 8);
  assert.deepEqual([r.done, r.total], [1, 2]);
  assert.equal(r.doing, "Add tests"); // no activeForm: the subject
}

// "Now doing" without a list: the last real tool call, paths relative to the session's folder.
{
  const f = join(dir, "tools.jsonl");
  const doing = (name, input) => { writeFileSync(f, tool(0, name, input)); return run(f, 1); };
  assert.deepEqual(doing("Edit", { file_path: "/work/shop/src/loans/reminders.ts" }), { done: null, total: null, eta: null, doing: "Editing src/loans/reminders.ts" });
  assert.equal(doing("Bash", { command: "npm test", description: "Running tests" }).doing, "Running tests");
  assert.equal(doing("Bash", { command: "npm test" }).doing, "Running npm test");
  assert.equal(doing("Write", { file_path: "/elsewhere/notes.md" }).doing, "Writing /elsewhere/notes.md");
  assert.equal(doing("Grep", { pattern: "TODO" }).doing, "Searching for TODO");
  assert.equal(doing("WebFetch", { url: "https://example.com/docs" }).doing, "Fetching example.com");
  assert.equal(doing("mcp__tracker__get_issue", {}).doing, "tracker: get_issue");
  assert.equal(doing("Agent", { description: "Review the diff" }).doing, "Delegating: Review the diff");
  // Bookkeeping isn't doing anything; a sub-agent's lines aren't the agent's.
  writeFileSync(f, tool(0, "Read", { file_path: "/work/shop/a.ts" }) + tool(1, "TaskList", {}) + tool(2, "Bash", { command: "ls" }, { isSidechain: true }));
  assert.equal(run(f, 3).doing, "Reading a.ts");
}

// Incremental: the cache keeps the parse; appended lines (and a half-written one) are picked up once complete.
{
  const f = join(dir, "inc.jsonl"), cache = join(dir, "cache.json");
  writeFileSync(f, tool(0, "TodoWrite", todos("in_progress", "pending")));
  assert.equal(run(f, 1, cache).done, 0);
  const next = tool(2, "TodoWrite", todos("completed", "in_progress"));
  appendFileSync(f, next.slice(0, 40));
  assert.equal(run(f, 3, cache).done, 0);
  appendFileSync(f, next.slice(40));
  assert.equal(run(f, 3, cache).done, 1);
}

console.log("ok");
