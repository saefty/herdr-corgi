// Go to: one box that works out what you typed or pasted, and finds what is already open first.
// - Text: ranks open agents, terminals, named tabs and spaces (title, keywords, text, folder), then local
//   git repos, provider items, layouts and app commands.
// - A GitHub PR (URL, owner/repo#n, repo#n, #n), a repo (URL, owner/repo, a bare name), a path, any URL.
// - Other mods plug in through shared state only (PROVIDERS.md, contract version API_VERSION): items, input
//   handlers, repos, a context hook that carries out commands (e.g. switching a view first), and "Ask".
// Looks like the app's command palette: a popup at the top, a 36 px search line, 32 px rows.

import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { agents, spaces, panes, commands, layouts, keys, shared, setShared, run, exec, theme, props, closeOverlay, appHome, home, readTextFile, writeTextFile, notify, focused, knownAgents } from "herdr";
import { parseInput, resolveRepo, rank, prepare, fieldTokens, slugOf, originOf, expandHome, mergeItems, matchHandlers, contextOf, route, agentTask, branchName, withEnv } from "./match.js";

const API_VERSION = 1;
const SHOWN = 10, ROW_H = 32, LIST_H = SHOWN * ROW_H;
const SCAN_EVERY = 10 * 60000, SCAN_MAX = 600, REMOTE_MAX = 200, REMOTE_TTL = 24 * 3600000, ASK_WAIT = 90000;
// Neutral defaults; goto.config.json in the app home overrides them (roots, depth, cloneTo per context).
const DEFAULTS = { roots: ["~/code", "~/src", "~/projects", "~/dev"], depth: 4, cloneTo: { default: "~/code" } };
const ICON = (n) => `mods/workspace-chrome/${n}.svg`;
const STATUS = { blocked: ["needs you", "blocked"], done: ["finished", "done"], working: ["working", "working"], idle: ["idle", "dim"] };
const KIND_TIP = { agent: "Jump to this agent session.", terminal: "Jump to this terminal.", tab: "Jump to this tab.", space: "Switch to this space.", command: "Run this command.", layout: "Switch to this layout.", url: "Open this link in your browser.", pr: "Open this pull request.", repo: "Open this repository.", start: "Start a new agent session.", new: "Open this folder as a new space.", clone: "Clone this repository and open it as a space.", handler: "Run this action.", ask: "Ask an agent to find the matching session." };
const TITLES = { "app.palette": "Command palette", "app.settings": "Settings", "app.help": "Keys" };

const configFile = () => `${appHome()}/goto.config.json`;
const cacheFile = () => `${appHome()}/data/goto/cache.json`;
const providers = () => shared("goto.providers") ?? [];
const fromProviders = (kind) => providers().flatMap((p) => (shared(`goto.${kind}.${p}`) ?? []).map((x) => ({ ...x, provider: p })));
const hook = () => shared("goto.context") ?? null;
const live = (reg) => reg && (!reg.layouts || reg.layouts.includes(shared("layout")));
const clean = (s) => (s ?? "").replace(/^[^\p{L}\p{N}]+/u, "").trim();
const base = (p) => (p ?? "").replace(/\/+$/, "").split("/").pop();
const tilde = (p) => (p && p.startsWith(home() + "/") ? `~${p.slice(home().length)}` : p);
const within = (p, root) => Boolean(p && root) && (p === root || p.startsWith(root + "/"));
const titleOf = (name) => TITLES[name] ?? (([n, v]) => `${v.replace(/_/g, " ")} ${n}`.replace(/^./, (c) => c.toUpperCase()))(name.split("."));

function ago(ms) {
  if (!ms) return "";
  const m = Math.floor((Date.now() - (ms < 1e12 ? ms * 1000 : ms)) / 60000);
  return m < 1 ? "now" : m < 60 ? `${m}m` : m < 1440 ? `${Math.floor(m / 60)}h` : `${Math.floor(m / 1440)}d`;
}

export default class Goto extends View {
  init(_props, cx) {
    // Others detect the contract here; they publish their keys regardless, so load order doesn't matter.
    if (shared("goto.api")?.version !== API_VERSION) setShared("goto.api", { version: API_VERSION });
    this.query = "";
    this.at = 0;
    this.scroll = 0;
    this.config = DEFAULTS;
    this.repos = [];      // local clones: {path, name, slug}
    this.remote = {};     // bare name -> {at, slugs} from gh (cached in data/goto/cache.json)
    this.looking = new Set();
    this.prInfo = {};     // "owner/repo#n" -> gh pr view result | {loading} | {error}
    this.asked = null;    // {query, at, loading} | {query, matches} | {query, error}
    this.busy = null;     // "Cloning owner/repo…" while a clone runs (the box stays open)
    this.list = [];       // the rows shown: computed by refresh() off the render path, render only reads them
    this.tokCache = new Map(); // open entry id -> {key, tok}: its tokens while its text is unchanged
    this.tick = 0;
    this.input = InputState.new({ placeholder: "Go to a session, space, repo, PR or command…" });
    this.input.on("change", (_e, cx) => {
      const q = this.input.value();
      this.query = q; this.at = 0; this.scroll = 0;
      this.schedule(cx, 50);
      cx.timer.after(450, (cx) => { if (this.query === q) this.lookup(cx); });
    });
    this.input.on("submit", (_e, cx) => this.go(this.list[this.at], cx));
    this.input.focus();
    cx.timer.after(600, () => this.input.focus());
    this.handle = cx.focus_handle();
    this.reindex();
    this.schedule(cx, 0);
    // Statuses, titles and providers move while the box is open; rows follow every 2 s (data, not animation).
    cx.timer.every(2000, (cx) => { this.reindex(); this.refresh(cx); });
    cx.spawn(async (cx) => {
      await this.load();
      this.reindex(); this.refresh(cx);
      if (Date.now() - (this.scannedAt ?? 0) > SCAN_EVERY) { await this.scan(); this.reindex(); this.refresh(cx); }
    });
    cx.spawn(async (cx) => {
      // "#123" means a PR in the shown space's repo.
      const cwd = focused()?.cwd;
      const r = cwd ? await exec("git", ["-C", cwd, "remote", "get-url", "origin"]).catch(() => null) : null;
      this.activeSlug = r?.code === 0 ? slugOf(r.stdout.trim()) : null;
      this.refresh(cx);
    });
    // "Start agent" uses the agent people pick most (knownAgents: most picked first).
    cx.spawn(async (cx) => {
      this.agent = (await knownAgents().catch(() => [])).find((a) => a.installed && a.run?.length) ?? null;
      this.refresh(cx);
    });
  }

  close() { closeOverlay(props().overlay); }

  // ---- data ----

  async readJson(path) {
    try { return JSON.parse((await readTextFile(path)) ?? "null"); } catch { return null; }
  }

  async load() {
    const c = await this.readJson(configFile());
    this.config = { ...DEFAULTS, ...(c ?? {}), cloneTo: { ...DEFAULTS.cloneTo, ...(c?.cloneTo ?? {}) } };
    const cache = await this.readJson(cacheFile());
    if (cache) { this.repos = cache.repos ?? []; this.scannedAt = cache.at; this.remote = cache.remote ?? {}; }
    if (JSON.stringify(cache?.roots) !== JSON.stringify(this.config.roots)) this.scannedAt = 0; // other roots: scan again
  }

  // Git repos under the configured roots, a few levels deep.
  async scan() {
    const roots = this.config.roots.map((r) => expandHome(r, home()));
    const r = await exec("find", [...roots, "-maxdepth", String(this.config.depth + 1), "(", "-name", "node_modules", "-o", "-name", ".terraform", "-o", "-name", ".venv", ")", "-prune",
      "-o", "-name", ".git", "-print", "-prune"], { timeout: 20000 }).catch(() => null);
    if (!r?.stdout) return;
    const repos = [];
    for (const git of r.stdout.split("\n").filter(Boolean).slice(0, SCAN_MAX)) {
      const path = git.replace(/\/\.git$/, "");
      // ponytail: a worktree's .git is a file without the origin; it's found by name only.
      const url = originOf(await readTextFile(`${git}/config`).catch(() => null));
      repos.push({ path, name: base(path), slug: slugOf(url) });
    }
    this.repos = repos;
    this.scannedAt = Date.now();
    await this.save();
  }

  async save() {
    const now = Date.now();
    const remote = Object.fromEntries(Object.entries(this.remote).filter(([, v]) => now - v.at < REMOTE_TTL).slice(-REMOTE_MAX));
    await exec("mkdir", ["-p", `${appHome()}/data/goto`]).catch(() => null);
    const before = await readTextFile(cacheFile()).catch(() => null);
    await writeTextFile(cacheFile(), JSON.stringify({ at: this.scannedAt, roots: this.config.roots, repos: this.repos, remote }), before).catch(() => null);
  }

  // Indexes, rebuilt only when caches load or providers change (never per keystroke): repo name -> every repo
  // known by that name, owner -> context, and the searchable lists tokenized once.
  reindex() {
    const h = hook(), provided = fromProviders("repos"), items = fromProviders("items").filter((it) => it.run);
    const sig = JSON.stringify([this.scannedAt, Object.keys(this.remote).length, provided, items, h?.folders, h?.remotes, h?.current]);
    if (sig === this.indexSig) return;
    this.indexSig = sig;
    const ctx = (doc) => contextOf(doc, h, home());
    const gh = (slug) => slug && `https://github.com/${slug}`;
    const local = this.repos.filter((r) => r.slug).map((r) => ({ slug: r.slug, path: r.path, context: ctx({ path: r.path, url: gh(r.slug) }) }));
    const given = provided.filter((r) => r.owner && r.name).map((r) => ({ slug: `${r.owner}/${r.name}`, path: r.path ?? null,
      context: r.context ?? ctx({ path: r.path, url: gh(`${r.owner}/${r.name}`) }), at: r.at ?? 0 }));
    this.owners = new Map();
    for (const k of [...local, ...given]) {
      const o = k.slug.split("/")[0].toLowerCase();
      if (k.context && !this.owners.has(o)) this.owners.set(o, k.context);
    }
    const remote = Object.values(this.remote).flatMap((v) => v.slugs.map((slug) => ({ slug, context: this.ownerContext(slug) })));
    const all = [...local, ...given, ...remote];
    this.byName = new Map();
    for (const k of all) {
      const n = k.slug.split("/")[1]?.toLowerCase();
      if (n) (this.byName.get(n) ?? this.byName.set(n, []).get(n)).push(k);
    }
    const localSlugs = new Set(local.map((r) => r.slug.toLowerCase()));
    const others = [...new Map(all.filter((k) => !localSlugs.has(k.slug.toLowerCase())).map((k) => [k.slug.toLowerCase(), k])).values()];
    this.repoDocs = prepare(this.repos.map((r) => ({ ...r, id: r.path, title: r.name, refs: [r.slug].filter(Boolean), context: ctx({ path: r.path, url: gh(r.slug) }) })));
    this.remoteDocs = prepare(others.map((k) => ({ ...k, id: k.slug, title: k.slug.split("/")[1], refs: [k.slug] })));
    // Provider items that run something (not ones that focus what is open): searched like commands.
    this.itemDocs = prepare(mergeItems([], items).map((d) => ({ ...d, title: d.title ?? d.id, text: d.text ?? "" })));
    this.cmdDocs ??= prepare(this.commandDocs());
  }

  candidates(name) { return this.byName.get((name ?? "").toLowerCase()) ?? []; }

  ownerContext(slug) {
    return this.owners.get(slug.split("/")[0].toLowerCase()) ?? contextOf({ url: `https://github.com/${slug}` }, hook(), home());
  }

  // Last step for a name nobody local knows: ask GitHub under the owners seen so far (async, cached).
  lookup(cx) {
    const p = parseInput(this.query);
    const name = p.kind === "pr" ? p.repo : p.kind === "text" ? p.name : null;
    if (!name || name.length < 3 || (p.kind === "pr" && p.owner)) return;
    const key = name.toLowerCase();
    if (this.remote[key] || this.looking.has(key) || this.candidates(name).length) return;
    // Plain words only when nothing open matched them (a typo shouldn't cost gh calls).
    if (p.kind === "text" && !/[-._]/.test(name) && this.list.some((r) => r.tier <= 1)) return;
    const owners = [...new Set([...this.repos.map((r) => r.slug), ...fromProviders("repos").map((r) => `${r.owner}/${r.name}`)]
      .map((s) => s?.split("/")[0]).filter((o) => o && o !== "undefined"))].slice(0, 6);
    if (!owners.length) return;
    this.looking.add(key);
    cx.spawn(async (cx) => {
      const slugs = [];
      await Promise.all(owners.map(async (o) => {
        const r = await exec("gh", ["repo", "view", `${o}/${name}`, "--json", "nameWithOwner"], { timeout: 15000 }).catch(() => null);
        try { if (r?.code === 0) slugs.push(JSON.parse(r.stdout).nameWithOwner); } catch {}
      }));
      this.remote[key] = { at: Date.now(), slugs };
      this.looking.delete(key);
      this.reindex(); this.refresh(cx);
      await this.save();
    });
  }

  // A PR's title and state via `gh pr view` (started from refresh, which has a cx).
  pr(slug, number) {
    const key = `${slug}#${number}`;
    if (!this.prInfo[key]) this.prInfo[key] = { loading: true, slug, number };
    return this.prInfo[key];
  }

  fetchPrs(cx) {
    for (const [key, v] of Object.entries(this.prInfo)) {
      if (!v.loading || v.started) continue;
      v.started = true;
      cx.spawn(async (cx) => {
        const r = await exec("gh", ["pr", "view", String(v.number), "-R", v.slug, "--json", "url,number,title,state,headRefName,baseRefName,headRefOid"], { timeout: 20000 }).catch((e) => ({ code: 1, stderr: String(e) }));
        try {
          const d = JSON.parse(r.stdout);
          this.prInfo[key] = { url: d.url, number: d.number, title: d.title, repo: v.slug, state: d.state.toLowerCase(), head: d.headRefName, base: d.baseRefName, headSha: d.headRefOid };
        } catch { this.prInfo[key] = { error: (r.stderr || "not found").trim().split("\n")[0] }; }
        this.refresh(cx);
      });
    }
  }

  // ---- what is open ----

  openDocs() {
    const ss = spaces(), ps = panes();
    const tabs = new Map(ss.flatMap((s) => s.tabs.map((t) => [t.id, [s, t]])));
    const docs = [], agentSet = new Set();
    const tabName = (t) => (t?.named ? t.name : null);
    for (const a of agents()) {
      agentSet.add(a.address);
      const p = ps.find((x) => x.terminal === a.address);
      const [, tab] = tabs.get(a.tab) ?? [];
      docs.push({ id: a.address, kind: "agent", title: tabName(tab) || clean(a.title) || a.program?.name || a.address,
        refs: [p?.branch, a.program?.name, a.space_name, tabName(tab)].filter(Boolean), text: "", path: p?.cwd, status: a.status,
        program: a.program, changed: tab?.changed_at, where: [a.space_name, tab?.name].filter(Boolean).join(" · "),
        branch: p?.branch, space: a.space, tab: a.tab, terminal: a.address });
    }
    for (const p of ps) {
      if (!p.terminal || agentSet.has(p.terminal) || !tabs.has(p.tab)) continue;
      const [sp, tab] = tabs.get(p.tab);
      docs.push({ id: p.terminal, kind: "terminal", title: clean(p.title) || p.program?.name || p.terminal,
        refs: [p.branch, p.program?.name, sp.name, tabName(tab)].filter(Boolean), path: p.cwd, program: p.program,
        where: `${sp.name} · ${tab.name}`, branch: p.branch, space: sp.id, tab: p.tab, terminal: p.terminal });
    }
    for (const s of ss) {
      const cwds = ps.filter((p) => tabs.get(p.tab)?.[0] === s && p.cwd).map((p) => p.cwd);
      for (const t of s.tabs.filter((t) => t.named)) {
        docs.push({ id: t.id, kind: "tab", title: t.name, refs: [s.name], status: t.status, changed: t.changed_at, where: s.name, space: s.id, tab: t.id });
      }
      docs.push({ id: s.id, kind: "space", title: s.name, refs: [s.branch, ...new Set(cwds.map(base))].filter(Boolean), path: s.folder,
        status: s.status, where: `${s.tabs.length} tab${s.tabs.length === 1 ? "" : "s"}`, space: s.id, cwds: [s.folder, ...cwds] });
    }
    // Providers enrich what is open (a session's title, topic, keywords) or add entries that focus something.
    const merged = mergeItems(docs, fromProviders("items").filter((it) => !it.run));
    const h = hook();
    for (const d of merged) {
      d.context = contextOf(d, h, home());
      const key = [d.title, d.text, ...(d.refs ?? []), d.path].join("\u0000");
      const hit = this.tokCache.get(d.id);
      if (hit?.key === key) d._tok = hit.tok;
      else { d._tok = fieldTokens(d); this.tokCache.set(d.id, { key, tok: d._tok }); }
    }
    return merged;
  }

  // The open space (and its shown tab) working in a folder, for the duplicate guard.
  spaceIn(path, docs) {
    // Prefer the space named after the folder, then one made there, then any with a terminal in it.
    const all = docs.filter((d) => d.kind === "space" && d.cwds.some((c) => within(c, path)));
    const sp = all.find((d) => d.title.toLowerCase() === base(path).toLowerCase()) ?? all.find((d) => within(d.path, path)) ?? all[0];
    if (!sp) return null;
    const s = spaces().find((x) => x.id === sp.space);
    return { doc: sp, label: `${s.name} · ${(s.tabs.find((t) => t.active) ?? s.tabs[0])?.name ?? ""}` };
  }

  // ---- rows ----

  // Typing waits `ms` for the next key; only the last one computes.
  schedule(cx, ms) {
    const n = ++this.tick;
    cx.timer.after(ms, (cx) => { if (n === this.tick) this.refresh(cx); });
  }

  refresh(cx) {
    const seen = new Set();
    this.list = this.compute(this.query.trim()).sort((a, b) => a.tier - b.tier || b.score - a.score).filter((r) => !seen.has(r.id) && seen.add(r.id));
    // Demo only (RECIPE.md, "Demo"): while a demo query is set, the rows' titles go to "goto.demo.rows" for scripts.
    if (typeof shared("goto.demo.query") === "string") {
      const rows = { query: this.query, titles: this.list.map((r) => r.title) };
      if (JSON.stringify(rows) !== JSON.stringify(shared("goto.demo.rows"))) setShared("goto.demo.rows", rows);
    }
    this.fetchPrs(cx);
    cx.notify();
  }

  openRow(d, score = 0, hit = null) {
    return { id: `o:${d.id}`, tier: d.terminal || d.space || d.tab ? 1 : 2, score: score * (d.weight ?? 1), doc: d, kind: d.kind, title: d.title, hits: hit?.hits,
      context: d.context, tag: d.tag, sub: hit?.snippet ?? d.where, act: () => (d.run ? this.perform(d.context, d.run) : this.focus(d)) };
  }

  compute(q) {
    const docs = this.openDocs();
    const urgency = { blocked: 4, done: 3, working: 2 };
    if (!q) {
      const ms = (c) => (!c ? 0 : c < 1e12 ? c * 1000 : c);
      return docs.filter((d) => d.kind !== "tab").map((d) => this.openRow(d, (urgency[d.status] ?? 0) * 1e13 + (d.kind === "space" ? 0 : ms(d.changed))));
    }
    const p = parseInput(q), out = [];
    const add = (r) => out.push(r);
    const guard = (path, newRow) => {
      const hit = path && this.spaceIn(path, docs);
      if (hit) {
        add({ ...this.openRow(hit.doc, 1e6), id: `already:${path}`, tier: 0, title: `Already open: ${hit.label}`, sub: tilde(path) });
        add({ ...newRow, tier: 0, score: 1, title: "Open new anyway", sub: newRow.title });
      } else add({ ...newRow, tier: 0, score: 1e5 });
    };
    const vars = { query: q, layout: shared("layout") ?? "" };

    if (p.kind === "url") add({ id: "browser", tier: 0, score: 1, kind: "url", icon: "↗", title: "Open in browser", sub: p.url, act: () => this.browse(p.url) });

    if (p.kind === "path") {
      const path = expandHome(p.path, home());
      guard(path, this.newSpace(path, base(path) || path, contextOf({ path }, hook(), home())));
    }

    if (p.kind === "repo") this.repoRows(p.repo, p.owner, docs, guard, add);

    if (p.kind === "pr") {
      const slugs = p.owner ? [`${p.owner}/${p.repo}`]
        : p.repo ? resolveRepo(p.repo, null, this.candidates(p.repo), hook()?.current).map((r) => r.slug).slice(0, 3)
        : this.activeSlug ? [this.activeSlug] : [];
      if (!slugs.length) {
        const why = p.repo ? (this.looking.has(p.repo.toLowerCase()) ? `Looking for "${p.repo}" on GitHub…` : `No repo "${p.repo}" known here`) : "The shown space isn't in a GitHub repo";
        add({ id: "pr-none", tier: 0, score: 0, kind: "pr", icon: "?", title: `PR #${p.number}`, sub: why });
      }
      slugs.forEach((slug, i) => this.prRows(slug, p.number, docs, add, vars, 1e5 - i * 10));
    }

    // Handlers see the raw input; for a PR, prRows matches them against its canonical URL too.
    if (p.kind !== "pr") for (const h of matchHandlers([q], fromProviders("handlers"), vars)) add(this.handlerRow(h, 1e5));

    if (p.kind === "text") {
      const hits = rank(q, docs);
      const best = new Map();
      for (const h of hits) best.set(h.doc.id, this.openRow(h.doc, h.score, h));
      // Local repos (partial names match too): one with an open space is already open, else "Open as space".
      for (const h of rank(q, this.repoDocs).slice(0, 8)) {
        const r = h.doc, exact = r.name.toLowerCase() === q.toLowerCase() || r.slug?.toLowerCase().endsWith(`/${q.toLowerCase()}`);
        const sp = this.spaceIn(r.path, docs);
        if (sp) {
          // The space already matched under its own name: keep that row.
          if (!best.has(sp.doc.id)) best.set(sp.doc.id, { ...this.openRow(sp.doc, h.score + (exact ? 20 : 0)), title: `Already open: ${sp.label}`, sub: tilde(r.path) });
        } else add({ ...this.newSpace(r.path, r.name, r.context), sub: r.slug ?? tilde(r.path), score: h.score + (exact ? 20 : 0) });
      }
      out.push(...best.values());
      // Repos known only remotely (providers, gh lookups): clone on explicit choice.
      for (const h of rank(q, this.remoteDocs).slice(0, 4)) add({ ...this.cloneRow(h.doc.slug, h.doc.context), score: h.score * 0.6 });
      if (p.name && this.looking.has(p.name.toLowerCase())) add({ id: "looking", tier: 2, score: 0, kind: "repo", spin: true, title: `Looking for "${p.name}" on GitHub…` });
      for (const h of rank(q, this.itemDocs).slice(0, 6)) add({ ...this.openRow(h.doc, h.score * 0.8, h), tier: 2 });
      for (const h of rank(q, this.cmdDocs).slice(0, 8)) add({ ...h.doc, tier: 2, score: h.score * 0.7, hits: h.hits, sub: h.snippet ?? h.doc.sub });
      this.askRows(q, docs, hits, add);
      this.agentRows(q, docs, add);
      // A repo name that matches nothing local may be on GitHub (lookup() fills this.remote).
      if (p.name && !this.repos.some((r) => r.name.toLowerCase() === p.name.toLowerCase())) {
        for (const k of resolveRepo(p.name, null, this.candidates(p.name), hook()?.current)) add({ ...this.cloneRow(k.slug, k.context), score: 25 });
      }
    }
    return out;
  }

  // "Start agent: <text>": high for an instruction (4+ words or "<space or repo>: text"), else the last row. It starts
  // in the named space or repo, else the shown space; an open session that matches the text comes first.
  agentRows(q, docs, add) {
    if (q.length < 3) return;
    const ss = spaces(), ps = panes();
    const where = (s) => ps.find((x) => s.tabs.some((t) => t.id === x.tab) && x.cwd)?.cwd ?? s.folder;
    const places = [...ss.map((s) => ({ name: s.name, space: s.id, folder: where(s), git: Boolean(s.branch), machine: s.machine ?? null })),
      ...this.repos.map((r) => ({ name: r.name, folder: r.path, git: true, machine: null }))];
    const t = agentTask(q, places);
    const active = ss.find((s) => s.active);
    let at = t.place ?? (active ? { ...places.find((x) => x.space === active.id), folder: focused()?.cwd ?? where(active) } : { name: "~", folder: home(), machine: null });
    if (!at.space && at.folder !== home()) { // a repo: the space already working there, if any
      const sp = ss.find((s) => where(s) && within(where(s), at.folder));
      if (sp) at = { ...at, space: sp.id, name: sp.name };
    }
    if (t.instruction) {
      // Ranked on the instruction alone (not the place's name), and most of its words.
      const same = rank(t.text, docs).find((h) => h.doc.kind === "agent" && h.coverage >= 0.8);
      if (same) add({ ...this.openRow(same.doc, 2e5), id: `already:${same.doc.id}`, tier: 0, title: `Already open: ${same.doc.where} · ${same.doc.title}` });
    }
    const context = contextOf({ space: at.space, path: at.folder }, hook(), home());
    const tier = t.instruction ? 2 : 3, score = t.instruction ? 1e6 : 0, who = this.agent?.name ?? "agent";
    add({ id: "agent:new", tier, score, kind: "start", icon: ICON("terminal"), title: `Start agent: ${t.text}`, context,
      sub: `${who} · ${at.space ? `in ${at.name}` : `new space in ${tilde(at.folder)}`}`, act: (cx) => this.startAgent(t.text, at, context, false, cx) });
    if (t.instruction && at.git && !at.machine) {
      add({ id: "agent:worktree", tier, score: score - 1, kind: "start", icon: ICON("branch"), title: `Start agent in a new worktree: ${t.text}`, context,
        sub: `${who} · ${branchName(t.text)}`, act: (cx) => this.startAgent(t.text, at, context, true, cx) });
    }
  }

  // tab.new (or space.new) with the agent and the text as its task, through the context hook. A worktree first goes
  // where Herdr's worktree mod puts them: ~/.herdr/worktrees/<repo>/<branch, slashes as dashes>, as a new space.
  startAgent(text, at, context, worktree, cx) {
    if (this.busy) return;
    const h = hook();
    const argv = this.agent?.run && withEnv(this.agent.run, h?.env?.[context]);
    if (!argv) return notify({ title: "No agent to start", body: "Herdr knows no installed agent (programs.json `run`).", level: "error" });
    const tab = text.length <= 28 ? text : `${text.slice(0, 29).replace(/\s+\S*$/, "")}…`; // the tab's name: its first words
    if (!worktree) {
      const cmd = at.space ? ["tab.new", { space: at.space, folder: at.folder, name: tab, argv, task: text }]
        : ["space.new", { folder: at.folder, tab, argv, task: text }];
      return this.perform(context, [cmd]);
    }
    this.busy = "Making the worktree…";
    cx.spawn(async (cx) => {
      const common = await exec("git", ["-C", at.folder, "rev-parse", "--path-format=absolute", "--git-common-dir"]).catch(() => null);
      const main = common?.code === 0 ? common.stdout.trim().replace(/\/\.git$/, "") : null;
      const branch = branchName(text), dest = `${home()}/.herdr/worktrees/${base(main)}/${branch.replace(/\//g, "-")}`;
      const r = main ? await exec("git", ["-C", main, "worktree", "add", "-b", branch, dest], { timeout: 60000 }).catch((e) => ({ code: 1, stderr: String(e) })) : { code: 1, stderr: "not a git repo" };
      this.busy = null;
      if (r.code !== 0) {
        notify({ title: `Couldn't make the worktree ${branch}`, body: (r.stderr || r.stdout || "").trim().slice(0, 200), level: "error" });
        return cx.notify();
      }
      this.perform(context, [["space.new", { folder: dest, tab, argv, task: text }]]);
    });
    cx.notify();
  }

  // "Ask" (explicit only): a mod registered in shared "goto.ask" answers with the best open entries.
  askRows(q, docs, hits, add) {
    const reg = shared("goto.ask");
    if (!live(reg) || q.length < 4) return;
    // Weak hits (nothing open matches every word): Ask is offered first among the rest.
    const weak = !hits.some((h) => h.coverage === 1);
    add({ id: "ask", tier: 2, score: weak ? 1e4 : -1, kind: "ask", keep: true, icon: ICON("search"), title: `Ask: find the session about “${q}”`,
      sub: reg.subtitle ?? "", act: (cx) => this.ask(q, docs, reg, cx) });
    if (this.asked?.query !== q) return;
    const answer = shared(reg.answer);
    if (this.asked.loading && answer?.at === this.asked.at) {
      this.asked = answer.error ? { query: q, error: answer.error } : { query: q, matches: answer.matches ?? [] };
    } else if (this.asked.loading && Date.now() - this.asked.at > ASK_WAIT) this.asked = { query: q, error: "no answer" };
    if (this.asked.loading) add({ id: "asking", tier: 0, score: 1e7, kind: "ask", spin: true, title: "Asking…", sub: q });
    else if (this.asked.error) add({ id: "ask-error", tier: 0, score: 1e7, kind: "ask", icon: "!", title: "Ask failed", sub: this.asked.error });
    else this.asked.matches.forEach((m, i) => {
      const d = docs.find((x) => x.id === m.id);
      if (d) add({ ...this.openRow(d, 1e7 - i), tier: 0, id: `ask:${d.id}`, sub: m.reason });
    });
  }

  repoRows(name, owner, docs, guard, add) {
    const hits = resolveRepo(name, owner, this.candidates(name), hook()?.current);
    const locals = this.repoDocs.filter((r) => r.slug && hits.some((h) => h.slug.toLowerCase() === r.slug.toLowerCase()));
    for (const r of locals.slice(0, 3)) guard(r.path, { ...this.newSpace(r.path, r.name, r.context), title: `Open ${r.slug} as space` });
    if (!locals.length) {
      const slugs = hits.length ? hits.map((h) => h.slug) : owner ? [`${owner}/${name}`] : [];
      for (const slug of slugs.slice(0, 3)) add({ ...this.cloneRow(slug, hits.find((h) => h.slug === slug)?.context ?? this.ownerContext(slug)), tier: 0, score: 1e5 });
      if (!slugs.length) add({ id: "repo-none", tier: 0, score: 0, kind: "repo", spin: this.looking.has(name.toLowerCase()), title: `No repo "${name}" known here`, sub: "looking on GitHub…" });
    }
    for (const slug of [...new Set([...locals.map((r) => r.slug), ...hits.map((h) => h.slug), ...(owner ? [`${owner}/${name}`] : [])])].slice(0, 3)) {
      add({ id: `web:${slug}`, tier: 0, score: 0, kind: "url", icon: "↗", title: `Open ${slug} in browser`, sub: `https://github.com/${slug}`, act: () => this.browse(`https://github.com/${slug}`) });
    }
  }

  // Rows for one PR. Handlers (e.g. a review mod's) match its canonical URL and get {owner} {repo} {number}
  // {title} {state} {head} {base} {url}; a provider item with the same `url` stands for its provider's handler.
  prRows(slug, number, docs, add, vars, score) {
    const info = this.pr(slug, number);
    const url = info.url ?? `https://github.com/${slug}/pull/${number}`;
    const [owner, repo] = slug.split("/");
    // Already open: an entry that mentions this PR, or a terminal on its branch.
    const open = docs.find((d) => (d.refs ?? []).includes(url)) ?? (info.head && docs.find((d) => d.terminal && d.branch === info.head));
    if (open) add({ ...this.openRow(open, score * 10), id: `already:${url}`, tier: 0, title: `Already open: ${open.where} · ${open.title}`, sub: `${slug}#${number}` });
    const title = info.loading ? "…" : info.error ? "(not found)" : info.title;
    const given = this.itemDocs.filter((d) => d.url === url);
    for (const d of given) add({ ...this.openRow(d, score), tier: 0 });
    const v = { ...vars, owner, repo, number, url, title, state: info.state ?? "", head: info.head ?? "", base: info.base ?? "" };
    for (const h of matchHandlers([vars.query, url], fromProviders("handlers"), v)) {
      if (given.some((d) => d.provider === h.provider)) continue;
      add({ ...this.handlerRow(h, score), spin: info.loading });
    }
    add({ id: `web:${url}`, tier: 0, score: score / 10, kind: "url", icon: "↗", title: info.loading || info.error ? "Open in browser" : `Open in browser · ${info.title}`,
      sub: info.error ? `${url} · ${info.error}` : url, act: () => this.browse(url) });
  }

  handlerRow(h, score) {
    return { id: `h:${h.provider}:${h.title}`, tier: 0, score, kind: "handler", icon: ICON("git-compare"), title: h.title, sub: h.subtitle ?? "",
      tag: h.tag, context: h.context ?? null, act: () => this.perform(h.context, h.run) };
  }

  commandDocs() {
    const docs = commands().filter((c) => !c.args.some((a) => a.required)).map((c) => ({ id: `cmd:${c.name}`, kind: "command", title: titleOf(c.name),
      refs: [c.name], text: c.about, sub: c.name, key: this.keyOf(c.name), act: () => { this.close(); run(c.name, {}); } }));
    for (const l of layouts()) docs.push({ id: `layout:${l}`, kind: "layout", title: `Layout: ${l}`, refs: ["layout", "look"], sub: "layout.switch",
      key: this.keyOf(`layout.switch:${l}`), act: () => { this.close(); run("layout.switch", { name: l }); } });
    return docs;
  }

  keyOf(action) {
    return keys().find((k) => k.section === "global" && k.action === action)?.keys ?? null;
  }

  // ---- actions ----

  // Sets the "goto.set" values, then runs the commands, through the context hook when one listens here.
  perform(context, runs) {
    const r = route(runs ?? [], context, hook(), shared("layout"), Date.now());
    this.close();
    for (const s of r.sets) setShared(s.key, s.value);
    if (r.request) setShared(r.request.key, r.request.value);
    for (const [name, args] of r.run) run(name, args ?? {});
  }

  focus(d) {
    if (d.terminal) return this.perform(d.context, [["pane.focus", { terminal: d.terminal }]]);
    if (d.tab) return this.perform(d.context, [["space.select", { id: d.space }], ["tab.select", { id: d.tab }]]);
    this.perform(d.context, [["space.select", { id: d.space }]]);
  }

  newSpace(folder, name, context) {
    return { id: `new:${folder}`, tier: 2, score: 0, kind: "new", icon: ICON("folder-plus"), title: `Open ${name} as space`, sub: tilde(folder), context,
      act: () => this.perform(context, [["space.new", { folder, name }]]) };
  }

  cloneRow(slug, context) {
    const name = slug.split("/")[1];
    const dest = `${expandHome(this.config.cloneTo[context] ?? this.config.cloneTo.default, home())}/${name}`;
    return { id: `clone:${slug}`, tier: 2, score: 0, kind: "clone", icon: ICON("folder-plus"), title: `Clone ${slug}`, sub: `to ${tilde(dest)}`, context,
      act: (cx) => this.clone(slug, dest, name, context, cx) };
  }

  clone(slug, dest, name, context, cx) {
    if (this.busy) return;
    this.busy = `Cloning ${slug}…`;
    cx.spawn(async (cx) => {
      const exists = await exec("test", ["-d", `${dest}/.git`]).then((r) => r.code === 0).catch(() => false);
      const r = exists ? { code: 0 } : await exec("gh", ["repo", "clone", slug, dest], { timeout: 600000 }).catch((e) => ({ code: 1, stderr: String(e) }));
      this.busy = null;
      if (r.code !== 0) {
        notify({ title: `Couldn't clone ${slug}`, body: (r.stderr || r.stdout || "").trim().slice(0, 200), level: "error" });
        return cx.notify();
      }
      this.perform(context, [["space.new", { folder: dest, name }]]);
    });
    cx.notify();
  }

  browse(url) {
    this.close();
    exec("open", [url]).catch(() => null);
  }

  ask(q, docs, reg, cx) {
    const at = Date.now();
    this.asked = { query: q, at, loading: true };
    const items = docs.filter((d) => d.kind !== "space").slice(0, 80).map((d) => ({ id: d.id, title: d.title, where: d.where, topic: (d.text || (d.refs ?? []).join(" ")).slice(0, 300) }));
    setShared(reg.request, { query: q, items, at });
    this.at = 0;
    this.refresh(cx);
  }

  go(row, cx) {
    if (!row?.act) return;
    row.act(cx);
  }

  // ---- view ----

  glyph(t, r, i) {
    if (r.spin || r.doc?.status === "working") return svg(ICON("spinner")).size(14).flex_none().text_color(t.working).spin(900);
    const st = r.doc?.status;
    if (st && STATUS[st]) return div().id(`gt-${i}-dot`).w(14).flex_none().text_color(t[STATUS[st][1]]).child(st === "idle" ? "○" : "●").tooltip(`Session status: ${STATUS[st][0]}.`).accessibility_label(`Session status: ${STATUS[st][0]}`);
    const p = r.doc?.program;
    if (p?.icon && (r.kind === "agent" || r.kind === "terminal")) return p.tint ? svg(p.icon).size(14).flex_none().text_color(t.muted) : image(p.icon).w(14).h(14).flex_none();
    const icon = r.icon ?? r.doc?.icon ?? { space: ICON("folder"), tab: ICON("square"), terminal: ICON("terminal"), agent: ICON("terminal"), command: "frame/palette/command.svg", layout: ICON("layers"), item: ICON("layers") }[r.kind];
    if (icon?.includes("/")) return svg(icon).size(14).flex_none().text_color(t.dim);
    return div().w(14).flex_none().text_color(t.dim).child(icon ?? "·");
  }

  title(t, text, hits, on) {
    const color = on ? t.foreground : t.muted;
    if (!hits?.length) return div().flex_shrink_1().min_w(0).truncate().text_color(color).child(text);
    const parts = [];
    [...text].forEach((ch, i) => {
      const lit = hits.includes(i), last = parts[parts.length - 1];
      if (last && last[1] === lit) last[0] += ch; else parts.push([ch, lit]);
    });
    return h_flex().flex_shrink_1().min_w(0).overflow_hidden().children(parts.map(([s, lit]) =>
      div().flex_none().text_color(lit ? t.accent : color).when(lit, (d) => d.font_semibold()).child(s.replace(/ /g, " "))));
  }

  chip(t, text, color) {
    return div().flex_none().px(5).rounded(4).border_1().border_color(t.border).bg(t.raised).text_size(11).text_color(color ?? t.dim).child(text);
  }

  row(t, r, i, h) {
    const on = i === this.at, st = r.doc?.status && STATUS[r.doc.status];
    const age = r.doc?.changed ? ago(r.doc.changed) : "";
    // The tag: the entry's own, else the hook's label for its context.
    const tag = r.tag ?? (r.context ? h?.labels?.[r.context] ?? r.context : null);
    const tagColor = r.context && h?.colors?.[r.context];
    return h_flex().id(`gt-${i}`).mx(6).px(10).gap(10).items_center().rounded(7).cursor_pointer().text_size(12.8).tooltip(KIND_TIP[r.kind] ?? "Run this result (Enter).")
      .when(on, (el) => el.bg(t.selected)).hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => { this.at = i; this.go(r, cx); })
      .child(this.glyph(t, r, i))
      .child(h_flex().flex_1().min_w(0).gap(8).items_center()
        .child(this.title(t, r.title, r.hits, on))
        .when(Boolean(r.sub), (el) => el.child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(t.dim).child(r.sub))))
      .when(Boolean(st), (el) => el.child(div().id(`gt-${i}-status`).flex_none().text_size(11).text_color(t[st[1]]).tooltip("Session status and time since it last changed.").child(age ? `${st[0]} · ${age}` : st[0])))
      .when(Boolean(r.key), (el) => el.child(h_flex().id(`gt-${i}-key`).flex_none().gap(3).tooltip("Keyboard shortcut bound to this command.").accessibility_label(`Shortcut ${r.key}`).children(r.key.split(/-(?=.)/).map((k) => this.chip(t, k)))))
      .when(Boolean(tag), (el) => el.child(this.chip(t, tag, tagColor ? t[tagColor] ?? tagColor : null).id(`gt-${i}-tag`).tooltip("Where this result comes from.")));
  }

  render(cx) {
    const t = theme(), h = hook();
    const rows = this.list;
    // An Ask answer arrives through shared state, which re-renders: pick it up off the render path.
    if (this.asked?.loading && shared(shared("goto.ask")?.answer)?.at === this.asked.at && !this.askQueued) {
      this.askQueued = true;
      cx.timer.after(0, (cx) => { this.askQueued = false; this.refresh(cx); });
    }
    // Demo only (RECIPE.md, "Demo"): a shared "goto.demo.query" types into the box. Nothing sets it in normal use.
    const dq = shared("goto.demo.query");
    if (typeof dq === "string" && dq !== this.demoQuery) {
      this.demoQuery = dq;
      cx.timer.after(0, (cx) => { this.input.set_value(dq); this.query = dq; this.at = 0; this.scroll = 0; this.refresh(cx); });
    }
    // Demo only: "goto.demo.pick" {title} runs the first row whose title starts with it, as Enter would.
    const dp = shared("goto.demo.pick");
    if (dp?.title && !this.picking) {
      this.picking = true;
      cx.timer.after(0, (cx) => { this.picking = false; setShared("goto.demo.pick", null); this.go(this.list.find((r) => r.title.startsWith(dp.title)), cx); });
    }
    this.at = Math.min(this.at, Math.max(0, rows.length - 1));
    const total = rows.length * ROW_H, fixed = total > LIST_H;
    const maxScroll = Math.max(0, total - LIST_H);
    if (this.at * ROW_H < this.scroll) this.scroll = this.at * ROW_H;
    if ((this.at + 1) * ROW_H > this.scroll + LIST_H) this.scroll = (this.at + 1) * ROW_H - LIST_H;
    this.scroll = Math.max(0, Math.min(this.scroll, maxScroll));
    // Rows placed at fixed edges (as the palette does), so rounding can't drift the selection.
    const list = rows.map((r, i) => {
      const top = i * ROW_H;
      if (fixed && (top + ROW_H <= this.scroll || top >= this.scroll + LIST_H)) return null;
      const el = this.row(t, r, i, h);
      return fixed ? el.absolute().left(0).right(0).top(top - this.scroll).h(ROW_H) : el.flex_none().h(ROW_H);
    }).filter(Boolean);
    return v_flex().id("goto").track_focus(this.handle).w_full().min_h(0).p(18).gap(10).bg(t.popover)
      .on_key_down((e, cx) => {
        const k = e.key;
        if (k === "escape") return this.close();
        if (k === "down") this.at = Math.min(this.at + 1, rows.length - 1);
        else if (k === "up") this.at = Math.max(this.at - 1, 0);
        else if (k === "pagedown") this.at = Math.min(this.at + SHOWN, rows.length - 1);
        else if (k === "pageup") this.at = Math.max(this.at - SHOWN, 0);
        else return;
        cx.stop_propagation();
        cx.notify();
      })
      .child(h_flex().h(36).flex_none().px(10).gap(10).items_center().rounded(9).border_1().border_color(t.accent).bg(t.background)
        .child(svg(ICON("search")).size(16).text_color(t.dim))
        .child(Input.new(this.input).flex_1().h_full().text_size(12.8).text_color(t.foreground))
        .child(div().id("goto-hint").text_size(11).text_color(t.dim).tooltip(this.busy ? "A background task is running." : "Press Esc to close the palette.").child(this.busy ?? "Esc")))
      .child(rows.length
        ? div().id("goto-rows").relative().mb(6).when(fixed, (el) => el.h(LIST_H).overflow_hidden())
          .on_scroll_wheel((e, cx) => {
            this.scroll = Math.max(0, Math.min(this.scroll - e.delta.y, maxScroll));
            while (this.at < rows.length - 1 && this.at * ROW_H < this.scroll) this.at++;
            while (this.at > 0 && (this.at + 1) * ROW_H > this.scroll + LIST_H) this.at--;
            cx.notify();
          })
          .children(fixed ? list : [v_flex().children(list)])
        : div().px(16).py(14).text_size(13).text_color(t.dim).child(this.query ? `Nothing matches "${this.query}".` : "Nothing open yet."));
  }
}
