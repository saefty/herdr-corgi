// The updater's pure parts: when to check (due), what `corgi.py status --json` said (readStatus), and whether
// that is worth a notification (decide). No host calls here, so test_updater.mjs runs it under plain node.

export const HOUR = 60 * 60 * 1000;
export const DAY = 24 * HOUR;

export const due = (last, now) => !last || now - last >= DAY;

// {code, stdout, stderr} of `corgi.py status --json` -> {updates: [{name, from, to, changelog}], errors: [{name, error}], error}
export function readStatus({ code, stdout, stderr }) {
  let s = null;
  try { s = JSON.parse(stdout); } catch {}
  if (code !== 0 || !s?.mods) {
    const last = (stderr ?? "").trim().split("\n").pop();
    return { updates: [], errors: [], error: last || `corgi status failed (exit ${code})` };
  }
  return {
    updates: (s.updates ?? []).filter((n) => s.mods[n]).map((name) => {
      const m = s.mods[name];
      return { name, from: m.version, to: m.latest, changelog: m.changelog ?? "" };
    }),
    errors: Object.entries(s.mods).filter(([, m]) => m.error).map(([name, m]) => ({ name, error: m.error })),
    error: null,
  };
}

export function summary(updates) {
  const list = updates.map((u) => `${u.name} ${u.to}`).join(", ");
  return updates.length === 1 ? `Update: ${list}` : `${updates.length} updates: ${list}`;
}

// One notification per new set of updates; a failed check says nothing and forgets nothing.
export function decide(result, notified) {
  if (!result.updates.length) return { title: null, notified: result.error || result.errors.length ? notified : null };
  const key = result.updates.map((u) => `${u.name}@${u.to}`).sort().join(",");
  return { title: key === notified ? null : summary(result.updates), notified: key };
}
