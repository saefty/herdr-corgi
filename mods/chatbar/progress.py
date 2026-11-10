#!/usr/bin/env python3
"""Progress of Claude Code agents, read from their session transcripts. No LLM.

    progress.py '[{"address": "t4", "pid": 123, "cwd": "/repo", "session": null}]'
    progress.py --file <transcript.jsonl> [--cache <file>] [--now <ms>]   (one transcript, for tests)

Prints {address: {done, total, eta, doing, session}}:
- done/total: the latest task list (TodoWrite, or TaskCreate/TaskUpdate), null without one;
- doing: the task in progress, else the last tool call ("Editing src/app.ts");
- eta: minutes left, only after two completions and while it keeps that pace, else null.

Terminal -> transcript: `session` when given (a provider knows it), else the Claude process under
the terminal's pid and its ~/.claude/sessions/<pid>.json (never *.key), else the newest
transcript in ~/.claude/projects/<cwd as slug>/.
Reading is incremental: the first read takes a transcript's last 8 MB, later reads only what was
appended (cached by inode and offset in a hidden file next to this script).
"""
import glob, json, math, os, re, subprocess, sys, time
from datetime import datetime
from urllib.parse import urlparse

HOME = os.path.expanduser("~")
CLAUDE = os.path.join(HOME, ".claude")  # ponytail: one config dir; a provider's `session` covers others
CACHE = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".progress-cache.json")
FIRST = 8 << 20  # ponytail: tasks created before the last 8 MB of a long session are missed
VERSION = 1
BOOKKEEPING = {"TodoWrite", "TaskCreate", "TaskUpdate", "TaskList", "TaskGet"}


def ms(ts):
    try:
        return int(datetime.fromisoformat(ts.replace("Z", "+00:00")).timestamp() * 1000)
    except Exception:
        return None


def short(s, n=80):
    s = " ".join(str(s or "").split())
    return s if len(s) <= n else s[: n - 1] + "…"


def rel(path, cwd):
    path = str(path or "")
    base = (cwd or "").rstrip("/")
    if base and path.startswith(base + "/"):
        return path[len(base) + 1:]
    return "~" + path[len(HOME):] if path.startswith(HOME + "/") else path


def summary(name, inp, cwd):
    """One line for a tool call: what the agent is doing right now."""
    inp = inp if isinstance(inp, dict) else {}
    path = inp.get("file_path") or inp.get("notebook_path")
    if name in ("Edit", "MultiEdit", "NotebookEdit"):
        return short(f"Editing {rel(path, cwd)}")
    if name == "Write":
        return short(f"Writing {rel(path, cwd)}")
    if name == "Read":
        return short(f"Reading {rel(path, cwd)}")
    if name == "Bash":
        return short(inp.get("description") or f"Running {inp.get('command', '')}")
    if name == "Grep":
        return short(f"Searching for {inp.get('pattern', '')}")
    if name == "Glob":
        return short(f"Finding {inp.get('pattern', '')}")
    if name == "WebFetch":
        return short(f"Fetching {urlparse(inp.get('url', '')).netloc or inp.get('url', '')}")
    if name == "WebSearch":
        return short(f"Searching the web: {inp.get('query', '')}")
    if name in ("Agent", "Task"):
        return short(f"Delegating: {inp.get('description', '')}")
    if name == "Skill":
        return short(f"Using skill {inp.get('skill', '')}")
    if name == "AskUserQuestion":
        return "Asking you a question"
    if name.startswith("mcp__"):
        parts = name.split("__")
        return short(f"{parts[1]}: {'__'.join(parts[2:])}" if len(parts) > 2 else name)
    return short(name)


def new_state():
    # items: [id, subject, activeForm, status]; doneAt: completion times of the current list.
    return {"items": [], "started": None, "doneAt": [], "last": None, "cwd": None}


def open_items(s):
    return [i for i in s["items"] if i[3] != "completed"]


def apply(s, rec):
    """Folds one transcript record into the state."""
    if rec.get("isSidechain"):
        return
    s["cwd"] = rec.get("cwd") or s["cwd"]
    at = ms(rec.get("timestamp", "")) or 0
    content = (rec.get("message") or {}).get("content")
    if not isinstance(content, list):
        return
    for c in content:
        if not isinstance(c, dict):
            continue
        if c.get("type") == "tool_result":
            # TaskCreate's answer carries the id later TaskUpdates use.
            item = next((i for i in s["items"] if i[0] == c.get("tool_use_id")), None)
            if item:
                task = (rec.get("toolUseResult") or {}).get("task") if isinstance(rec.get("toolUseResult"), dict) else None
                text = json.dumps(c.get("content"))
                m = re.search(r"#(\d+)", text)
                item[0] = str((task or {}).get("id") or (m and m[1]) or item[0])
            continue
        if c.get("type") != "tool_use":
            continue
        name, inp = c.get("name") or "", c.get("input") or {}
        if name not in BOOKKEEPING:
            s["last"] = summary(name, inp, s["cwd"])
        elif name == "TodoWrite" and isinstance(inp.get("todos"), list):
            before = sum(1 for i in s["items"] if i[3] == "completed")
            items = [[str(n), t.get("content", ""), t.get("activeForm", ""), t.get("status", "pending")]
                     for n, t in enumerate(inp["todos"]) if isinstance(t, dict)]
            after = sum(1 for i in items if i[3] == "completed")
            if not s["items"] or not open_items(s) or after < before:  # a new list
                s["started"], s["doneAt"], before = at, [], 0
            s["doneAt"] += [at] * max(0, after - before)
            s["items"] = items
        elif name == "TaskCreate":
            if not open_items(s):  # the last list was finished: a new one starts
                s["items"], s["started"], s["doneAt"] = [], at, []
            s["items"].append([c.get("id"), inp.get("subject", ""), inp.get("activeForm", ""), "pending"])
        elif name == "TaskUpdate":
            item = next((i for i in s["items"] if i[0] == str(inp.get("taskId"))), None)
            if not item:
                continue
            st = inp.get("status")
            if st == "deleted":
                s["items"].remove(item)
                continue
            if st == "completed" and item[3] != "completed":
                s["doneAt"].append(at)
            item[1] = inp.get("subject") or item[1]
            item[2] = inp.get("activeForm") or item[2]
            item[3] = st or item[3]


def summarize(s, now):
    items = s["items"]
    done = sum(1 for i in items if i[3] == "completed")
    active = next((i for i in items if i[3] == "in_progress"), None)
    eta = None
    n = len(s["doneAt"])
    if s["started"] and n >= 2 and 0 < len(items) - done:
        per = (s["doneAt"][-1] - s["started"]) / n
        # Honest only while it keeps that pace: stalled longer than two steps, no guess.
        if per > 0 and now - s["doneAt"][-1] < 2 * per + 60000:
            eta = math.ceil(per * (len(items) - done) / 60000)
    return {
        "done": done if items else None,
        "total": len(items) or None,
        "eta": eta,
        "doing": short(active[2] or active[1]) if active else s["last"],
    }


def progress_of(path, cache, now=None):
    """{done, total, eta, doing} for a transcript; `cache` (a dict) keeps the parse between calls."""
    st = os.stat(path)
    e = cache.get(path)
    if not e or e.get("v") != VERSION or e.get("ino") != st.st_ino or st.st_size < e["off"]:
        e = {"v": VERSION, "ino": st.st_ino, "off": max(0, st.st_size - FIRST), "cut": st.st_size > FIRST, "s": new_state()}
    if st.st_size > e["off"]:
        with open(path, "rb") as f:
            f.seek(e["off"])
            data = f.read()
        end = data.rfind(b"\n") + 1  # a half-written last line waits for the next read
        lines = data[:end].split(b"\n")
        if e.pop("cut", False):
            lines = lines[1:]  # started mid-line
        for raw in lines:
            if b'"tool_use"' not in raw and b'"tool_result"' not in raw:
                continue
            try:
                apply(e["s"], json.loads(raw))
            except (ValueError, AttributeError, TypeError):
                continue
        e["off"] += end
    cache[path] = e
    return summarize(e["s"], now or time.time() * 1000)


def process_tree():
    out = subprocess.run(["ps", "-A", "-o", "pid=,ppid=,comm="], capture_output=True, text=True).stdout
    kids, comm = {}, {}
    for line in out.splitlines():
        parts = line.split(None, 2)
        if len(parts) >= 2:
            kids.setdefault(int(parts[1]), []).append(int(parts[0]))
            comm[int(parts[0])] = parts[2] if len(parts) > 2 else ""
    return kids, comm


def transcript_for(t, tree):
    """The transcript a terminal's Claude Code writes, or None."""
    if t.get("session"):
        return t["session"]
    if t.get("pid"):
        kids, comm = tree()
        queue = [int(t["pid"])]
        while queue:
            pid = queue.pop(0)
            f = os.path.join(CLAUDE, "sessions", f"{pid}.json")
            # The comm check guards against a reused pid with a stale session file.
            if "claude" in os.path.basename(comm.get(pid, "")) and os.path.exists(f):
                try:
                    sid = json.load(open(f)).get("sessionId")
                except (OSError, ValueError):
                    sid = None
                found = glob.glob(os.path.join(CLAUDE, "projects", "*", f"{sid}.jsonl")) if sid else []
                if found:
                    return found[0]
                break
            queue.extend(kids.get(pid, []))
    if t.get("cwd"):
        slug = re.sub(r"[^A-Za-z0-9]", "-", t["cwd"])
        found = glob.glob(os.path.join(CLAUDE, "projects", slug, "*.jsonl"))
        if found:
            return max(found, key=os.path.getmtime)
    return None


def load(path):
    try:
        return json.load(open(path))
    except Exception:
        return {}


def save(path, cache, keep):
    try:
        tmp = path + ".tmp"
        with open(tmp, "w") as f:
            json.dump({k: v for k, v in cache.items() if k in keep}, f)
        os.replace(tmp, path)
    except OSError:
        pass  # ponytail: a full disk only costs the cache


def main(argv):
    if argv[:1] == ["--file"]:
        opts = dict(zip(argv[2::2], argv[3::2]))
        cache_file = opts.get("--cache")
        cache = load(cache_file) if cache_file else {}
        out = progress_of(argv[1], cache, float(opts["--now"]) if "--now" in opts else None)
        if cache_file:
            save(cache_file, cache, {argv[1]})
        print(json.dumps(out))
        return
    terms = json.loads(argv[0]) if argv else []
    memo = []
    tree = lambda: memo[0] if memo else memo.append(process_tree()) or memo[0]
    cache, out = load(CACHE), {}
    for t in terms:
        path = transcript_for(t, tree)
        if not path:
            continue
        try:
            out[t["address"]] = {**progress_of(path, cache), "session": path}
        except OSError:
            continue
    save(CACHE, cache, {o["session"] for o in out.values()})
    print(json.dumps(out, separators=(",", ":")))


if __name__ == "__main__":
    main(sys.argv[1:])
