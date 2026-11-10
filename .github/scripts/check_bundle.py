#!/usr/bin/env python3
"""Checks the bundled mods, run from the repo root: python3 .github/scripts/check_bundle.py

Every mod in mods.json except corgi must be in bundle.json, and each mods/<mod>/ must match its repo at the
recorded tag and sha byte for byte (BUNDLED.md aside). `./corgi.py bundle` writes both. The mod repos are
public, so CI fetches them; offline (outside CI) the check is skipped.
"""
import atexit
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
import corgi  # noqa: E402


class Offline(Exception):
    pass


def tree_at(repo, rec):
    """The repo's tree at rec["sha"], exported; for a tag, also that the tag still points there."""
    d = tempfile.mkdtemp(prefix="corgi-bundle-")
    atexit.register(shutil.rmtree, d, True)
    corgi.git("init", "-q", "--bare", d)
    want = f"refs/tags/{rec['tag']}" if rec.get("tag") else "HEAD"
    p = subprocess.run(["git", "-C", d, "fetch", "-q", "--no-tags", rec["repo"], want], capture_output=True, text=True)
    if p.returncode:
        raise Offline(p.stderr.strip())
    if rec.get("tag"):
        got = corgi.git("-C", d, "rev-parse", "FETCH_HEAD^{commit}").strip()
        if got != rec["sha"]:
            return None, f"tag {rec['tag']} now points at {got[:7]}, bundle.json says {rec['sha'][:7]} (run ./corgi.py bundle)"
    elif subprocess.run(["git", "-C", d, "cat-file", "-e", rec["sha"] + "^{commit}"], capture_output=True).returncode:
        return None, f"commit {rec['sha'][:7]} is not on the default branch"
    return corgi.export(d, rec["sha"]), None


def verify(root=ROOT):
    """Problems as strings; raises Offline when a repo can't be fetched."""
    root = Path(root)
    bundle = corgi.load_json(root / "bundle.json", None)
    if bundle is None:
        return ["bundle.json is missing (run ./corgi.py bundle)"]
    manifest = corgi.load_manifest(root / "mods.json")
    problems = [f"{n}: in mods.json but not bundled (run ./corgi.py bundle)"
                for n in manifest if n != "corgi" and n not in bundle]
    for name, rec in sorted(bundle.items()):
        tree, err = tree_at(rec["repo"], rec)
        if err:
            problems.append(f"{name}: {err}")
            continue
        want = corgi.hashes(tree / manifest.get(name, {}).get("path", f"mods/{name}"))
        have = corgi.hashes(root / "mods" / name)
        have.pop("BUNDLED.md", None)
        at = rec.get("tag") or rec["sha"][:7]
        problems += [f"{name}: {rel} differs from {at}" for rel in sorted(set(want) & set(have)) if want[rel] != have[rel]]
        problems += [f"{name}: {rel} is missing (in {at})" for rel in sorted(set(want) - set(have))]
        problems += [f"{name}: {rel} is not in {at}" for rel in sorted(set(have) - set(want))]
    return problems


def main():
    try:
        problems = verify()
    except Offline as e:
        if os.environ.get("CI"):
            print(f"FAIL cannot fetch a mod repo: {e}")
            return 1
        print(f"check_bundle: skipped, offline ({e})")
        return 0
    for p in problems:
        print("FAIL", p)
    print("check_bundle:", "FAILED" if problems else "ok")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
