#!/usr/bin/env python3
"""The interplay suite: all five mods in one demo Herdr window, every connection between them, and one run per
missing mod. Run interplay/setup.sh first.

    python3 interplay/run.py            setup's demo: start, install, check, screenshots, stop
    python3 interplay/run.py --keep     the same, but leave the demo window open to look around
    python3 interplay/run.py --stop     stop a kept (or crashed) demo and clean up

The demo window has its own Herdr home (run/app), its own herdr-core (HC_SESSION corgi-demo, socket
/tmp/corgi-demo/core.sock) and a stand-in HOME (run/user), so your window, home and terminals are never touched.
It is driven only through shared keys (the demo-only `interplay` mod sets them from run/app/control/set.json and
logs every change to run/app/interplay-log/), `herdr-app do` and `herdr-app status`. Results: run/report.json and
the exit code. Python 3 standard library only.
"""
import json
import os
import shutil
import subprocess
import sys
import threading
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
RUN, USER, APP = HERE / "run", HERE / "run" / "user", HERE / "run" / "app"
CORE = Path("/tmp/corgi-demo")
SHOTS = ROOT / "docs" / "screenshots"
HERDR = os.environ.get("HERDR_BIN", "/Applications/Herdr.app/Contents/MacOS/Herdr")
SRC = Path(os.environ.get("CORGI_SRC") or ROOT.parent)
MODS = ["goto", "pr-review", "chatbar", "timetrack", "dictate"]
PR = "https://github.com/acme/bookshelf/pull/7"
WORDS = "Please add a test for the retry, then push."  # what the stand-in transcriber hears (fixtures/py)


# --- the demo's environment ------------------------------------------------------------------------

def demo_env():
    """Your environment minus anything that points at your own Herdr, core or tracker, plus the demo's."""
    e = {k: v for k, v in os.environ.items() if not k.startswith(("HC_", "HERDR_", "XDG_", "TIMETRACK_"))}
    e.update(HOME=str(USER), SHELL="/bin/zsh", HERDR_APP_HOME=str(APP), HC_SESSION="corgi-demo",
             HC_SOCKET=str(CORE / "core.sock"), TMPDIR=str(RUN / "tmp"), DO_NOT_TRACK="1", HERDR_TELEMETRY="0",
             # Mods' exec runs with the window's environment: the stand-ins (gh, claude, ffmpeg, parakeet-mlx) first.
             PATH=os.pathsep.join([str(RUN / "bin"), str(HERE / "fixtures" / "bin"), os.environ["PATH"]]),
             PYTHONPATH=str(HERE / "fixtures" / "py"))
    return e


def sh(argv, env=None, check=True, timeout=60):
    p = subprocess.run(argv, env=env or demo_env(), capture_output=True, text=True, timeout=timeout)
    if check and p.returncode:
        raise RuntimeError(f"{' '.join(map(str, argv[:3]))}: {(p.stderr or p.stdout).strip()[:400]}")
    return p


def do(command, args=None, check=True):
    p = sh(["herdr-app", "do", command] + ([json.dumps(args)] if args else []), check=False)
    out = json.loads(p.stdout or "null") if (p.stdout or "").strip().startswith("{") else {"out": p.stdout.strip()}
    if check and (p.returncode or "error" in (out or {})):
        raise RuntimeError(f"herdr-app do {command}: {p.stdout.strip() or p.stderr.strip()}")
    return out


def status():
    return json.loads(sh(["herdr-app", "status"]).stdout)


def wait(pred, timeout=10, step=0.25):
    end = time.time() + timeout
    while True:
        v = pred()
        if v or time.time() > end:
            return v
        time.sleep(step)


# A window that other windows cover draws (and so renders its mods) only when it is resized, and the mods take
# requests in render. While the suite runs, a pump maximizes the demo window and back every ~0.5 s; behind your
# windows that is invisible, and it never touches yours. ponytail: polling; a draw-on-demand command would replace it.
PUMP = {"on": False, "lock": threading.Lock()}


def toggle_pair(pause=0.2):
    for _ in range(2):
        sh(["herdr-app", "do", "window.maximize"], check=False, timeout=10)
        time.sleep(pause)


def pump():
    while PUMP["on"]:
        with PUMP["lock"]:
            toggle_pair()
        time.sleep(0.05)


def pumping(on):
    if on and not PUMP["on"]:
        PUMP["on"] = True
        threading.Thread(target=pump, daemon=True).start()
    elif not on:
        PUMP["on"] = False
        with PUMP["lock"]:
            pass


# --- shared state, through the interplay mod ---------------------------------------------------------

SEQ = [0]


def put(values):
    """Sets shared keys (the interplay mod applies control/set.json once per seq: a rising ms clock, so a later
    run.py process goes on where an earlier one stopped)."""
    SEQ[0] = max(SEQ[0] + 1, now_ms())
    tmp = APP / "control" / "set.json.tmp"
    tmp.write_text(json.dumps({"seq": SEQ[0], "set": values}))
    os.replace(tmp, APP / "control" / "set.json")


def events():
    out = []
    for f in (APP / "interplay-log").glob("*.jsonl"):
        for line in f.read_text().splitlines():
            try:
                out.append(json.loads(line))
            except ValueError:
                pass  # a line being written
    return sorted(out, key=lambda e: e["t"])


def now_ms():
    return int(time.time() * 1000)


def value(key):
    """The newest value of a shared key the interplay mod saw (None when never seen)."""
    hit = [e for e in events() if e["k"] == key]
    return hit[-1]["v"] if hit else None


def seen(key, pred, since, timeout=8):
    """The first value of key since `since` (ms) that pred accepts, waiting up to timeout."""
    return wait(lambda: next((e["v"] for e in events() if e["k"] == key and e["t"] >= since and pred(e["v"])), None), timeout)


# --- mods: one place to change how they get in and out ------------------------------------------------

def corgi(*args):
    """corgi.py against the demo home; its own CORGI_HOME under run/. Your HOME stays (git may need its credentials)."""
    env = {k: v for k, v in os.environ.items() if not k.startswith(("HC_", "HERDR_"))}
    env.update(HERDR_APP_HOME=str(APP), CORGI_HOME=str(RUN / "corgi"))
    return sh([sys.executable, str(ROOT / "corgi.py"), *args], env=env, timeout=300)


def install_mods(home):
    """All five mods into the demo home, keys merged: corgi's own path (clones the repos' default branches)."""
    assert Path(home) == APP
    corgi("enable", "--all", "--keys=merge")


def disable_mod(name):
    corgi("disable", name)


def enable_mod(name):
    corgi("enable", name, "--keys=merge")


# --- the window ------------------------------------------------------------------------------------

def start():
    if (APP / "herdr-app.sock").exists() and sh(["herdr-app", "status"], check=False).returncode == 0:
        raise SystemExit("a demo window is already running: python3 interplay/run.py --stop")
    log = open(RUN / "herdr.log", "w")
    p = subprocess.Popen([HERDR], env=demo_env(), stdout=log, stderr=log, stdin=subprocess.DEVNULL, start_new_session=True)
    (RUN / "herdr.pid").write_text(str(p.pid))
    if not wait(lambda: sh(["herdr-app", "status"], check=False).returncode == 0, 60, 1):
        raise RuntimeError("the demo window did not start (run/herdr.log)")
    time.sleep(2)
    # A fresh home greets with the welcome or what's-new screen: close what the app opened by itself.
    for _ in range(3):
        if status()["overlays"]:
            do("overlay.close", check=False)
            time.sleep(0.5)


def stop():
    """Quits the demo window, stops its core and the tracker, ends stray demo processes, removes the sockets."""
    env = demo_env()
    pumping(False)
    if (APP / "herdr-app.sock").exists():
        sh(["herdr-app", "do", "app.quit"], check=False, timeout=20)
    pid = int((RUN / "herdr.pid").read_text()) if (RUN / "herdr.pid").exists() else None
    if pid and not wait(lambda: not alive(pid), 10):
        os.kill(pid, 15)
        wait(lambda: not alive(pid), 5)
    sh(["hc", "server", "stop"], check=False, timeout=30)
    track = APP / "mods" / "timetrack" / "track.py"
    track = track if track.exists() else SRC / "herdr-corgi-timetrack" / "mods" / "timetrack" / "track.py"
    sh([sys.executable, str(track), "--stop"], env={**env, "TIMETRACK_DATA": str(APP / "timetrack-data")}, check=False)
    voice = SRC / "herdr-corgi-dictate" / "mods" / "dictate" / "voice.py"
    sh([sys.executable, str(voice), "cancel"], check=False)
    # Anything still running from the demo's folders (stand-in agents' shells, a stand-in ffmpeg, the worker).
    sh(["pkill", "-f", str(RUN) + "/"], env=os.environ, check=False)
    sh(["pkill", "-f", str(HERE / "fixtures")], env=os.environ, check=False)
    shutil.rmtree(CORE, ignore_errors=True)
    (APP / "herdr-app.sock").unlink(missing_ok=True)
    (RUN / "herdr.pid").unlink(missing_ok=True)


def alive(pid):
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


def shot(name):
    """The window as it is now (a covered window draws only when resized: maximize and back first)."""
    path = RUN / "shots" / f"{name}.png"
    path.parent.mkdir(exist_ok=True)
    with PUMP["lock"]:
        toggle_pair(0.8)
        for _ in range(6):  # "window size or scale changed; wait for the next frame" right after a resize
            if sh(["herdr-app", "shot", str(path)], check=False).returncode == 0:
                return path
            time.sleep(0.5)
    raise RuntimeError(f"no screenshot for {name}")


def publish(path, name, crop=None):
    """A shot into docs/screenshots/interplay-<name>.png, cropped to w:h:x:y window pixels (2x)."""
    out = SHOTS / f"interplay-{name}.png"
    SHOTS.mkdir(parents=True, exist_ok=True)
    if crop:
        sh(["ffmpeg", "-loglevel", "error", "-y", "-i", str(path), "-vf", f"crop={crop}", str(out)], env=os.environ)
    else:
        shutil.copy(path, out)
    return out


# --- the invented world --------------------------------------------------------------------------

W = {}  # space and terminal ids


def world():
    fx = SRC / "herdr-corgi-goto" / "demo" / "fixtures"
    agent = lambda state, screen: ["/bin/sh", str(fx / "agent.sh"), state, str(fx / "screens" / f"{screen}.txt")]
    code = USER / "code"

    def space(name, tab, argv):
        r = do("space.new", {"name": name, "folder": str(code / name), "tab": tab, "argv": argv})
        return r["space"], r["terminal"]

    W["bookshelf"], W["t_reminders"] = space("bookshelf", "reminders", agent("working", "reminders"))
    W["orbit"], W["t_login"] = space("orbit-sync", "login", agent("blocked", "login"))
    W["ledger"], W["t_export"] = space("ledger", "export", agent("idle", "export"))
    do("space.select", {"id": W["ledger"]})
    # The context hook: one mod (here the interplay mod) owns contexts; Go to, the chat bar and the tracker read it.
    # Titles as a session provider would publish them (the chat bar's provider contract; Go to's agents show tab names).
    titles = {W["t_reminders"]: "Add due-date reminders", W["t_login"]: "Fix login redirect", W["t_export"]: "Export invoices as CSV"}
    put({"goto.context": hook("work"), "timetrack.contexts": {"count": ["work"]}, "chatbar.providers": ["interplay"],
         "chatbar.agents.interplay": {t: {"title": v} for t, v in titles.items()},
         # and for Go to (its items contract: an item that focuses a listed terminal names that entry)
         "goto.providers": sorted(set(value("goto.providers") or []) | {"interplay"}),
         "goto.items.interplay": [{"id": t, "title": v, "focus": {"terminal": t}} for t, v in titles.items()]})
    time.sleep(3)


def hook(bookshelf_and_orbit):
    return {"request": "interplay.request", "layouts": ["interplay", "review"], "current": "work",
            "spaces": {W["bookshelf"]: bookshelf_and_orbit, W["orbit"]: bookshelf_and_orbit, W["ledger"]: "private"},
            "labels": {"work": "Work", "private": "Private"}, "colors": {"work": "ansi4", "private": "ansi5"}}


# --- checks ----------------------------------------------------------------------------------------

RESULTS = []


def check(name, ok, evidence):
    RESULTS.append({"check": name, "ok": bool(ok), "evidence": evidence})
    print(f"{'PASS' if ok else 'FAIL'}  {name}\n      {json.dumps(evidence, ensure_ascii=False)[:600]}", flush=True)


def errors():
    return status().get("errors", [])


def goto_rows(query, want=None, timeout=8):
    """Opens Go to with `query` typed in (its demo hook) and returns the rows' titles once `want` is among them."""
    if "goto" not in json.dumps(status()["overlays"]):
        do("mod.open", {"name": "goto"})
        time.sleep(1)
    put({"goto.demo.query": query})
    ok = lambda: (rows := value("goto.demo.rows")) and rows.get("query") == query and \
        (not want or any(t.startswith(want) for t in rows["titles"])) and rows["titles"]
    wait(ok, timeout)
    time.sleep(0.5)
    return (value("goto.demo.rows") or {}).get("titles", [])


def goto_pick(title):
    put({"goto.demo.pick": {"title": title, "at": now_ms()}})


def goto_close():
    if "goto" in json.dumps(status()["overlays"]):
        do("mod.open", {"name": "goto"})
    put({"goto.demo.query": ""})


def show_layout(name):
    if status()["layout"] != name:
        do("layout.switch", {"name": name})
        wait(lambda: status()["layout"] == name, 5)
        time.sleep(1.5)


def chatbar_width():
    return ((status().get("floats") or {}).get("chatbar") or {}).get("bounds", [0, 0, 0, 0])[2]


def check_goto_review():
    show_layout("interplay")
    do("space.select", {"id": W["bookshelf"]})  # you are in the repo's space and paste the PR link
    time.sleep(1)
    put({"review.target": None})
    # pr-review's row: "Review PR #7 · <title>", or "Resume review #7 …" once a review of it is in progress (an item
    # for the PR replaces the provider's handler row: goto PROVIDERS.md).
    goto_rows(PR, "Review PR #7")
    titles = goto_rows(PR, "Review PR #7 · feat")  # once gh's title is in
    row = next((t for t in titles if t.startswith(("Review PR #7", "Resume review #7"))), None)
    path = shot("goto-review")
    since = now_ms()
    goto_pick(row or "Review PR")
    layout = wait(lambda: status()["layout"] == "review" and "review", 10)
    target = seen("review.target", lambda v: (v or {}).get("url") == PR, since, 5)
    check("goto offers Review PR for a PR URL and lands in the review layout",
          row and layout and target,
          {"rows": titles[:6], "layout": status()["layout"], "review.target": (target or {}).get("url")})
    return path


def check_reply():
    show_layout("interplay")
    login = W["t_login"]
    put({"chatbar.closed": {login: "blocked"}})  # as if the person had closed its bubble (✕)
    wait(lambda: chatbar_width() < 100, 5)
    closed_w = chatbar_width()
    titles = goto_rows("Reply to", "Reply to")
    path = shot("goto-reply")
    since = now_ms()
    goto_pick("Reply to")
    req = seen("chatbar.request", lambda v: (v or {}).get("action") == "open" and v.get("terminal") == login, since)
    taken = seen("chatbar.request", lambda v: v is None, since)
    reopened = wait(lambda: chatbar_width() > 300, 5)
    check("goto's \"Reply to …\" opens the chat bubble",
          any(t.startswith("Reply to") for t in titles) and req and taken is None and reopened,
          {"rows": [t for t in titles if t.startswith("Reply to")], "chatbar.request": req,
           "bubble width before/after": [closed_w, chatbar_width()]})
    return path


def discuss(want, timeout=12):
    """pr-review's Discuss on the high finding, again until `want` sees its effect (the review loads its findings first)."""
    end = time.time() + timeout
    while True:
        since = now_ms()
        do("pr-review.discuss:f-cr-1")
        hit = want(since)
        if hit or time.time() > end:
            return since, hit


def check_discuss():
    show_layout("review")
    since, req = discuss(lambda since: seen("chatbar.request", lambda v: (v or {}).get("action") == "draft" and v.get("from") == "pr-review", since, 2))
    taken = seen("chatbar.request", lambda v: v is None, since)
    wait(lambda: chatbar_width() > 300, 5)
    time.sleep(1)
    path = shot("review-discuss")
    check("pr-review Discuss writes chatbar.request (a draft for the PR's agent)",
          req and req.get("terminal") == W["t_reminders"] and "Reminder resent" in req.get("text", "") and taken is None,
          {"chatbar.request": req and {**req, "text": req["text"][:80]}, "taken": taken is None, "bubble width": chatbar_width()})
    return path


def check_mic():
    show_layout("review")
    api = value("dictate.api") or {}
    since = now_ms()
    do(f"chatbar.mic:{W['t_login']}")  # the bubble with the empty reply field, so the words show
    req = seen("dictate.request", lambda v: (v or {}).get("id", "") == f"chatbar:{W['t_login']}", since)
    rec = seen("dictate.state", lambda v: (v or {}).get("status") == "recording", since, 10)
    path = shot("dictate-recording") if rec else None
    do("dictate.toggle")  # the dictation key: stop and transcribe
    draft = seen("chatbar.request", lambda v: (v or {}).get("action") == "draft" and v.get("text") == WORDS, since, 15)
    time.sleep(1.5)
    after = shot("dictate-draft")
    check("the chat bar's mic writes dictate.request, and the words come back as a draft",
          api.get("ready") and req and req.get("reply", {}).get("key") == "chatbar.request" and rec and draft and draft.get("append"),
          {"dictate.api": api, "dictate.request": req, "dictate.state": rec, "chatbar.request": draft})
    return path, after


def check_context():
    show_layout("interplay")
    track = APP / "mods" / "timetrack"
    sys.path.insert(0, str(track))
    import track as tt  # noqa: E402  (the installed tracker's own decision function)
    cfg = tt.load_cfg()
    facts = lambda: json.loads((APP / "timetrack-data" / "herdr.json").read_text())
    counted = lambda f: tt.evaluate(0, ("Finder", "com.apple.finder"), f, cfg)[0]  # an agent works, you look elsewhere
    item = lambda: next((i for i in value("goto.items.chatbar") or [] if i["id"] == W["t_login"]), {})
    before = {"chatbar item context": item().get("context"), "facts": facts(), "counts": counted(facts())}
    since = now_ms()
    put({"goto.context": hook("private")})  # one switch: bookshelf and orbit-sync move to the private context
    moved = seen("goto.items.chatbar", lambda v: any(i["id"] == W["t_login"] and i.get("context") == "private" for i in v or []), since)
    # The chip reports facts every 10 s.
    wait(lambda: any(w.get("context") == "private" for w in facts().get("working", [])), 25, 1)
    path = shot("context-private")
    after = {"chatbar item context": item().get("context"), "facts": facts(), "counts": counted(facts())}
    check("one goto.context switch changes the chat bar's tags and timetrack's counting",
          before["chatbar item context"] == "work" and moved and before["counts"] and not after["counts"],
          {"before": {**before, "facts": before["facts"].get("working")}, "after": {**after, "facts": after["facts"].get("working")}})
    put({"goto.context": hook("work")})
    return path


# --- one run per missing mod -----------------------------------------------------------------------

def restart():
    """Quits the demo window and starts it again; the core keeps the terminals, so the spaces come back."""
    pumping(False)
    sh(["herdr-app", "do", "app.quit"], check=False, timeout=20)
    pid = int((RUN / "herdr.pid").read_text())
    wait(lambda: not alive(pid), 15)
    start()
    pumping(True)
    show_layout("interplay")
    time.sleep(2)


def own_errors(name, errs):
    """Herdr's errors for a layout that still places a removed mod ("mod dictate: no mod folder …"), apart from the rest."""
    mine = [e for e in errs if e.startswith(f"mod {name}:") or f"/mods/{name}" in e]
    return mine, [e for e in errs if e not in mine]


def clipboard():
    return subprocess.run(["pbpaste"], capture_output=True, text=True).stdout


def fallback(name):
    """Disable one mod, restart the window, check the others load without errors and fall back as documented, enable it again."""
    show_layout("interplay")
    goto_close()
    disable_mod(name)
    restart()
    placed, errs = own_errors(name, errors())
    ev, ok = {"errors": errs, "layouts still place it (Herdr's own error)": placed}, not errs
    if name == "goto":
        r = do("mod.open", {"name": "goto"}, check=False)
        since = now_ms()
        put({"chatbar.request": {"action": "open", "terminal": W["t_export"], "from": "interplay"}})
        taken = seen("chatbar.request", lambda v: v is None, since)
        ev.update({"mod.open goto": r, "chat bar still takes requests": taken is None})
        ok = ok and "error" in r and taken is None
    elif name == "pr-review":
        titles = goto_rows(PR, "Open in browser")
        goto_close()
        ev["rows"] = titles[:6]
        ok = ok and titles and not any(t.startswith(("Review PR", "Resume review")) for t in titles)
    elif name == "chatbar":
        titles = goto_rows("Reply to")
        goto_close()
        show_layout("review")
        clip = clipboard()  # the fallback pastes through the clipboard: yours comes back afterwards
        since, win = discuss(lambda since: wait(lambda: status()["overlays"], 2))
        req = seen("chatbar.request", lambda v: (v or {}).get("from") == "pr-review", since, 1)
        path = shot("fallback-no-chatbar")
        subprocess.run(["pbcopy"], input=clip, text=True)
        ev.update({"api": value("chatbar.api"), "Reply to rows": [t for t in titles if t.startswith("Reply to")],
                   "chatbar.request written": req, "overlays (pr-review's own agent window)": win, "shot": str(path)})
        ok = ok and value("chatbar.api") is None and not any(t.startswith("Reply to") for t in titles) and not req and win
        do("overlay.close", check=False)
        show_layout("interplay")
    elif name == "timetrack":
        items = value("goto.items.chatbar")
        ev["chat bar still publishes"] = [i["title"] for i in items or []]
        ok = ok and items
    elif name == "dictate":
        show_layout("review")
        since = now_ms()
        r = do("chatbar.mic", check=False)
        req = seen("dictate.request", lambda v: v is not None, since, 3)
        ev.update({"dictate.api": value("dictate.api"), "chatbar.mic": r, "dictate.request written": req})
        ok = ok and value("dictate.api") is None and not req
        show_layout("interplay")
    enable_mod(name)
    if not (APP / "mods" / name / "main.js").exists():
        # corgi disable leaves files it didn't write (gpui-kit.d.ts, a cache), and enable then adopts that folder
        # without writing the mod: a corgi bug. Reported here, then repaired so the next runs see all five mods.
        ev["corgi enable adopted a leftover folder"] = sorted(p.name for p in (APP / "mods" / name).iterdir())
        ok = False
        disable_mod(name)
        shutil.rmtree(APP / "mods" / name, ignore_errors=True)
        enable_mod(name)
    time.sleep(4)
    ev["errors after enable"] = errors()
    check(f"without {name}: the others load without errors and fall back", ok and not ev["errors after enable"], ev)


# --- main ----------------------------------------------------------------------------------------

def main(argv):
    if "--stop" in argv:
        stop()
        return 0
    if not (APP / "control").is_dir():
        raise SystemExit("run interplay/setup.sh first")
    start()
    pumping(True)
    try:
        install_mods(APP)
        time.sleep(3)
        show_layout("interplay")
        world()
        check("all five mods load without errors", not errors() and all((APP / "mods" / m / "mod.json").exists() for m in MODS),
              {"errors": errors(), "mods": sorted(p.name for p in (APP / "mods").iterdir())})
        wait(lambda: not status()["overlays"], 10)  # the "needs you" toast goes by itself
        overview = shot("overview")
        shots = {"goto-review": check_goto_review(), "goto-reply": check_reply(), "review-discuss": check_discuss()}
        shots["dictate-recording"], shots["dictate-draft"] = check_mic()
        shots["context"] = check_context()
        shots["overview"] = overview
        # The README's pictures: crops are window pixels (2x) of the 1280 x 760 demo window.
        publish(shots["overview"], "overview")
        publish(shots["goto-review"], "goto-review-pr", "1340:440:620:100")
        publish(shots["goto-reply"], "goto-reply", "1340:440:620:100")
        publish(shots["review-discuss"], "discuss")
        publish(shots["dictate-draft"], "dictate", "1500:620:1050:880")
        for m in MODS:
            fallback(m)
        (RUN / "report.json").write_text(json.dumps({"results": RESULTS, "shots": {k: str(v) for k, v in shots.items() if v}}, indent=1))
    finally:
        pumping(False)
        if "--keep" not in argv:
            stop()
    failed = [r["check"] for r in RESULTS if not r["ok"]]
    print(f"\n{len(RESULTS) - len(failed)}/{len(RESULTS)} passed" + (f"; failed: {failed}" if failed else ""))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
