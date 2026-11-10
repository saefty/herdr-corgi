// Trims a terminal screen (`hc read --json` text) to what a waiting agent asks:
// numbered choices ("❯ 1. Yes") become options, the lines above them the question.
// Without choices: the last lines above the input box (Claude Code's ─── ❯ ─── area).
// Permission prompts and plan approval also get a card: what is asked, the command or file, a note.

const RULE = /^[\s─━═╌┄┈┅┉\-_╭╮╰╯┌┐└┘]+$/;
const OPTION = /^(?:[❯›>▶]\s*)?(\d)[.)]\s+(.+)$/;

const clean = (l) =>
  l.replace(/ /g, " ")
    .replace(/^\s*[│┃║]\s?/, "")
    .replace(/\s*[│┃║]\s*$/, "")
    .replace(/\s+$/, "");

const isRule = (l) => l.trim().length >= 3 && RULE.test(l);

// Collapse blank runs and drop rules; keep the last `max` lines.
function tail(lines, max) {
  const out = [];
  for (const l of lines) {
    if (isRule(l)) continue;
    if (!l.trim() && (!out.length || !out[out.length - 1].trim())) continue;
    out.push(l);
  }
  while (out.length && !out[out.length - 1].trim()) out.pop();
  const kept = out.slice(-max);
  while (kept.length && !kept[0].trim()) kept.shift();
  // Common indent off, so a boxed prompt reads flush left.
  const indent = Math.min(...kept.filter((l) => l.trim()).map((l) => l.match(/^ */)[0].length));
  return kept.map((l) => l.slice(Number.isFinite(indent) ? indent : 0));
}

// Claude Code's permission headers and what the card asks for each.
const HEADERS = {
  "Bash command": "Run this command?",
  "Edit file": "Edit this file?",
  "Create file": "Create this file?",
  "Write file": "Write this file?",
  "Read file": "Read this file?",
  "Fetch": "Fetch this page?",
  "Web search": "Search the web?",
  "Tool use": "Use this tool?",
};
const PLAN = /keep planning|auto-accept|manually approve/i;

// {kind, title, snippet, note} for a permission prompt or a plan approval, else null.
export function cardFor(above, options) {
  const lines = above.map((l) => l.trim());
  const qi = lines.findLastIndex((l) => l);
  const question = lines[qi] ?? "";
  if (/would you like to proceed\?/i.test(question) || options.some((o) => PLAN.test(o.label))) {
    // The plan's own heading, when it shows.
    const head = lines.slice(0, qi).findLast((l) => /^#{1,3}\s/.test(l));
    return { kind: "plan", title: "Approve the plan?", snippet: head ? head.replace(/^#+\s*/, "") : null, note: null };
  }
  if (!/^(do you want|allow|would you like)/i.test(question) || !/^yes\b/i.test(options[0]?.label ?? "")) return null;
  const hi = lines.slice(0, qi).findLastIndex((l) => l in HEADERS);
  const file = question.match(/(?:make this edit to|create|write to|read) (.+?)\?$/i)?.[1];
  if (hi < 0) return { kind: "permission", title: question, snippet: file ?? null, note: null };
  // Under the header: groups of lines split by blank lines and rules (an edit's diff box ends the first one).
  const groups = [[]];
  for (const l of lines.slice(hi + 1, qi)) {
    if (!l || isRule(l)) { if (groups.at(-1).length) groups.push([]); continue; }
    groups.at(-1).push(l);
  }
  const [first = [], second] = groups.filter((g) => g.length);
  const title = HEADERS[lines[hi]];
  if (file) return { kind: "permission", title, snippet: first[0] ?? file, note: null };
  // Newer Claude Code: the description, then the command in its own box ("│" gutter, gone after clean()).
  if (first.length === 1 && second?.length && lines[hi] === "Bash command") return { kind: "permission", title, snippet: cap(second), note: first[0] };
  if (first.length < 2) return { kind: "permission", title, snippet: first[0] ?? null, note: null };
  // Older: the command, then the agent's description of it on the last line.
  return { kind: "permission", title, snippet: cap(first.slice(0, -1)), note: first.at(-1) };
}

// At most 4 lines of a snippet.
const cap = (ls) => (ls.length > 4 ? [...ls.slice(0, 4), "…"] : ls).join("\n");

export function parseScreen(text, max = 12) {
  const lines = (text ?? "").split("\n").map(clean);
  // The last option block: the last "N. label" line, then upward while lines are options (or blank).
  let end = -1;
  for (let i = lines.length - 1; i >= 0; i--) if (OPTION.test(lines[i].trim())) { end = i; break; }
  if (end >= 0) {
    const options = [];
    let start = end;
    const indentOf = (l) => l.match(/^ */)[0].length;
    const optIndent = indentOf(lines[end].replace(/^(\s*)[❯›>▶]\s*/, "$1"));
    for (let i = end; i >= 0; i--) {
      const m = lines[i].trim().match(OPTION);
      if (m) { options.unshift({ key: m[1], label: m[2].trim() }); start = i; }
      // Between options: blank lines, rules (Claude's "4. Chat about this" sits under one) and
      // indented description lines of the option above (AskUserQuestion) belong to the block.
      else if (lines[i].trim() && !isRule(lines[i]) && indentOf(lines[i]) <= optIndent) break;
    }
    if (options[0]?.key === "1") {
      const card = cardFor(lines.slice(0, start), options);
      return { lines: tail(lines.slice(0, start), Math.max(4, max - options.length)), options, ...(card && { card }) };
    }
  }
  // No choices: cut the input box (the second-to-last rule near the bottom) and what's under it.
  const rules = [];
  for (let i = Math.max(0, lines.length - 10); i < lines.length; i++) if (isRule(lines[i])) rules.push(i);
  const cut = rules.length >= 2 ? rules[rules.length - 2] : lines.length;
  return { lines: tail(lines.slice(0, cut), max), options: [] };
}
