// Go to: the pure parts. What the input is (parseInput), which repo a bare name means (resolveRepo),
// the plug-ins (mergeItems, matchHandlers, contextOf, route), and the ranking: a fuzzy title match plus
// BM25-like token relevance over title, keywords, text and folder (rank), with the snippet that matched.
// No host calls here, so test_goto.mjs runs it under plain node.

// ---- input ----

const GH = String.raw`(?:https?:\/\/)?(?:www\.)?github\.com[/:]`;
const NAME = String.raw`[\w.-]+`;
const TICKET = /\b([A-Za-z][A-Za-z0-9]{1,9}-\d{1,6})\b/;

// -> {kind: "pr", owner?, repo?, number} | {kind: "repo", owner, repo} | {kind: "path", path}
//    | {kind: "url", url} | {kind: "text", text, ticket?, name?}
export function parseInput(raw) {
  const s = (raw ?? "").trim();
  let m;
  if ((m = s.match(new RegExp(`^${GH}(${NAME})/(${NAME})/pull/(\\d+)`, "i")))) return { kind: "pr", owner: m[1], repo: m[2], number: +m[3] };
  if ((m = s.match(new RegExp(`^(?:git@)?${GH}(${NAME}?)/(${NAME}?)(?:\\.git)?(?:[/?#].*)?$`, "i")))) return { kind: "repo", owner: m[1], repo: m[2] };
  if ((m = s.match(new RegExp(`^(${NAME})/(${NAME})#(\\d+)$`)))) return { kind: "pr", owner: m[1], repo: m[2], number: +m[3] };
  if ((m = s.match(new RegExp(`^(${NAME})#(\\d+)$`)))) return { kind: "pr", owner: null, repo: m[1], number: +m[2] };
  if ((m = s.match(/^#(\d+)$/))) return { kind: "pr", owner: null, repo: null, number: +m[1] };
  if (/^(~(\/|$)|\/)/.test(s)) return { kind: "path", path: s };
  if (/^[a-z][a-z0-9+.-]*:\/\/\S+$/i.test(s)) return { kind: "url", url: s };
  if ((m = s.match(new RegExp(`^(${NAME})/(${NAME})$`)))) return { kind: "repo", owner: m[1], repo: m[2] };
  const ticket = s.match(TICKET)?.[1]?.toUpperCase() ?? null;
  // A single word could be a repo name ("my-service"): the caller looks it up.
  const name = new RegExp(`^${NAME}$`).test(s) && s.length >= 2 ? s : null;
  return { kind: "text", text: s, ticket, name };
}

export const expandHome = (p, home) => (p ?? "").replace(/^~(?=\/|$)/, home).replace(/(.)\/+$/, "$1");

// "git@github.com:octo/x.git" / "https://github.com/octo/x" -> "octo/x"
export function slugOf(url) {
  const m = (url ?? "").match(/github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i);
  return m ? `${m[1]}/${m[2]}` : null;
}

// The origin URL from a .git/config text.
export function originOf(config) {
  return (config ?? "").match(/\[remote "origin"\][^[]*?\burl\s*=\s*(\S+)/)?.[1] ?? null;
}

// ---- plug-ins (see PROVIDERS.md) ----

const list = (k) => (Array.isArray(k) ? k : k ? [k] : []).filter(Boolean).map(String);

// Provider items (shared "goto.items.<provider>"). One that focuses a terminal the core already lists
// enriches that entry (title, text, keywords, context, tag); the rest become entries of their own.
export function mergeItems(docs, items) {
  const byTerminal = new Map(docs.filter((d) => d.terminal).map((d) => [d.terminal, d]));
  const extra = [];
  for (const it of items) {
    const d = it.focus?.terminal && byTerminal.get(it.focus.terminal);
    if (d) {
      if (it.title) d.title = it.title;
      d.text = [d.text, it.text].filter(Boolean).join(" · ");
      d.refs = [...(d.refs ?? []), ...list(it.keywords)];
      for (const k of ["context", "tag", "weight"]) if (it[k] != null) d[k] = it[k];
    } else {
      extra.push({ ...it, id: `${it.provider}:${it.id}`, kind: it.kind ?? "item", refs: list(it.keywords), where: it.subtitle,
        terminal: it.focus?.terminal, space: it.focus?.space, tab: it.focus?.tab });
    }
  }
  return [...docs, ...extra];
}

// "{name}" in strings, arrays and objects; a string that is only "{name}" takes the value as is (a number stays one).
export function substitute(v, vars) {
  if (typeof v === "string") {
    const whole = v.match(/^\{(\w+)\}$/);
    if (whole && whole[1] in vars) return vars[whole[1]];
    return v.replace(/\{(\w+)\}/g, (m, k) => (k in vars && vars[k] != null ? String(vars[k]) : m));
  }
  if (Array.isArray(v)) return v.map((x) => substitute(x, vars));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, substitute(x, vars)]));
  return v;
}

// Input handlers (shared "goto.handlers.<provider>": [{pattern, flags?, title, subtitle?, tag?, context?, run}]):
// each one whose pattern matches one of `inputs` becomes a row, its capture groups as {0}, {1}, ….
export function matchHandlers(inputs, handlers, vars = {}) {
  const out = [];
  for (const h of handlers) {
    let re;
    try { re = new RegExp(h.pattern, h.flags ?? "i"); } catch { continue; }
    for (const input of inputs.filter(Boolean)) {
      const m = re.exec(input);
      if (!m) continue;
      const v = { ...vars, ...Object.fromEntries(m.map((g, i) => [i, g])), ...(m.groups ?? {}) };
      out.push({ provider: h.provider, title: substitute(h.title, v), subtitle: h.subtitle && substitute(h.subtitle, v),
        tag: h.tag, context: h.context && substitute(h.context, v), run: substitute(h.run ?? [], v) });
      break;
    }
  }
  return out;
}

// The context of an entry (an opaque label a hook mod understands): its own, else what the hook
// (shared "goto.context") says for its terminal, its space, the folder it is in, or its URL.
export function contextOf(doc, hook, home) {
  if (doc.context) return doc.context;
  if (!hook) return null;
  const byTerminal = doc.terminal && hook.terminals?.[doc.terminal];
  if (byTerminal) return byTerminal;
  const bySpace = doc.space && hook.spaces?.[doc.space];
  if (bySpace) return bySpace;
  const path = expandHome(doc.path, home).toLowerCase();
  let best = null;
  for (const [prefix, ctx] of hook.folders ?? []) {
    const p = expandHome(prefix, home).replace(/\/+$/, "").toLowerCase();
    if (path && (path === p || path.startsWith(p + "/")) && (!best || p.length > best[0].length)) best = [p, ctx];
  }
  if (best) return best[1];
  for (const [re, ctx] of hook.remotes ?? []) {
    try { if (doc.url && new RegExp(re, "i").test(doc.url)) return ctx; } catch {}
  }
  return null;
}

// How to carry out `runs`: "goto.set {key, value}" entries are shared values set at once; the commands go to
// the context hook's request key when a hook listens in this layout (it may switch context first), else run here.
export function route(runs, context, hook, layout, at) {
  const sets = runs.filter(([n]) => n === "goto.set").map(([, a]) => a);
  const rest = runs.filter(([n]) => n !== "goto.set");
  const live = hook?.request && (!hook.layouts || hook.layouts.includes(layout));
  if (live && rest.length) return { sets, request: { key: hook.request, value: { context: context ?? null, run: rest, at } }, run: [] };
  return { sets, request: null, run: rest };
}

// ---- repos ----

// known: [{slug: "owner/repo", path?, context?, at?}] from local clones, providers' repos and GitHub lookups.
// -> the slugs a bare name (or owner/name) can mean, best first: a local clone, then the preferred context
// (the one shown now), then the most recently used. One entry per slug, with its local path if any.
export function resolveRepo(name, owner, known, prefer) {
  const n = (name ?? "").toLowerCase(), o = (owner ?? "").toLowerCase();
  const hits = new Map();
  for (const k of known) {
    if (!k.slug) continue;
    const [ko, kr] = k.slug.toLowerCase().split("/");
    if (kr !== n || (o && ko !== o)) continue;
    const prev = hits.get(k.slug.toLowerCase());
    hits.set(k.slug.toLowerCase(), { slug: k.slug, path: prev?.path ?? k.path ?? null, context: prev?.context ?? k.context ?? null, at: Math.max(prev?.at ?? 0, k.at ?? 0) });
  }
  const score = (h) => (h.path ? 4 : 0) + (prefer && h.context === prefer ? 2 : 0);
  return [...hits.values()].sort((a, b) => score(b) - score(a) || b.at - a.at);
}

// ---- text ----

// English and German stop words (queries come in both).
const STOP = new Set("the a an of and or to in on for with is it my me i about find session der die das und oder ein eine einen mit für fuer im in den dem zu ist ich mein meine von auf".split(" "));
const SUFFIX = ["ungen", "ung", "ern", "en", "er", "es", "ing", "ed", "e", "s"];

export function fold(s) {
  return (s ?? "").toLowerCase().replace(/ä/g, "ae").replace(/ö/g, "oe").replace(/ü/g, "ue").replace(/ß/g, "ss")
    .normalize("NFKD").replace(/[̀-ͯ]/g, "");
}

// A light German/English stemmer: one common ending off, never below 3 letters.
export function stem(w) {
  if (w.length <= 4 || /\d/.test(w)) return w;
  for (const s of SUFFIX) if (w.endsWith(s) && w.length - s.length >= 3) return w.slice(0, -s.length);
  return w;
}

// Words, camelCase split ("OrbitSyncJob" -> orbit sync job), folded, stop words out,
// stemmed; ticket keys ("SHELF-1234") also stay whole.
export function tokens(s) {
  const text = (s ?? "").replace(/([a-z])([A-Z])/g, "$1 $2");
  const out = [];
  for (const t of fold(s).match(new RegExp(TICKET.source, "g")) ?? []) out.push(t);
  for (const w of fold(text).match(/[a-z0-9]+/g) ?? []) if (!STOP.has(w)) out.push(stem(w));
  return out;
}

// Your letters in order in `text`; word starts and runs count more. -> {score, hits} | null.
export function fuzzy(q, text) {
  const t = fold(text);
  let score = 0, at = 0, run = 0;
  const hits = [];
  for (const ch of fold(q).replace(/\s+/g, "")) {
    const i = t.indexOf(ch, at);
    if (i < 0) return null;
    const start = i === 0 || /[\s:.\-_/·#]/.test(t[i - 1]) || (text[i] >= "A" && text[i] <= "Z" && text[i - 1] >= "a" && text[i - 1] <= "z");
    run = i === at && hits.length ? run + 1 : 0;
    score += 1 + (start ? 6 : 0) + run * 3 - Math.min(i - at, 6) * 0.3;
    hits.push(i);
    at = i + 1;
  }
  return hits.length ? { score: score - t.length * 0.02, hits } : null;
}

const FIELDS = { title: 3, refs: 2, text: 1, path: 0.5 };
const K1 = 1.2;

// How well a doc token matches a query token: the same stem 1, a prefix 0.6 (either way).
function hit(qt, dt) {
  if (qt === dt) return 1;
  if (qt.length >= 3 && dt.startsWith(qt)) return 0.6;
  if (dt.length >= 4 && qt.startsWith(dt)) return 0.6;
  return 0;
}

// docs: [{id, title, refs?, text?, path?, ...}] -> [{doc, score, coverage, hits, snippet}], best first.
// score: the fuzzy title match per typed letter, plus token relevance (idf-weighted, saturating tf,
// fields weighted title > refs > text > path) scaled by the share of query words found.
// Each field's tokens, kept on the doc (doc._tok) so a list tokenized once ranks fast per keystroke.
export function prepare(docs) {
  for (const d of docs) d._tok = fieldTokens(d);
  return docs;
}
export const fieldTokens = (d) => Object.fromEntries(Object.keys(FIELDS).map((f) => [f, tokens(Array.isArray(d[f]) ? d[f].join(" ") : d[f])]));

export function rank(query, docs) {
  const q = [...new Set(tokens(query))];
  const compact = (query ?? "").trim();
  if (!compact) return [];
  const fields = Object.entries(FIELDS);
  // weighted, saturated term frequency per doc and query word: one pass over each doc's tokens.
  const tfs = docs.map((d) => {
    const tok = d._tok ?? fieldTokens(d);
    return q.map((qt) => {
      let s = 0;
      for (const [f, w] of fields) {
        let n = 0;
        for (const t of tok[f]) n += hit(qt, t);
        if (n) s += w * (n * (K1 + 1)) / (n + K1);
      }
      return s;
    });
  });
  const df = q.map((_, j) => tfs.filter((row) => row[j] > 0).length);
  const N = docs.length;
  const out = [];
  docs.forEach((doc, i) => {
    let bm = 0, found = 0;
    q.forEach((_, j) => {
      const s = tfs[i][j];
      if (s) { found++; bm += Math.log(1 + (N - df[j] + 0.5) / (df[j] + 0.5)) * s; }
    });
    const coverage = q.length ? found / q.length : 0;
    const fz = compact.length >= 2 ? fuzzy(compact, doc.title ?? "") : null;
    // Scattered letters aren't a match: a title counts from ~2.5 per letter (mostly word starts and runs).
    const fzRaw = fz ? fz.score / compact.replace(/\s+/g, "").length : 0;
    const fzScore = fzRaw >= 2.5 ? fzRaw : 0;
    const score = fzScore + bm * coverage * coverage;
    if (score <= 0.5) return;
    out.push({ doc, score, coverage, hits: fzScore ? fz.hits : [], snippet: snippet(doc, q) });
  });
  return out.sort((a, b) => b.score - a.score);
}

// The part of the doc's text (pieces joined by " · ") that matched: "…reminder mail goes out two days before…".
export function snippet(doc, q) {
  if (!q.length || !doc.text) return null;
  const parts = doc.text.split(" · ");
  let best = null, bestN = 0;
  for (const p of parts) {
    const n = q.filter((qt) => tokens(p).some((t) => hit(qt, t))).length;
    if (n > bestN) { best = p; bestN = n; }
  }
  if (!best) return null;
  const words = [...best.matchAll(/\S+/g)];
  const first = words.find((w) => tokens(w[0]).some((t) => q.some((qt) => hit(qt, t))));
  const from = Math.max(0, (first?.index ?? 0) - 24);
  const cut = best.slice(from, from + 80);
  return `${from > 0 ? "…" : ""}${cut}${from + 80 < best.length ? "…" : ""}`;
}

// ---- start an agent ----

// What a typed instruction means: "<space or repo>: text" starts there, else in the shown space. Four or more
// words read as an instruction (offered high); anything shorter still gets the row, last.
// places: [{name, ...}] (spaces first, then local repos) -> {text, place, instruction}
export function agentTask(q, places) {
  const s = (q ?? "").trim();
  const m = s.match(/^([\w.-]+)\s*:\s+(\S.*)$/s);
  const place = m ? places.find((p) => p.name.toLowerCase() === m[1].toLowerCase()) ?? null : null;
  const text = place ? m[2].trim() : s;
  return { text, place, instruction: Boolean(place) || text.split(/\s+/).filter(Boolean).length >= 4 };
}

// "Add retry to the Mailer!" -> "agent/add-retry-to-the-mailer": kebab-case, at most 40 characters after the
// prefix, cut at a word.
export function branchName(text) {
  let s = fold(text).replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if (s.length > 40) s = s.slice(0, 41).replace(/-[^-]*$/, "") || s.slice(0, 40);
  return `agent/${s || "task"}`;
}

// An agent's argv with the context's env (the hook's `env`, PROVIDERS.md): its own leading `env NAME=value` /
// `env -u NAME` settings go, the context's come first (null unsets).
export function withEnv(argv, env) {
  if (!env || !Object.keys(env).length) return argv;
  let rest = argv;
  if (rest[0] === "env") {
    let i = 1;
    while (i < rest.length && (/^\w+=/.test(rest[i]) || rest[i] === "-u")) i += rest[i] === "-u" ? 2 : 1;
    rest = rest.slice(i);
  }
  const sets = Object.entries(env).flatMap(([k, v]) => (v == null ? ["-u", k] : [`${k}=${v}`]));
  return ["env", ...sets, ...rest];
}
