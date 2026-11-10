#!/usr/bin/env python3
"""corgi: install, update and develop the herdr-corgi mods for Herdr. Python 3 stdlib only.

State lives in CORGI_HOME (default ~/.local/share/corgi), the app in HERDR_APP_HOME
(default ~/.config/herdr-app). Run `corgi -h` for the commands.
"""
import argparse
import atexit
import difflib
import fnmatch
import io
import hashlib
import json
import os
import re
import shlex
import shutil
import subprocess
import sys
import tarfile
import tempfile
import time
from dataclasses import dataclass, field
from pathlib import Path

HERE = Path(__file__).resolve().parent
GENERATED = {"gpui-kit.d.ts", "jsconfig.json", ".DS_Store"}  # written by herdr-app check / the OS
GENERATED_DIRS = {"__pycache__", "node_modules", ".git"}


class Fail(Exception):
    """A clear, user-facing error; main() prints it and exits 1."""


# --- paths and state ----------------------------------------------------------

def state_dir():
    return Path(os.environ.get("CORGI_HOME") or Path.home() / ".local/share/corgi")


def app_home():
    return Path(os.environ.get("HERDR_APP_HOME") or Path.home() / ".config/herdr-app")


def mod_dir(name):
    return app_home() / "mods" / name


def pristine(name, version):
    return state_dir() / "pristine" / name / version


def load_json(path, default):
    try:
        return json.loads(Path(path).read_text())
    except FileNotFoundError:
        return default
    except json.JSONDecodeError as e:
        raise Fail(f"{path} is not valid JSON ({e})")


def save_json(path, data):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n")
    os.replace(tmp, path)


def load_manifest(path=None):
    """mods.json: {"mods": {name: {"repo": url, "path": "mods/<name>", "default": bool}}}."""
    path = Path(path or os.environ.get("CORGI_MANIFEST") or HERE / "mods.json")
    data = load_json(path, None)
    if data is None:
        raise Fail(f"no manifest at {path}")
    return {n: {"repo": e["repo"], "path": e.get("path", f"mods/{n}"), "default": e.get("default", True)}
            for n, e in data["mods"].items()}


def load_state():
    """installed.json (CORGI_HOME): {name: {version, source, files: {rel: sha256}, keys}};
    corgi.lock (HERDR_APP_HOME): {name: {version, repo, dev, history: [older versions]}}."""
    return load_json(state_dir() / "installed.json", {}), load_json(app_home() / "corgi.lock", {})


def save_state(installed, lock):
    save_json(state_dir() / "installed.json", installed)
    save_json(app_home() / "corgi.lock", lock)
    save_json(state_dir() / "config.json", {"clone": str(HERE)})  # the updater mod finds the CLI here


# --- files ---------------------------------------------------------------------

def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def generated(rel):
    parts = rel.split("/")
    return parts[-1] in GENERATED or rel.endswith(".pyc") or any(p in GENERATED_DIRS for p in parts)


def leftover(rel):
    """A file Herdr or the mod itself writes into the mod folder: generated, or hidden (a cache like
    .progress-cache.json). ponytail: any untracked dotfile counts as the mod's cache."""
    return generated(rel) or any(p.startswith(".") for p in rel.split("/"))


def has_mod(dest):
    """A mod folder worth adopting has mod.json or main.js; anything else is leftovers from a disable."""
    return (Path(dest) / "mod.json").is_file() or (Path(dest) / "main.js").is_file()


def list_files(root):
    root, out = Path(root), []
    for dp, dns, fns in os.walk(root):
        dns[:] = [d for d in dns if d not in GENERATED_DIRS]
        for f in fns:
            rel = os.path.relpath(os.path.join(dp, f), root).replace(os.sep, "/")
            if not generated(rel):
                out.append(rel)
    return sorted(out)


def hashes(root, rels=None):
    root = Path(root)
    return {r: sha(root / r) for r in (list_files(root) if rels is None else rels) if (root / r).is_file()}


def read(path):
    path = Path(path)
    return path.read_bytes() if path.is_file() else None


def mod_json_first(rels):
    return sorted(rels, key=lambda r: (r != "mod.json", r))


def write_files(dest, changes, src_dir=None):
    """changes: {rel: bytes | None (delete)}. mod.json goes first so Herdr never sees a folder without it."""
    for rel in mod_json_first(changes):
        p, data = Path(dest) / rel, changes[rel]
        if data is None:
            if p.is_file():
                p.unlink()
            continue
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(data)
        if src_dir and (Path(src_dir) / rel).is_file():
            shutil.copymode(Path(src_dir) / rel, p)


def local_changes(rec, dest):
    """Files corgi installed that no longer match what it wrote (edited or deleted)."""
    return sorted(r for r, h in rec.get("files", {}).items()
                  if not (Path(dest) / r).is_file() or sha(Path(dest) / r) != h)


@dataclass
class Report:
    files: dict = field(default_factory=dict)  # rel -> sha256 of corgi's version (the release's)
    written: list = field(default_factory=list)
    removed: list = field(default_factory=list)
    changed: list = field(default_factory=list)  # changed locally, left alone
    extra: list = field(default_factory=list)  # in the folder, not part of the mod

    def show(self, name, title, changed_note="changed locally, left alone"):
        print(f"{name}: {title}")
        for r in self.written:
            print(f"  write   {r}")
        for r in self.removed:
            print(f"  remove  {r}")
        for r in self.changed:
            print(f"  keep    {r} ({changed_note})")
        for r in self.extra:
            print(f"  ignore  {r} (not part of the mod)")


def install(name, src_dir, dest_dir, record, dry_run=False, force=False):
    """Copy src into dest. Files whose current hash differs from what corgi wrote last time
    (record["files"]) are skipped and reported as changed, unless force."""
    src, dest, old = Path(src_dir), Path(dest_dir), record.get("files", {})
    rep, changes = Report(files=hashes(src)), {}
    for rel in mod_json_first(rep.files):
        cur = sha(dest / rel) if (dest / rel).is_file() else None
        if cur == rep.files[rel]:
            continue
        if cur is not None and cur != old.get(rel) and not force:
            rep.changed.append(rel)
            continue
        rep.written.append(rel)
        changes[rel] = (src / rel).read_bytes()
    for rel in sorted(set(old) - set(rep.files)):  # dropped upstream
        if not (dest / rel).is_file():
            continue
        if force or sha(dest / rel) == old[rel]:
            rep.removed.append(rel)
            changes[rel] = None
        else:
            rep.changed.append(rel)
    if not dry_run:
        write_files(dest, changes, src)
    return rep


def adopt(name, dest_dir, src_dir):
    """A folder corgi didn't install: record the release as corgi's version, report every file that
    differs, never write. ponytail: the record holds the release's hashes, not the folder's, so the
    differing files count as local changes (kept by update/disable) instead of becoming corgi's."""
    src, cur = hashes(src_dir), hashes(dest_dir)
    return Report(files=src, changed=sorted(r for r in src if cur.get(r) != src[r]),
                  extra=sorted(set(cur) - set(src)))


# --- sources (git) ---------------------------------------------------------------

def git(*args, cwd=None, check=True):
    p = subprocess.run(["git", *map(str, args)], cwd=cwd, capture_output=True, text=True)
    if check and p.returncode:
        raise Fail((p.stderr or p.stdout).strip() or f"git {args[0]} failed")
    return p.stdout


def clone_dir(url):
    return state_dir() / "repos" / re.sub(r"\.git$", "", url.rstrip("/").rsplit("/", 1)[-1])


def fetch(url):
    """Bare clone of the mod repo under CORGI_HOME/repos, refreshed with branches and tags."""
    d = clone_dir(url)
    try:
        if d.exists():
            git("-C", d, "fetch", "-q", "--force", "--tags", url, "+refs/heads/*:refs/heads/*")
        else:
            d.parent.mkdir(parents=True, exist_ok=True)
            git("clone", "-q", "--bare", url, d)
    except Fail as e:
        raise Fail(f"cannot fetch {url}: {e}")
    return d


VERSION = re.compile(r"v?(\d+)(?:\.(\d+))?(?:\.(\d+))?")


def vt(v):
    m = VERSION.match(str(v or ""))
    return tuple(int(g or 0) for g in m.groups()) if m else (0, 0, 0)


def ref_of(version):
    """Tagged versions are vX.Y.Z; an untagged head is labelled X.Y.Z+<sha7>."""
    return version.split("+", 1)[1] if "+" in version else "v" + version


def tags(d):
    return sorted((t[1:] for t in git("-C", d, "tag", "-l", "v*").split() if re.fullmatch(r"v\d+\.\d+\.\d+", t)),
                  key=vt)


def latest(d, path):
    ts = tags(d)
    if ts:
        return ts[-1]
    head = git("-C", d, "rev-parse", "HEAD").strip()
    meta = json.loads(git("-C", d, "show", f"HEAD:{path}/corgi.json", check=False) or "{}")
    return f"{meta.get('version', '0.0.0')}+{head[:7]}"


def export(repo, ref):
    """The repo's tree at ref, in a temp dir (git archive: tracked files only)."""
    p = subprocess.run(["git", "-C", str(repo), "archive", "--format=tar", ref], capture_output=True)
    if p.returncode:
        raise Fail(f"{ref} not found in {repo}: {p.stderr.decode().strip()}")
    out = Path(tempfile.mkdtemp(prefix="corgi-"))
    atexit.register(shutil.rmtree, out, True)
    with tarfile.open(fileobj=io.BytesIO(p.stdout)) as t:
        t.extractall(out, filter="data")
    return out


@dataclass
class Source:
    name: str
    version: str
    repo: str
    root: Path  # exported repo tree
    dir: Path  # the mod folder inside it
    meta: dict  # corgi.json, {} when absent
    keys: dict = None  # keys.json snippet
    dev: str = None


def source(name, entry, version=None, dev=None):
    """The mod at version (default: latest tag, else the default branch head), or a dev checkout's HEAD."""
    if dev:
        root = export(dev, "HEAD")
    else:
        d = fetch(entry["repo"])
        version = version or latest(d, entry["path"])
        root = export(d, ref_of(version))
    mdir = root / entry["path"]
    if not mdir.is_dir():
        raise Fail(f"{name}: {entry['path']} is missing in {dev or entry['repo']}")
    meta = load_json(mdir / "corgi.json", {})
    if dev:
        version = meta.get("version", "0.0.0")
    keys_rel = meta.get("keys") if "keys" in meta else "keys.json"  # no corgi.json: a root keys.json counts
    keys = load_json(root / keys_rel, None) if keys_rel else None
    return Source(name, version, entry["repo"], root, mdir, meta, keys, str(dev) if dev else None)


def store_pristine(src):
    p = pristine(src.name, src.version)
    shutil.rmtree(p, ignore_errors=True)
    for rel in list_files(src.dir):
        p.joinpath(rel).parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src.dir / rel, p / rel)


def record(installed, lock, src, files, prev=None):
    """Write down that src is installed with these files; prev goes onto the lock history."""
    store_pristine(src)
    rec = installed.setdefault(src.name, {})
    rec.update(version=src.version, source="dev" if src.dev else "release", files=files)
    ent = lock.setdefault(src.name, {"version": src.version, "repo": src.repo, "dev": None, "history": []})
    if prev and prev != src.version:
        ent["history"].append(prev)
    ent.update(version=src.version, repo=src.repo, dev=src.dev or ent.get("dev"))


# --- keys.json --------------------------------------------------------------------------

KEYS_NOTE = ("Note: Herdr keeps an edited keys.json as yours. Once these shortcuts are added, new default "
             "shortcuts from Herdr updates must be added by hand.")


@dataclass
class KeysReport:
    added: dict = field(default_factory=dict)  # {section: {key: action}} actually written
    skipped: list = field(default_factory=list)  # (section, key, current action): bound to something else
    written: bool = False


def merge_keys(keys_path, snippet, mode, dry_run=False):
    """mode ask|merge|skip. Adds only unbound keys at the end of their section; never removes or
    reorders; a missing keys.json is created only on merge/yes. skip prints the snippet instead."""
    path, rep = Path(keys_path), KeysReport()
    data = load_json(path, None)
    new = {}
    for sec, binds in snippet.items():
        cur = (data or {}).get(sec, {})
        for k, v in binds.items():
            if k not in cur:
                new.setdefault(sec, {})[k] = v
            elif cur[k] != v:
                rep.skipped.append((sec, k, cur[k]))
    for sec, k, cur in rep.skipped:
        print(f"  key {k} ({sec}) is bound to {json.dumps(cur)}, left alone")
    if not new:
        return rep
    text = json.dumps(new, indent=2, ensure_ascii=False)
    if mode == "skip":
        print(f"  shortcuts not added to {path}; add them by hand if you like:\n{text}")
        return rep
    if mode == "ask":
        print(f"  shortcuts to add to {path}:\n{text}\n  {KEYS_NOTE}")
        if not ask("  Add them? [y/N] "):
            print("  keys.json left unchanged")
            return rep
    rep.added = new
    if not dry_run:
        data = data or {}
        for sec, binds in new.items():
            data.setdefault(sec, {}).update(binds)
        save_json(path, data)
        rep.written = True
    print(f"  {'would add' if dry_run else 'added'} {sum(map(len, new.values()))} shortcut(s) to {path}")
    return rep


def unbind_keys(keys_path, added, dry_run=False):
    """Remove keys corgi added, only where they still have corgi's value."""
    data = load_json(keys_path, None)
    if not data or not added:
        return
    gone = [(s, k) for s, b in added.items() for k, v in b.items() if data.get(s, {}).get(k) == v]
    for s, k in gone:
        del data[s][k]
        print(f"  unbind  {k} ({s})")
    for s, b in added.items():
        for k in b:
            if (s, k) not in gone and k in data.get(s, {}):
                print(f"  keep    key {k} ({s}): you changed it")
    if gone and not dry_run:
        save_json(keys_path, data)


# --- commands ------------------------------------------------------------------------

def cmd_enable(a):
    manifest = load_manifest()
    names = [n for n, e in manifest.items() if e["default"]] if a.all else a.mods
    if not names:
        raise Fail("name a mod or use --all")
    unknown = [n for n in names if n not in manifest]
    if unknown:
        raise Fail(f"unknown mod(s): {', '.join(unknown)} (known: {', '.join(manifest)})")
    installed, lock = load_state()
    for n in names:
        if n in installed:
            print(f"{n}: already enabled ({installed[n]['version']})")
    todo = [n for n in names if n not in installed]
    # Fetch everything first: an unreachable repo stops the run before anything is written.
    srcs = [source(n, manifest[n], lock.get(n, {}).get("version"), lock.get(n, {}).get("dev")) for n in todo]
    apis, code = provided(installed), 0
    for s in srcs:
        apis.update(s.meta.get("provides") or {})
    for s in srcs:
        unmet = unmet_requires(s.meta, apis)
        if unmet:
            print(f"{s.name}: not enabled: {'; '.join(unmet)}")
            code = 1
            continue
        dest = mod_dir(s.name)
        if has_mod(dest):
            rep = adopt(s.name, dest, s.dir)
            rep.show(s.name, f"adopted existing folder as {s.version}" +
                     (f", {len(rep.changed)} file(s) differ" if rep.changed else ", identical"),
                     f"differs from {s.version}, left alone")
        else:
            rep = install(s.name, s.dir, dest, {}, a.dry_run)
            rep.show(s.name, f"install {s.version}")
        # Non-interactive runs (--all) merge keys only with --keys=merge.
        krep = merge_keys(app_home() / "keys.json", s.keys, a.keys or ("skip" if a.all else "ask"),
                          a.dry_run) if s.keys else KeysReport()
        if not a.dry_run:
            record(installed, lock, s, rep.files)
            installed[s.name]["keys"] = krep.added
    return finish(a, installed, lock, code)


def finish(a, installed, lock, code=0):
    if a.dry_run:
        print("(dry run: nothing changed)")
    else:
        save_state(installed, lock)
    return code


def cmd_disable(a):
    installed, lock = load_state()
    rec = installed.get(a.mod)
    if not rec:
        raise Fail(f"{a.mod} is not enabled")
    dest = mod_dir(a.mod)
    changed = local_changes(rec, dest)
    print(f"{a.mod}: disable {rec['version']}")
    for rel in sorted(rec["files"]):
        if (dest / rel).is_file() and rel not in changed:
            print(f"  remove  {rel}")
            if not a.dry_run:
                (dest / rel).unlink()
    left = [r for r in list_files(dest) if r in changed or (r not in rec["files"] and not leftover(r))] \
        if dest.is_dir() else []
    for rel in left:
        print(f"  keep    {rel} ({'changed locally' if rel in changed else 'not installed by corgi'})")
    if not a.dry_run and dest.is_dir():
        if left:  # prune empty dirs only
            for dp, _, _ in sorted(os.walk(dest), key=lambda w: -len(w[0])):
                if dp != str(dest) and not os.listdir(dp):
                    os.rmdir(dp)
        else:  # only generated files and the mod's caches (gpui-kit.d.ts, __pycache__, .cache.json) remain
            shutil.rmtree(dest)
    unbind_keys(app_home() / "keys.json", rec.get("keys"), a.dry_run)
    if not a.dry_run:
        installed.pop(a.mod)
        lock.pop(a.mod, None)
    return finish(a, installed, lock)


def changelog(text, old, new):
    """The CHANGELOG.md sections for versions after old, up to and including new."""
    out, keep = [], False
    for line in (text or "").splitlines():
        m = re.match(r"##\s+v?(\d+\.\d+\.\d+)", line)
        if m:
            keep = vt(old) < vt(m[1]) <= vt(new)
        if keep:
            out.append(line)
    return "\n".join(out).strip()


def newer(candidate, current):
    return candidate != current and vt(candidate) >= vt(current)


# --- herdr-app: version, requires, check -------------------------------------------------

def herdr_app():
    return os.environ.get("CORGI_HERDR_APP", "herdr-app")


def herdr_version():
    v = os.environ.get("CORGI_HERDR_VERSION")
    if v:
        return v
    try:
        out = subprocess.run([herdr_app(), "--version"], capture_output=True, text=True).stdout
    except OSError:
        return None
    m = re.search(r"\d+\.\d+\.\d+", out)
    return m[0] if m else None


def satisfies(have, spec):
    ops = {">=": lambda a, b: a >= b, ">": lambda a, b: a > b, "<=": lambda a, b: a <= b,
           "<": lambda a, b: a < b, "==": lambda a, b: a == b, "=": lambda a, b: a == b}
    for part in str(spec).split(","):
        m = re.fullmatch(r"\s*(>=|<=|==|=|>|<)?\s*(v?[\d.]+)\s*", part)
        if not m or not ops[m[1] or ">="](vt(have), vt(m[2])):
            return False
    return True


def provided(installed, skip=()):
    """APIs the installed mods provide, from their live corgi.json: {"goto-api": 1}."""
    out = {}
    for n in installed:
        if n not in skip:
            out.update(load_json(mod_dir(n) / "corgi.json", {}).get("provides") or {})
    return out


def unmet_requires(meta, apis):
    """Reasons a corgi.json's requires isn't met. A partner mod that isn't installed never blocks
    (a missing partner never errors); an installed one at an incompatible API version does."""
    out = []
    for dep, spec in (meta.get("requires") or {}).items():
        have = herdr_version() if dep == "herdr-app" else apis.get(dep)
        if have is None and dep != "herdr-app":
            continue
        if have is None or not satisfies(have, spec):
            out.append(f"needs {dep} {spec}, found {have or 'none'}")
    return out


def run_check(path):
    cmd = shlex.split(os.environ.get("CORGI_CHECK") or f"{herdr_app()} check") + [str(path)]
    try:
        p = subprocess.run(cmd, capture_output=True, text=True)
    except OSError as e:
        return False, str(e)
    return p.returncode == 0, (p.stdout + p.stderr).strip()


def apply_checked(dest, changes, src_dir=None):
    """Write changes, run herdr-app check; on failure put every touched file back."""
    snap = {rel: read(Path(dest) / rel) for rel in changes}
    write_files(dest, changes, src_dir)
    ok, out = run_check(dest)
    if not ok:
        write_files(dest, snap)
    return ok, out


# --- three-way merge -----------------------------------------------------------------------

def merge_file(base, local, new):
    """git merge-file -p on bytes: (merged bytes, conflicted). Binary input counts as a conflict."""
    with tempfile.TemporaryDirectory(prefix="corgi-") as t:
        paths = []
        for part, data in (("local", local), ("base", base), ("new", new)):
            paths.append(Path(t) / part)
            paths[-1].write_bytes(data)
        p = subprocess.run(["git", "merge-file", "-p", *map(str, paths)], capture_output=True)
    return p.stdout, p.returncode != 0


def plan_update(base, base_dir, local_dir, new_dir, keep=(), theirs=(), force=False, extra=()):
    """Per file: {rel: (kind, bytes | None)}, the content the folder should end up with.
    base: {rel: sha} of corgi's installed version, base_dir its pristine copy (for merging).
    kinds: same, upstream (only upstream changed), local (only you changed, or --keep-mine),
    merged (both changed, merged cleanly), theirs (--take-theirs/--force), conflict."""
    new, out = hashes(new_dir), {}
    for rel in sorted(set(base) | set(new) | set(extra)):
        b, n = base.get(rel), new.get(rel)
        lp = Path(local_dir) / rel
        l, nd = (sha(lp) if lp.is_file() else None), read(Path(new_dir) / rel)
        if l == n:
            out[rel] = ("same", nd)
        elif l == b:
            out[rel] = ("upstream", nd)
        elif force or rel in theirs:
            out[rel] = ("theirs", nd)
        elif n == b or rel in keep:
            out[rel] = ("local", read(lp))
        else:
            bd = read(Path(base_dir) / rel) if base_dir and b else None
            if bd is None or hashlib.sha256(bd).hexdigest() != b or l is None or nd is None:
                out[rel] = ("conflict", None)
            else:
                text, bad = merge_file(bd, read(lp), nd)
                out[rel] = ("conflict", None) if bad else ("merged", text)
    return out


def show_plan(name, plan, title):
    notes = {"upstream": ("update", ""), "local": ("keep", " (your change)"),
             "merged": ("merge", " (your change merged into the new version)"),
             "theirs": ("replace", " (your version saved as a patch)"), "conflict": ("CONFLICT", " (changed on both sides)")}
    print(f"{name}: {title}")
    for rel, (kind, data) in plan.items():
        if kind != "same":
            label, note = notes[kind]
            print(f"  {'remove' if kind == 'upstream' and data is None else label:8} {rel}{note}")


def diff_text(base_dir, local_dir, rels):
    """Unified diff base -> local that `git apply` understands (a/ b/ prefixes, /dev/null)."""
    out = []
    for rel in sorted(rels):
        a, b = read(Path(base_dir) / rel), read(Path(local_dir) / rel)
        if a == b:
            continue
        try:
            at, bt = (a or b"").decode(), (b or b"").decode()
        except UnicodeDecodeError:
            out.append(f"Binary files a/{rel} and b/{rel} differ\n")
            continue
        for line in difflib.unified_diff(at.splitlines(True), bt.splitlines(True),
                                         f"a/{rel}" if a is not None else "/dev/null",
                                         f"b/{rel}" if b is not None else "/dev/null"):
            out.append(line if line.endswith("\n") else line + "\n\\ No newline at end of file\n")
    return "".join(out)


def entry_for(name, manifest, ent):
    return manifest.get(name) or {"repo": ent["repo"], "path": f"mods/{name}"}


def update_one(name, want, a, installed, lock, manifest, rollback=False):
    ent, rec = lock.get(name), installed.get(name)
    if not ent or not rec:
        print(f"{name}: not enabled")
        return 1
    if ent.get("dev") and not rollback:
        print(f"{name}: dev checkout at {ent['dev']}, skipped (use corgi save / release)")
        return 0
    old = rec["version"]
    if rollback and pristine(name, want).is_dir():  # offline: the copy kept at install time
        p = pristine(name, want)
        src = Source(name, want, ent["repo"], p, p, load_json(p / "corgi.json", {}))
    else:
        src = source(name, entry_for(name, manifest, ent), want)
    if src.version == old and not a.force:
        print(f"{name}: {old} is up to date")
        return 0
    unmet = unmet_requires(src.meta, provided(installed, skip=[name]))
    if unmet:
        print(f"{name}: not updated to {src.version}: {'; '.join(unmet)}")
        return 1
    if not rollback:
        log = changelog((read(src.root / "CHANGELOG.md") or b"").decode(), old, src.version)
        print(f"{name}: {old} -> {src.version}" + (f"\n{log}\n" if log else ""))
    dest = mod_dir(name)
    base_dir = pristine(name, old)
    plan = plan_update(rec["files"], base_dir, dest, src.dir, getattr(a, "keep_mine", None) or (),
                       getattr(a, "take_theirs", None) or (), a.force)
    show_plan(name, plan, f"{'roll back' if rollback else 'update'} to {src.version}")
    conflicts = [r for r, (k, _) in plan.items() if k == "conflict"]
    if conflicts:
        print(f"{name}: stays on {old}, nothing changed: {len(conflicts)} file(s) changed both here and in "
              f"{src.version}.\n"
              f"  corgi resolve {name}                     an agent re-applies your changes to {src.version}\n"
              f"  corgi update {name} --keep-mine FILE     keep your version of FILE\n"
              f"  corgi update {name} --take-theirs FILE   take {src.version}'s FILE (yours saved as a patch)")
        return 1
    if a.dry_run:
        return 0
    theirs = [r for r, (k, _) in plan.items() if k == "theirs"]
    if theirs:
        backup = state_dir() / "backups" / f"{name}-{time.strftime('%Y%m%d-%H%M%S')}.patch"
        backup.parent.mkdir(parents=True, exist_ok=True)
        backup.write_text(f"# corgi: {name} {old}\n" + diff_text(base_dir if base_dir.is_dir() else src.dir, dest, theirs))
        print(f"{name}: your version of {', '.join(theirs)} saved to {backup}")
    changes = {r: d for r, (k, d) in plan.items() if read(dest / r) != d}
    ok, out = apply_checked(dest, changes, src.dir)
    if not ok:
        print(f"{name}: herdr-app check failed, rolled back to {old}\n{out}")
        ent["failed"] = src.version  # the lock says which version was tried and rolled back
        return 1
    record(installed, lock, src, hashes(src.dir), None if rollback else old)
    ent.pop("failed", None)
    if rollback:
        lock[name]["history"].pop()
    print(f"{name}: now {src.version}")
    return 0


def cmd_update(a):
    installed, lock = load_state()
    manifest = load_manifest()
    targets = [m.split("@", 1) if "@" in m else (m, None) for m in a.mods] or [(n, None) for n in lock]
    code = 0
    for name, want in targets:
        try:
            code |= update_one(name, want, a, installed, lock, manifest)
        except Fail as e:
            print(f"{name}: {e}")
            code = 1
    return finish(a, installed, lock, code)


def cmd_rollback(a):
    installed, lock = load_state()
    hist = lock.get(a.mod, {}).get("history")
    if not hist:
        raise Fail(f"{a.mod}: no earlier version to roll back to")
    a.force = False  # local edits are kept, as on update
    code = update_one(a.mod, hist[-1], a, installed, lock, load_manifest(), rollback=True)
    return finish(a, installed, lock, code)


def enabled(installed, name):
    if name not in installed:
        raise Fail(f"{name} is not enabled")
    return installed[name]


def cmd_diff(a):
    installed, _ = load_state()
    rec = enabled(installed, a.mod)
    print(diff_text(pristine(a.mod, rec["version"]), mod_dir(a.mod), rec["files"]) or f"{a.mod}: no local changes")
    return 0


def cmd_customizations(a):
    """export: customizations/<mod>.patch in HERDR_APP_HOME (dot-herdr), for corgi sync to re-apply."""
    installed, _ = load_state()
    for name in a.mods or sorted(installed):
        rec = enabled(installed, name)
        text = diff_text(pristine(name, rec["version"]), mod_dir(name), rec["files"])
        out = app_home() / "customizations" / f"{name}.patch"
        if text:
            print(f"{name}: {'would write' if a.dry_run else 'wrote'} {out}")
            if not a.dry_run:
                out.parent.mkdir(parents=True, exist_ok=True)
                out.write_text(f"# corgi: {name} {rec['version']}\n{text}")
        elif out.exists():
            print(f"{name}: no local changes, {'would remove' if a.dry_run else 'removed'} {out}")
            if not a.dry_run:
                out.unlink()
        else:
            print(f"{name}: no local changes")
    return 0


def reapply(name, dest, entry, version):
    """Re-apply customizations/<name>.patch to a fresh install, through the same three-way merge."""
    patch = app_home() / "customizations" / f"{name}.patch"
    if not patch.is_file():
        return 0
    m = re.match(r"# corgi: \S+ (\S+)", patch.read_text())
    base_ver = m[1] if m else version
    base = pristine(name, base_ver) if pristine(name, base_ver).is_dir() else source(name, entry, base_ver).dir
    local = Path(tempfile.mkdtemp(prefix="corgi-"))
    atexit.register(shutil.rmtree, local, True)
    shutil.copytree(base, local, dirs_exist_ok=True)
    p = subprocess.run(["git", "apply", str(patch)], cwd=local, capture_output=True, text=True,
                       env={**os.environ, "GIT_CEILING_DIRECTORIES": str(local.parent)})
    if p.returncode:
        print(f"{name}: {patch} does not apply to {base_ver}, left out: {p.stderr.strip()}")
        return 1
    plan = plan_update(hashes(base), base, local, dest, extra=list_files(local))
    conflicts = [r for r, (k, _) in plan.items() if k == "conflict"]
    changes = {r: d for r, (k, d) in plan.items() if k != "conflict" and read(dest / r) != d}
    ok, out = apply_checked(dest, changes)
    if not ok:
        print(f"{name}: herdr-app check failed with your customizations, left them out\n{out}")
        return 1
    print(f"{name}: re-applied your customizations to {', '.join(changes) or 'nothing'}")
    for r in conflicts:
        print(f"  CONFLICT {r}: kept {version}'s version; your change is in {patch}")
    return 1 if conflicts else 0


RESOLVE_TASK = (
    "Update the Herdr mod '{name}' from {old} to {new} and keep the user's customizations. In {stage}: "
    "{stage}/base is {old} as released, {stage}/local is the user's copy ({old} plus their customizations), "
    "{stage}/new is {new} as released, and {stage}/result starts as a copy of new. Edit only files in "
    "{stage}/result: take the new version, re-apply the user's customizations, change nothing else. "
    "Do not touch any other folder. When you are done, tell the user to run: corgi resolve {name} --apply")


def cmd_resolve(a):
    installed, lock = load_state()
    rec = enabled(installed, a.mod)
    stage, dest = state_dir() / "staging" / a.mod, mod_dir(a.mod)
    if a.apply:
        return resolve_apply(a, installed, lock, rec, stage, dest)
    src = source(a.mod, entry_for(a.mod, load_manifest(), lock[a.mod]), a.version)
    old = rec["version"]
    task = RESOLVE_TASK.format(name=a.mod, old=old, new=src.version, stage=stage)
    cmd = [herdr_app(), "do", "tab.new", "--name", f"resolve {a.mod}", "--folder", str(stage),
           "--argv", json.dumps(["claude"]), "--task", task]
    if a.dry_run:
        print(f"would stage {old} / yours / {src.version} in {stage} and run:\n  {shlex.join(cmd)}")
        return 0
    shutil.rmtree(stage, ignore_errors=True)
    rels = set(rec["files"]) | set(list_files(src.dir))
    for part, root in (("base", pristine(a.mod, old)), ("local", dest), ("new", src.dir), ("result", src.dir)):
        for rel in rels:
            if (root / rel).is_file():
                (stage / part / rel).parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(root / rel, stage / part / rel)
    save_json(stage / "target.json", {"version": src.version, "from": old})
    try:
        p = subprocess.run(cmd, capture_output=True, text=True)
        opened = p.returncode == 0
    except OSError:
        opened = False
    if opened:
        print(f"{a.mod}: opened a Claude tab in Herdr to merge your changes into {src.version}")
    else:
        print(f"{a.mod}: could not open a Herdr tab; run claude in {stage} with this task:\n{task}")
    print(f"When it is done: corgi resolve {a.mod} --apply")
    return 0


def resolve_apply(a, installed, lock, rec, stage, dest):
    t = load_json(stage / "target.json", None)
    if not t:
        raise Fail(f"nothing staged for {a.mod}; run corgi resolve {a.mod} first")
    result, new_dir = stage / "result", stage / "new"
    rels = set(rec["files"]) | set(list_files(new_dir)) | set(list_files(result))
    print(diff_text(dest, result, rels) or "no differences")
    if a.dry_run:
        return 0
    if not ask(f"Apply this to {dest} as {t['version']}? [y/N] "):
        print("not applied")
        return 1
    changes = {r: read(result / r) for r in rels if read(dest / r) != read(result / r)}
    ok, out = apply_checked(dest, changes, result)
    if not ok:
        print(f"{a.mod}: herdr-app check failed, rolled back\n{out}")
        return 1
    src = Source(a.mod, t["version"], lock[a.mod]["repo"], stage, new_dir, load_json(new_dir / "corgi.json", {}))
    record(installed, lock, src, hashes(new_dir), rec["version"])
    shutil.rmtree(stage)
    print(f"{a.mod}: now {t['version']} with your changes")
    return finish(a, installed, lock)


def cmd_sync(a):
    """Make the install match corgi.lock (a new Mac: clone dot-herdr, then corgi sync)."""
    installed, lock = load_state()
    try:
        manifest = load_manifest()
    except Fail:
        manifest = {}
    code = 0
    for name, ent in sorted(lock.items()):
        try:
            code |= sync_one(name, ent, a, installed, lock, manifest)
        except Fail as e:
            print(f"{name}: {e}")
            code = 1
    return finish(a, installed, lock, code)


def sync_one(name, ent, a, installed, lock, manifest):
    dev, dest, entry = ent.get("dev"), mod_dir(name), entry_for(name, manifest, ent)
    if dev and not Path(dev).exists():
        print(f"{name}: clone {ent['repo']} into {dev}")
        if a.dry_run:
            return 0
        git("clone", "-q", ent["repo"], dev)
    if name in installed and dest.is_dir():
        if installed[name]["version"] == ent["version"] or dev:
            print(f"{name}: {installed[name]['version']} ok")
            return 0
        return update_one(name, ent["version"], a, installed, lock, manifest)
    src = source(name, entry, None if dev else ent["version"], dev)
    fresh = not has_mod(dest)
    if fresh:
        rep = install(name, src.dir, dest, {}, a.dry_run)
        rep.show(name, f"install {src.version}")
    else:
        rep = adopt(name, dest, src.dir)
        rep.show(name, f"adopted existing folder as {src.version}", f"differs from {src.version}, left alone")
    krep = merge_keys(app_home() / "keys.json", src.keys, a.keys or "skip", a.dry_run) if src.keys else KeysReport()
    if a.dry_run:
        return 0
    record(installed, lock, src, rep.files)
    installed[name]["keys"] = krep.added
    return reapply(name, dest, entry, src.version) if fresh else 0


# --- bundle: the released mods as plain copies in this repo (the herdr.dev layout) ---------------

BUNDLED = ("Generated by corgi bundle from {url} at {ref} ({sha}). Edit there, not here.\n\n"
           "To get updates later, run `./corgi.py enable --all` from a clone of https://github.com/saefty/herdr-corgi.\n")


def bundle_ref(d):
    """(tag or None, ref, commit sha): the latest vX.Y.Z tag, else the default branch head."""
    ts = tags(d)
    ref = f"v{ts[-1]}" if ts else "HEAD"
    return (ref if ts else None), ref, git("-C", d, "rev-parse", f"{ref}^{{commit}}").strip()


def cmd_bundle(a):
    """Copies every mod in mods.json except corgi into <repo>/mods/<mod>/ at its latest tag and records
    where each came from in bundle.json. The mod repos stay the source; these copies are for herdr.dev."""
    out, record = Path(a.repo or HERE), {}
    for name, entry in load_manifest().items():
        if name == "corgi":
            continue
        d = fetch(entry["repo"])
        tag, ref, commit = bundle_ref(d)
        if not tag:
            branch = git("-C", d, "symbolic-ref", "--short", "HEAD", check=False).strip() or "HEAD"
            print(f"warning: {name} has no vX.Y.Z tag; bundling {branch} at {commit[:7]}", file=sys.stderr)
            ref = branch
        src = export(d, commit) / entry["path"]
        if not src.is_dir():
            raise Fail(f"{name}: {entry['path']} is missing in {entry['repo']} at {ref}")
        dest, url = out / "mods" / name, re.sub(r"\.git$", "", entry["repo"])
        print(f"{name}: {ref} ({commit[:7]}) -> {dest}")
        record[name] = {"repo": url, "tag": tag, "sha": commit}
        if a.dry_run:
            continue
        shutil.rmtree(dest, ignore_errors=True)
        for rel in list_files(src):
            (dest / rel).parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(src / rel, dest / rel)
        (dest / "BUNDLED.md").write_text(BUNDLED.format(url=url, ref=ref, sha=commit))
    if a.dry_run:
        print("(dry run: nothing changed)")
    else:
        save_json(out / "bundle.json", record)
    return 0


# --- author flow: dev / save / release ------------------------------------------------------

def checkout_of(name, lock):
    dev = lock.get(name, {}).get("dev")
    if not dev:
        raise Fail(f"{name} has no dev checkout; run: corgi dev {name} <checkout>")
    return Path(dev)


def refuse_dirty(co):
    lines = git("-C", co, "status", "--porcelain").splitlines()
    if lines:
        raise Fail(f"{co} has uncommitted changes; commit or stash them first:\n" +
                   "\n".join(f"  {line}" for line in lines))


def leak_patterns():
    """HERDR_APP_HOME/corgi.leaks: one regex per line (# comments), matched case-insensitively."""
    out = []
    for t in (read(app_home() / "corgi.leaks") or b"").decode().splitlines():
        t = t.strip()
        if t and not t.startswith("#"):
            try:
                out.append(re.compile(t, re.I))
            except re.error:
                out.append(re.compile(re.escape(t), re.I))
    return out


def leak_scan(co):
    """Tracked files (names and text) in a checkout that match the private leak list."""
    rx, hits = leak_patterns(), []
    if not rx:
        return hits
    for rel in filter(None, git("-C", co, "ls-files", "-z").split("\0")):
        hits += [f"{rel}: file name matches {r.pattern}" for r in rx if r.search(rel)]
        data = read(Path(co) / rel)
        if data is None or b"\0" in data:
            continue
        for i, line in enumerate(data.decode(errors="ignore").splitlines(), 1):
            hits += [f"{rel}:{i}: matches {r.pattern}" for r in rx if r.search(line)][:1]
    return hits


def cmd_leaks(a):
    hits = leak_scan(Path(a.path))
    for h in hits:
        print(h)
    if hits:
        print(f"blocked: {len(hits)} match(es) from {app_home() / 'corgi.leaks'}")
    return 1 if hits else 0


PRE_PUSH = """#!/bin/sh
# corgi pre-push: blocks the push when a tracked file matches a term in corgi.leaks (installed by corgi dev)
exec {python} {corgi} leaks "$(git rev-parse --show-toplevel)"
"""


def cmd_dev(a):
    co = Path(os.path.abspath(Path(a.checkout).expanduser()))
    if not (co / ".git").exists():
        raise Fail(f"{co} is not a git checkout")
    installed, lock = load_state()
    try:
        manifest = load_manifest()
    except Fail:
        manifest = {}
    origin = git("-C", co, "remote", "get-url", "origin", check=False).strip()
    entry = manifest.get(a.mod) or {"repo": origin or str(co), "path": f"mods/{a.mod}"}
    src = source(a.mod, entry, dev=co)
    dest = mod_dir(a.mod)
    if dest.exists():
        rep = adopt(a.mod, dest, src.dir)
        rep.show(a.mod, f"dev checkout {co} (live folder kept as is)", "differs from the checkout's HEAD")
    else:
        rep = install(a.mod, src.dir, dest, {}, a.dry_run)
        rep.show(a.mod, f"install from dev checkout {co}")
    hook = Path(git("-C", co, "rev-parse", "--git-path", "hooks/pre-push").strip())
    hook = hook if hook.is_absolute() else co / hook
    if hook.exists() and "corgi pre-push" not in hook.read_text():
        print(f"  {hook} exists and isn't corgi's, left alone (no private leak check on push)")
    else:
        print(f"  pre-push hook {hook}: private leak check")
        if not a.dry_run:
            hook.parent.mkdir(parents=True, exist_ok=True)
            hook.write_text(PRE_PUSH.format(python=shlex.quote(sys.executable),
                                            corgi=shlex.quote(str(Path(__file__).resolve()))))
            hook.chmod(0o755)
    if not a.dry_run:
        record(installed, lock, src, rep.files)
    return finish(a, installed, lock)


def cmd_save(a):
    installed, lock = load_state()
    co = checkout_of(a.mod, lock)
    refuse_dirty(co)
    try:
        manifest = load_manifest()
    except Fail:
        manifest = {}
    path = entry_for(a.mod, manifest, lock[a.mod])["path"]
    live, target = mod_dir(a.mod), co / path
    private = [p.strip() for p in (read(live / ".corgi-private") or b"").decode().splitlines()
               if p.strip() and not p.startswith("#")]

    def excluded(rel):
        return rel == ".corgi-private" or any(fnmatch.fnmatch(rel, p) or rel.startswith(p.rstrip("/") + "/")
                                              for p in private)

    files = [r for r in list_files(live) if not excluded(r)]
    tracked = [r[len(path) + 1:] for r in git("-C", co, "ls-files", "-z", "--", path).split("\0") if r]
    changes = {r: read(live / r) for r in files if read(target / r) != read(live / r)}
    changes |= {r: None for r in tracked if r not in files and not excluded(r)}
    if not changes:
        print(f"{a.mod}: nothing to save, {target} matches the live folder")
        return 0
    for r in mod_json_first(changes):
        print(f"  {'delete' if changes[r] is None else 'copy':6}  {r}")
    if a.dry_run:
        return finish(a, installed, lock)
    write_files(target, changes, live)
    git("-C", co, "add", "-A", "--", path)
    print(git("-C", co, "diff", "--cached", "--stat").rstrip())
    git("-C", co, "commit", "-q", "-m", a.message)
    src = source(a.mod, entry_for(a.mod, manifest, lock[a.mod]), dev=co)
    record(installed, lock, src, hashes(src.dir))
    print(f"{a.mod}: committed \"{a.message}\" in {co}")
    return finish(a, installed, lock)


def bump(version, part):
    x, y, z = vt(version)
    return {"major": f"{x + 1}.0.0", "minor": f"{x}.{y + 1}.0", "patch": f"{x}.{y}.{z + 1}"}[part]


def changelog_section(version, subjects):
    """A CHANGELOG.md section from Conventional Commit subjects, grouped feat / fix / other."""
    groups = {"Features": [], "Fixes": [], "Other": []}
    for s in subjects:
        m = re.match(r"(\w+)(?:\(([^)]*)\))?!?:\s*(.+)", s)
        kind = {"feat": "Features", "fix": "Fixes"}.get(m[1] if m else "", "Other")
        groups[kind].append(s if kind == "Other" else (f"{m[2]}: " if m[2] else "") + m[3])
    parts = [f"## {version} ({time.strftime('%Y-%m-%d')})\n"]
    parts += [f"### {t}\n\n" + "".join(f"- {i}\n" for i in items) for t, items in groups.items() if items]
    return "\n".join(parts)


def cmd_release(a):
    installed, lock = load_state()
    co = checkout_of(a.mod, lock)
    refuse_dirty(co)
    try:
        manifest = load_manifest()
    except Fail:
        manifest = {}
    entry = entry_for(a.mod, manifest, lock[a.mod])
    live, problems = mod_dir(a.mod), []
    chk = co / ".github/scripts/check.py"
    if chk.is_file():
        p = subprocess.run([sys.executable, str(chk)], cwd=co, capture_output=True, text=True)
        if p.returncode:
            problems.append(f"{chk.relative_to(co)} failed:\n{p.stdout}{p.stderr}")
    else:
        print(f"no {chk.relative_to(co)} in {co}, repo checks skipped")
    hits = leak_scan(co)
    if hits:
        problems.append("private terms from corgi.leaks found:\n" + "\n".join(f"  {h}" for h in hits))
    ok, out = run_check(live)
    if not ok:
        problems.append(f"herdr-app check failed on {live}:\n{out}")
    if problems:
        print("\n".join(problems) + f"\n{a.mod}: not released")
        return 1
    last = git("-C", co, "describe", "--tags", "--abbrev=0", "--match", "v[0-9]*", check=False).strip()
    subjects = [s for s in git("-C", co, "log", "--reverse", "--format=%s", f"{last}..HEAD" if last else "HEAD")
                .splitlines() if not s.startswith("chore(release)")]
    if not subjects:
        print(f"{a.mod}: no commits since {last or 'the start'}, nothing to release")
        return 0
    meta_path = co / entry["path"] / "corgi.json"
    meta = load_json(meta_path, {"name": a.mod})
    cur = meta.get("version") or (last[1:] if last else "0.0.0")
    new = bump(cur, a.part)
    section = changelog_section(new, subjects)
    print(f"{a.mod}: {cur} -> {new}\n\n{section}")
    if a.dry_run:
        print("(dry run: nothing changed)")
        return 0
    log_path = co / "CHANGELOG.md"
    text = (read(log_path) or b"# Changelog\n").decode()
    i = text.find("\n## ")
    text = text[:i + 1] + section + "\n" + text[i + 1:] if i >= 0 else text.rstrip("\n") + "\n\n" + section
    log_path.write_text(text)
    meta["version"] = new
    save_json(meta_path, meta)
    shutil.copy2(meta_path, live / "corgi.json")  # the live folder stays equal to the checkout
    git("-C", co, "add", "-A")
    git("-C", co, "commit", "-q", "-m", f"chore(release): v{new}")
    git("-C", co, "tag", "-a", f"v{new}", "-m", f"v{new}")
    src = source(a.mod, entry, dev=co)
    record(installed, lock, src, hashes(src.dir), cur)
    save_state(installed, lock)
    print(f"{a.mod}: committed and tagged v{new} in {co}")
    if a.yes or ask(f"Push {co.name} and tag v{new} to origin? [y/N] "):
        git("-C", co, "push", "-q", "--follow-tags", "origin", "HEAD")
        print("pushed; the release workflow publishes the GitHub release")
    else:
        print(f"not pushed; later: git -C {shlex.quote(str(co))} push --follow-tags origin HEAD")
    return 0


def cmd_doctor(a):
    installed, lock = load_state()
    fails = 0

    def line(ok, text, warn=False):
        nonlocal fails
        print(f"{'ok  ' if ok else 'warn' if warn else 'FAIL'}  {text}")
        fails += not ok and not warn

    v = herdr_version()
    line(v, f"herdr-app {v}" if v else f"herdr-app not found ({herdr_app()} --version)")
    line(shutil.which("git"), "git")
    line(shutil.which("gh"), "gh (only some mods need it; see each mod's README)", warn=True)
    line(sys.version_info >= (3, 9), f"python3 {sys.version.split()[0]}")
    apis = provided(installed)
    for name, ent in sorted(lock.items()):
        dest = mod_dir(name)
        if not dest.is_dir():
            line(False, f"{name}: {dest} is missing (corgi sync installs it)")
            continue
        unmet = unmet_requires(load_json(dest / "corgi.json", {}), apis)
        changed = local_changes(installed.get(name, {}), dest)
        line(not unmet, f"{name} {ent['version']}" + (f": {'; '.join(unmet)}" if unmet else "") +
             (f", {len(changed)} file(s) changed locally" if changed else "") +
             (f", dev checkout {ent['dev']}" if ent.get("dev") else ""))
        if ent.get("dev") and not Path(ent["dev"]).is_dir():
            line(False, f"{name}: dev checkout {ent['dev']} is missing (corgi sync clones it)")
    return 1 if fails else 0


def cmd_status(a):
    installed, lock = load_state()
    try:
        manifest = load_manifest()
    except Fail:
        manifest = {}
    out = {"mods": {}, "updates": [], "unmanaged": []}
    for name, ent in sorted(lock.items()):
        rec = installed.get(name, {})
        info = {"version": ent.get("version"), "dev": ent.get("dev"), "installed": name in installed,
                "changed": local_changes(rec, mod_dir(name)), "latest": None, "update": False,
                "changelog": "", "error": None}
        if not ent.get("dev"):
            try:
                d = fetch(ent["repo"])
                info["latest"] = latest(d, manifest.get(name, {}).get("path", f"mods/{name}"))
                if newer(info["latest"], ent["version"]):
                    info["update"] = True
                    log = git("-C", d, "show", f"{ref_of(info['latest'])}:CHANGELOG.md", check=False)
                    info["changelog"] = changelog(log, ent["version"], info["latest"])
                    out["updates"].append(name)
            except Fail as e:
                info["error"] = str(e)
        out["mods"][name] = info
    out["unmanaged"] = [n for n in manifest if n not in lock and mod_dir(n).is_dir()]
    if a.json:
        print(json.dumps(out, indent=2))
        return 0
    for name, i in out["mods"].items():
        bits = [f"{name} {i['version']}"]
        if i["dev"]:
            bits.append(f"dev: {i['dev']}")
        if i["update"]:
            bits.append(f"update available: {i['latest']}")
        if i["changed"]:
            bits.append(f"changed locally: {', '.join(i['changed'])}")
        if i["error"]:
            bits.append(f"error: {i['error']}")
        print("  ".join(bits))
    if out["unmanaged"]:
        print(f"not managed by corgi (corgi enable adopts them): {', '.join(out['unmanaged'])}")
    if not lock:
        print("no mods enabled")
    return 0


def ask(prompt):
    try:
        return input(prompt).strip().lower() in ("y", "yes")
    except EOFError:
        return False


def main(argv=None):
    p = argparse.ArgumentParser(prog="corgi", description="Install, update and develop herdr-corgi mods.")
    sub = p.add_subparsers(dest="cmd", required=True)
    dry = argparse.ArgumentParser(add_help=False)
    dry.add_argument("--dry-run", action="store_true", help="print what would change, change nothing")

    s = sub.add_parser("enable", parents=[dry], help="install mods (or adopt existing folders)")
    s.add_argument("mods", nargs="*")
    s.add_argument("--all", action="store_true", help="every default mod in mods.json")
    s.add_argument("--keys", choices=["ask", "merge", "skip"])
    s.set_defaults(func=cmd_enable)

    s = sub.add_parser("disable", parents=[dry], help="remove a mod's unchanged files and keys")
    s.add_argument("mod")
    s.set_defaults(func=cmd_disable)

    s = sub.add_parser("update", parents=[dry], help="update mods to the latest (or a given) version")
    s.add_argument("mods", nargs="*", metavar="mod[@X.Y.Z]")
    s.add_argument("--force", action="store_true", help="take the new version of every file (yours saved as a patch)")
    s.add_argument("--keep-mine", action="append", metavar="FILE", help="keep your version of FILE")
    s.add_argument("--take-theirs", action="append", metavar="FILE", help="take the new FILE, yours saved as a patch")
    s.set_defaults(func=cmd_update)

    s = sub.add_parser("diff", help="your local changes against the installed version")
    s.add_argument("mod")
    s.set_defaults(func=cmd_diff)

    s = sub.add_parser("resolve", parents=[dry], help="let a Claude tab merge your changes into the new version")
    s.add_argument("mod")
    s.add_argument("version", nargs="?", help="target version (default: latest)")
    s.add_argument("--apply", action="store_true", help="show the agent's result, check it, apply on yes")
    s.set_defaults(func=cmd_resolve)

    s = sub.add_parser("customizations", parents=[dry], help="export: write customizations/<mod>.patch")
    s.add_argument("action", choices=["export"])
    s.add_argument("mods", nargs="*")
    s.set_defaults(func=cmd_customizations)

    s = sub.add_parser("sync", parents=[dry], help="install everything in corgi.lock (new machine)")
    s.add_argument("--keys", choices=["merge", "skip"])
    s.set_defaults(func=cmd_sync)

    s = sub.add_parser("rollback", parents=[dry], help="back to the previous version in the lock history")
    s.add_argument("mod")
    s.set_defaults(func=cmd_rollback)

    s = sub.add_parser("dev", parents=[dry], help="use a git checkout as the mod's source (author mode)")
    s.add_argument("mod")
    s.add_argument("checkout")
    s.set_defaults(func=cmd_dev)

    s = sub.add_parser("save", parents=[dry], help="copy the live folder into the dev checkout and commit")
    s.add_argument("mod")
    s.add_argument("message", help="a Conventional Commit message, e.g. 'feat: fuzzy titles'")
    s.set_defaults(func=cmd_save)

    s = sub.add_parser("release", parents=[dry], help="changelog, version bump, tag, push (asks first)")
    s.add_argument("mod")
    s.add_argument("part", choices=["major", "minor", "patch"])
    s.add_argument("--yes", action="store_true", help="push without asking")
    s.set_defaults(func=cmd_release)

    s = sub.add_parser("bundle", parents=[dry], help="copy the released mods into this repo for herdr.dev")
    s.add_argument("repo", nargs="?", help="the herdr-corgi checkout to write into (default: this one)")
    s.set_defaults(func=cmd_bundle)

    s = sub.add_parser("doctor", help="check herdr-app, git, gh, python3 and each mod's requires")
    s.set_defaults(func=cmd_doctor)

    s = sub.add_parser("leaks", help="scan a checkout for terms in corgi.leaks (the pre-push hook)")
    s.add_argument("path")
    s.set_defaults(func=cmd_leaks)

    s = sub.add_parser("status", help="installed versions, updates, local changes")
    s.add_argument("--json", action="store_true")
    s.set_defaults(func=cmd_status)

    a = p.parse_args(argv)
    try:
        return a.func(a) or 0
    except Fail as e:
        print(f"corgi: {e}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
