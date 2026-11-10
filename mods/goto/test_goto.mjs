// node --test mods/goto/test_goto.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseInput, resolveRepo, rank, tokens, fuzzy, slugOf, originOf, mergeItems, substitute, matchHandlers, contextOf, route, agentTask, branchName, withEnv } from "./match.js";

test("parses GitHub PRs, repos, paths, URLs and text", () => {
  assert.deepEqual(parseInput("https://github.com/octo/ledger/pull/6801/files"), { kind: "pr", owner: "octo", repo: "ledger", number: 6801 });
  assert.deepEqual(parseInput("octo/ledger#6801"), { kind: "pr", owner: "octo", repo: "ledger", number: 6801 });
  assert.deepEqual(parseInput("ledger#6801"), { kind: "pr", owner: null, repo: "ledger", number: 6801 });
  assert.deepEqual(parseInput("#42"), { kind: "pr", owner: null, repo: null, number: 42 });
  assert.deepEqual(parseInput("https://github.com/octo/issue-bot"), { kind: "repo", owner: "octo", repo: "issue-bot" });
  assert.deepEqual(parseInput("github.com/Forge/Forge.git"), { kind: "repo", owner: "Forge", repo: "Forge" });
  assert.deepEqual(parseInput("git@github.com:octo/infra-up.git"), { kind: "repo", owner: "octo", repo: "infra-up" });
  assert.deepEqual(parseInput("octo/infra-up"), { kind: "repo", owner: "octo", repo: "infra-up" });
  assert.deepEqual(parseInput("~/code/Forge"), { kind: "path", path: "~/code/Forge" });
  assert.deepEqual(parseInput("/tmp"), { kind: "path", path: "/tmp" });
  assert.deepEqual(parseInput("https://example.atlassian.net/browse/SHELF-7882"), { kind: "url", url: "https://example.atlassian.net/browse/SHELF-7882" });
  const jira = parseInput("shelf-7882 tracking");
  assert.equal(jira.kind, "text");
  assert.equal(jira.ticket, "SHELF-7882");
  assert.equal(jira.name, null);
  assert.equal(parseInput("issue-bot").name, "issue-bot");
});

test("slugs from remotes and .git/config", () => {
  assert.equal(slugOf("git@github.com:octo/ledger.git"), "octo/ledger");
  assert.equal(slugOf("https://github.com/someone/dots"), "someone/dots");
  assert.equal(originOf('[core]\n\tbare = false\n[remote "origin"]\n\turl = git@github.com:octo/x.git\n\tfetch = +refs'), "git@github.com:octo/x.git");
});

const KNOWN = [
  { slug: "octo/issue-bot", path: "/h/code/IssueBot", context: "red" },
  { slug: "octo/ledger", context: "red", at: 5 },
  { slug: "someone/ledger", context: "blue", at: 9 },
  { slug: "Forge/Forge", path: "/h/code/Forge", context: "blue" },
];

test("resolves a repo name without its owner", () => {
  assert.deepEqual(resolveRepo("issue-bot", null, KNOWN, null).map((r) => r.slug), ["octo/issue-bot"]);
  assert.equal(resolveRepo("ISSUE-BOT", null, KNOWN, null)[0].path, "/h/code/IssueBot");
  // Two owners: the preferred context first, else the most recently used.
  assert.deepEqual(resolveRepo("ledger", null, KNOWN, "red").map((r) => r.slug), ["octo/ledger", "someone/ledger"]);
  assert.deepEqual(resolveRepo("ledger", null, KNOWN, null).map((r) => r.slug), ["someone/ledger", "octo/ledger"]);
  assert.deepEqual(resolveRepo("ledger", "octo", KNOWN, null).map((r) => r.slug), ["octo/ledger"]);
  assert.deepEqual(resolveRepo("nope", null, KNOWN, null), []);
});

test("providers enrich open entries or add their own", () => {
  const docs = [{ id: "t4", kind: "agent", title: "claude", terminal: "t4", refs: ["main"], text: "" }];
  const merged = mergeItems(docs, [
    { provider: "sessions", id: "t4", focus: { terminal: "t4" }, title: "Add due-date reminders", text: "send a reminder mail before a loan is due", keywords: ["SHELF-1"], context: "red" },
    { provider: "chat", id: "reply-t9", title: "Reply to t9", run: [["chat.open", { terminal: "t9" }]], keywords: "reply" },
  ]);
  assert.equal(merged.length, 2);
  assert.equal(merged[0].title, "Add due-date reminders");
  assert.equal(merged[0].context, "red");
  assert.deepEqual(merged[0].refs, ["main", "SHELF-1"]);
  assert.equal(merged[0].text, "send a reminder mail before a loan is due");
  assert.equal(merged[1].id, "chat:reply-t9");
  assert.deepEqual(merged[1].refs, ["reply"]);
  assert.equal(rank("reminder mail", merged)[0].doc.id, "t4");
});

test("handlers match input and substitute captures and variables", () => {
  assert.deepEqual(substitute({ n: "{number}", t: "PR {number}: {title}", keep: "{nope}" }, { number: 7, title: "Fix" }), { n: 7, t: "PR 7: Fix", keep: "{nope}" });
  const handlers = [
    { provider: "review", pattern: "github\\.com/([\\w.-]+)/([\\w.-]+)/pull/(\\d+)", title: "Review PR {2}#{3} · {title}",
      run: [["goto.set", { key: "review.target", value: { repo: "{1}/{2}", number: "{number}" } }], ["layout.switch", { name: "review" }]] },
    { provider: "broken", pattern: "(", title: "never" },
  ];
  const rows = matchHandlers(["ledger#12", "https://github.com/octo/ledger/pull/12"], handlers, { number: 12, title: "Fix login" });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].title, "Review PR ledger#12 · Fix login");
  assert.deepEqual(rows[0].run[0], ["goto.set", { key: "review.target", value: { repo: "octo/ledger", number: 12 } }]);
  assert.deepEqual(matchHandlers(["plain text"], handlers), []);
});

test("context: the entry's own, else the hook's terminal, space, folder or remote rule", () => {
  const hook = { terminals: { t1: "blue" }, spaces: { s1: "red" }, folders: [["~/code", "red"], ["~/code/side", "blue"]], remotes: [["github\\.com/someone/", "blue"]] };
  assert.equal(contextOf({ context: "green", terminal: "t1" }, hook, "/h"), "green");
  assert.equal(contextOf({ terminal: "t1", space: "s1" }, hook, "/h"), "blue");
  assert.equal(contextOf({ space: "s1" }, hook, "/h"), "red");
  assert.equal(contextOf({ path: "/h/code/side/x" }, hook, "/h"), "blue"); // the longest folder wins
  assert.equal(contextOf({ path: "/h/code/x" }, hook, "/h"), "red");
  assert.equal(contextOf({ url: "https://github.com/someone/dots" }, hook, "/h"), "blue");
  assert.equal(contextOf({ path: "/elsewhere" }, hook, "/h"), null);
  assert.equal(contextOf({ space: "s1" }, null, "/h"), null);
});

test("route: through the context hook when one listens here, else run directly", () => {
  const runs = [["goto.set", { key: "k", value: 1 }], ["space.new", { folder: "/x" }]];
  const none = route(runs, "blue", null, "main", 5);
  assert.deepEqual(none, { sets: [{ key: "k", value: 1 }], request: null, run: [["space.new", { folder: "/x" }]] });
  const hook = { request: "ctx.request", layouts: ["main"] };
  const via = route(runs, "blue", hook, "main", 5);
  assert.deepEqual(via.request, { key: "ctx.request", value: { context: "blue", run: [["space.new", { folder: "/x" }]], at: 5 } });
  assert.deepEqual(via.run, []);
  assert.deepEqual(via.sets, [{ key: "k", value: 1 }]);
  // The hook's mod isn't in this layout: nobody would answer, so run here.
  assert.equal(route(runs, "blue", hook, "review", 5).request, null);
});

test("tokens fold umlauts, stem and split camelCase", () => {
  assert.deepEqual(tokens("Erinnerungs-Mails für Ausleihen"), ["erinnerung", "mail", "ausleih"]);
  assert.deepEqual(tokens("IssueBotAutomation"), tokens("issue bot automation"));
  assert.ok(tokens("Lösung für SHELF-7691").includes("shelf-7691"));
  assert.ok(tokens("Lösung").includes("loes"));
});

const DOCS = [
  { id: "t1", title: "Erinnerungs-Mails für Ausleihen", text: "schick eine Erinnerung per Mail, bevor eine Ausleihe fällig ist · the reminder mail goes out two days before the due date", path: "/h" },
  { id: "t2", title: "Split the import job into sync and publish", refs: ["octo/orbit-sync", "infra-terraform"], text: "can you use the terraform registry for the provider", path: "/h/code/OrbitSync" },
  { id: "t3", title: "Track late fees in Ledger", refs: ["SHELF-7882", "https://github.com/octo/ledger/pull/6801"], text: "new pr in octo/ledger: track late fees per loan", path: "/h/code/ledger" },
  { id: "t4", title: "Run the reader app in the iOS simulator", text: "start the ios simulator with the reader app", path: "/h/code/reader" },
];

test("ranks German and English queries against topics", () => {
  assert.equal(rank("erinnerung mail", DOCS)[0].doc.id, "t1");
  assert.equal(rank("reminder mail", DOCS)[0].doc.id, "t1");
  assert.equal(rank("ausleihe fällig", DOCS)[0].doc.id, "t1");
  assert.equal(rank("orbit terraform registry", DOCS)[0].doc.id, "t2");
  assert.equal(rank("SHELF-7882", DOCS)[0].doc.id, "t3");
  assert.equal(rank("ledger#6801", DOCS)[0].doc.id, "t3");
  assert.equal(rank("simulator", DOCS)[0].doc.id, "t4");
  assert.match(rank("two days before", DOCS)[0].snippet, /two days before the due date/);
  assert.deepEqual(rank("zzzz", DOCS), []);
});

test("fuzzy: subsequence, word starts first", () => {
  assert.equal(fuzzy("xyz", "abc"), null);
  const order = ["orbit-sync", "color-bits-yard", "OrbitTraining"].map((t) => [t, fuzzy("osy", t)?.score ?? -1]).sort((a, b) => b[1] - a[1]).map(([t]) => t);
  assert.equal(order[0], "orbit-sync");
  assert.ok(fuzzy("orb", "orbit-sync").score > fuzzy("orb", "color-bright").score);
});

test("start agent: instructions, where they start, branch names, the context's env", () => {
  const places = [{ name: "bookshelf", space: "s1" }, { name: "orbit-sync", folder: "/h/code/orbit-sync" }];
  assert.equal(agentTask("reminder mail", places).instruction, false);
  assert.deepEqual(agentTask("add retry to the mailer", places), { text: "add retry to the mailer", place: null, instruction: true });
  const named = agentTask("Bookshelf: add retry", places);
  assert.equal(named.place.space, "s1");
  assert.equal(named.text, "add retry");
  assert.equal(named.instruction, true);
  assert.equal(agentTask("orbit-sync:  fix the redirect", places).place.folder, "/h/code/orbit-sync");
  assert.deepEqual(agentTask("fix: login", places), { text: "fix: login", place: null, instruction: false }); // not a place
  assert.equal(branchName("Add retry to the Mailer!"), "agent/add-retry-to-the-mailer");
  assert.equal(branchName("Erinnerungs-Mails für Ausleihen"), "agent/erinnerungs-mails-fuer-ausleihen");
  const long = branchName("add retry to the mailer and make the backoff exponential please");
  assert.ok(long.length - "agent/".length <= 40 && !long.endsWith("-"), long);
  assert.equal(branchName("!!!"), "agent/task");
  assert.deepEqual(withEnv(["env", "CLAUDE_CONFIG_DIR=/p", "claude"], { CLAUDE_CONFIG_DIR: null }), ["env", "-u", "CLAUDE_CONFIG_DIR", "claude"]);
  assert.deepEqual(withEnv(["claude"], { CLAUDE_CONFIG_DIR: "/p" }), ["env", "CLAUDE_CONFIG_DIR=/p", "claude"]);
  assert.deepEqual(withEnv(["codex", "--no-daemon"], undefined), ["codex", "--no-daemon"]);
});
