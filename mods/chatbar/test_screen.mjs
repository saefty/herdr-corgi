// Run: node --test test_screen.mjs
import assert from "node:assert/strict";
import { parseScreen } from "./screen.js";

// Claude Code permission prompt: options become buttons, the question stays above them.
const perm = [
  "⏺ I'll remove the build folder.",
  "",
  "────────────────────────────────────────",
  " Bash command",
  "",
  "   rm -rf build",
  "   Remove build output",
  "",
  " Do you want to proceed?",
  " ❯ 1. Yes",
  "   2. Yes, and don't ask again for rm commands in /repo",
  "   3. No, and tell Claude what to do differently (esc)",
  "",
  " Esc to cancel · Tab to amend",
].join("\n");
const p = parseScreen(perm);
assert.deepEqual(p.options.map((o) => o.key), ["1", "2", "3"]);
assert.equal(p.options[0].label, "Yes");
assert.equal(p.lines.at(-1).trim(), "Do you want to proceed?");
assert.ok(p.lines.some((l) => l.trim() === "rm -rf build"));
assert.ok(!p.lines.some((l) => l.includes("Esc to cancel")));

// A question without choices: the input box and footer below it are cut.
const ask = [
  "⏺ Which region should I deploy to?",
  "",
  "✻ Cogitated for 6s",
  "────────────────────────────",
  "❯ ",
  "────────────────────────────",
  "  repo main",
  "  ⏵⏵ auto mode on",
].join("\n");
const a = parseScreen(ask);
assert.deepEqual(a.options, []);
assert.equal(a.lines.at(-1), "✻ Cogitated for 6s");
assert.equal(a.lines[0], "⏺ Which region should I deploy to?");

// Boxed prompt (older Claude Code) and max lines.
const boxed = ["╭──────────╮", "│ Allow?   │", "│ ❯ 1. Yes │", "│   2. No  │", "╰──────────╯"].join("\n");
const b = parseScreen(boxed);
assert.deepEqual(b.options, [{ key: "1", label: "Yes" }, { key: "2", label: "No" }]);
assert.deepEqual(b.lines, ["Allow?"]);
assert.equal(parseScreen(Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n")).lines.length, 12);
assert.deepEqual(parseScreen(""), { lines: [], options: [] });

console.log("ok");

// AskUserQuestion: options with indented descriptions and a rule before the last option.
{
  const ask = [
    "How should we do this?", "",
    "❯ 1. Build a small version (Recommended)",
    "     Adds one source to the existing list.",
    "  2. Hand it to the other session",
    "     Writes a short brief for it.",
    "  3. Type something.",
    "────────────────────────",
    "  4. Chat about this", "",
    "Enter to select · ↑/↓ to navigate · Esc to cancel",
  ].join("\n");
  const r = parseScreen(ask);
  if (r.options.map((o) => o.key).join() !== "1,2,3,4") throw new Error("ask options: " + JSON.stringify(r.options));
  if (!r.lines.some((l) => l.includes("How should we do this?"))) throw new Error("ask question: " + JSON.stringify(r.lines));
  console.log("ok ask");
}

// Answer cards: permission prompts and plan approval, from realistic Claude Code screens.
{
  const screen = (...l) => parseScreen(l.join("\n"));

  // Bash: the command in the snippet, the agent's description as the note.
  const bash = screen(
    "⏺ Running the test suite before the commit.",
    "",
    "╭───────────────────────────────────────────────────────────╮",
    "│ Bash command                                              │",
    "│                                                           │",
    "│   npm test -- --run src/cart                              │",
    "│   Run the cart tests                                      │",
    "│                                                           │",
    "│ Do you want to proceed?                                   │",
    "│ ❯ 1. Yes                                                  │",
    "│   2. Yes, and don't ask again for npm test commands in    │",
    "│      /work/shop                                           │",
    "│   3. No, and tell Claude what to do differently (esc)     │",
    "╰───────────────────────────────────────────────────────────╯");
  assert.deepEqual(bash.card, { kind: "permission", title: "Run this command?", snippet: "npm test -- --run src/cart", note: "Run the cart tests" });
  assert.deepEqual(bash.options.map((o) => o.key), ["1", "2", "3"]);

  // Newer Bash prompt: description first, then the command in a dashed box with a gutter.
  const boxed = screen(
    "⏺ Checking that the build still passes",
    "",
    "────────────────────────────────────────────────────────────",
    " Bash command",
    " Build the site and list the output",
    "╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌",
    " │ cd site && npm run build 2>&1 | tail -5; ls -la dist |",
    " │ head -20",
    "╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌",
    " This command requires approval",
    "",
    " Do you want to proceed?",
    " ❯ 1. Yes",
    "   2. Yes, and always allow access to dist/ from this project",
    "   3. No",
    "",
    " Esc to cancel · Tab to amend");
  assert.deepEqual(boxed.card, { kind: "permission", title: "Run this command?",
    snippet: "cd site && npm run build 2>&1 | tail -5; ls -la dist |\nhead -20", note: "Build the site and list the output" });

  // Edit: the file, not the diff.
  const edit = screen(
    "────────────────────────────────────────────",
    " Edit file",
    " src/cart/total.ts",
    "╭──────────────────────────────────────────╮",
    "│ 12 -  return items.reduce(sum, 0);       │",
    "│ 12 +  return round(items.reduce(sum, 0));│",
    "╰──────────────────────────────────────────╯",
    " Do you want to make this edit to total.ts?",
    " ❯ 1. Yes",
    "   2. Yes, allow all edits during this session (shift+tab)",
    "   3. No, and tell Claude what to do differently (esc)",
    "");
  assert.deepEqual(edit.card, { kind: "permission", title: "Edit this file?", snippet: "src/cart/total.ts", note: null });

  // Create file.
  const create = screen(" Create file", " docs/notes.md", "╭───╮", "│ 1 # Notes │", "╰───╯", " Do you want to create notes.md?", " ❯ 1. Yes", "   2. Yes, allow all edits during this session (shift+tab)", "   3. No");
  assert.equal(create.card.title, "Create this file?");
  assert.equal(create.card.snippet, "docs/notes.md");

  // Fetch and MCP tool use.
  const fetch = screen(" Fetch", "", "   https://example.com/api/docs", "   Claude wants to fetch content from example.com", "", " Do you want to allow Claude to fetch this content?", " ❯ 1. Yes", "   2. Yes, and don't ask again for example.com", "   3. No, and tell Claude what to do differently (esc)");
  assert.deepEqual(fetch.card, { kind: "permission", title: "Fetch this page?", snippet: "https://example.com/api/docs", note: "Claude wants to fetch content from example.com" });
  const mcp = screen(" Tool use", "", "   tracker - get_issue(id: \"A-12\") (MCP)", "", " Do you want to proceed?", " ❯ 1. Yes", "   2. Yes, and don't ask again for tracker - get_issue commands", "   3. No");
  assert.deepEqual(mcp.card, { kind: "permission", title: "Use this tool?", snippet: "tracker - get_issue(id: \"A-12\") (MCP)", note: null });

  // An unknown permission prompt: the question is the title.
  const other = screen(" Allow the agent to open the browser?", " ❯ 1. Yes", "   2. No");
  assert.deepEqual(other.card, { kind: "permission", title: "Allow the agent to open the browser?", snippet: null, note: null });

  // Plan approval: the plan's heading, the plan text stays in the lines.
  const plan = screen(
    " Ready to code?",
    "",
    " Here is Claude's plan:",
    "╭──────────────────────────────────────╮",
    "│ # Round cart totals                  │",
    "│                                      │",
    "│ 1. Add round() to the total          │",
    "│ 2. Cover it with a test              │",
    "╰──────────────────────────────────────╯",
    "",
    " Would you like to proceed?",
    "",
    " ❯ 1. Yes, and auto-accept edits",
    "   2. Yes, and manually approve edits",
    "   3. No, keep planning",
    "",
    " ctrl-g to edit in your editor");
  assert.deepEqual(plan.card, { kind: "plan", title: "Approve the plan?", snippet: "Round cart totals", note: null });
  assert.equal(plan.options.length, 3);
  assert.ok(plan.lines.some((l) => l.includes("Cover it with a test")));

  // A plain multiple-choice question is no card.
  assert.equal(screen("Which database?", "❯ 1. Postgres", "  2. SQLite").card, undefined);
  console.log("ok cards");
}
