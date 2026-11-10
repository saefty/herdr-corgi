"""Tests for corgi.py. Temp dirs only, local bare repos as remotes, no network.

Run: python3 -m unittest discover tests   (or python3 tests/test_corgi.py)
"""
import contextlib
import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import corgi  # noqa: E402

SNIPPET = {"global": {"cmd-shift-g": "mod.open:goto", "cmd-alt-g": "goto.toggle"}}


def git(cwd, *args):
    return subprocess.run(["git", "-C", str(cwd), *map(str, args)], check=True,
                          capture_output=True, text=True).stdout


def write(path, text):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text)


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="corgi-test-"))
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.app = self.tmp / "app"
        self.state = self.tmp / "state"
        env = {
            "CORGI_HOME": str(self.state), "HERDR_APP_HOME": str(self.app),
            "CORGI_MANIFEST": str(self.tmp / "mods.json"), "CORGI_CHECK": "true",
            "CORGI_HERDR_VERSION": "0.1.14", "CORGI_HERDR_APP": "true",
            "GIT_CONFIG_GLOBAL": str(self.tmp / "gitconfig"), "GIT_CONFIG_NOSYSTEM": "1",
            "GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@users.noreply.github.com",
            "GIT_COMMITTER_NAME": "t", "GIT_COMMITTER_EMAIL": "t@users.noreply.github.com",
        }
        write(self.tmp / "gitconfig", "[init]\n\tdefaultBranch = main\n")
        patcher = mock.patch.dict(os.environ, env)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.manifest = {"mods": {}}
        self.answers = []
        patcher = mock.patch.object(corgi, "ask", lambda prompt: self.answers.pop(0) if self.answers else False)
        patcher.start()
        self.addCleanup(patcher.stop)

    # --- fixtures -------------------------------------------------------
    def make_repo(self, name, files, version="0.1.0", keys=None, **kw):
        bare = self.tmp / "remotes" / f"herdr-corgi-{name}.git"
        work = self.tmp / "work" / name
        bare.parent.mkdir(parents=True, exist_ok=True)
        git(self.tmp, "init", "-q", "--bare", bare)
        git(self.tmp, "clone", "-q", bare, work)
        self.manifest["mods"][name] = {"repo": str(bare), "path": f"mods/{name}", "default": True}
        write(self.tmp / "mods.json", json.dumps(self.manifest))
        self.release(work, name, files, version, keys, **kw)
        return work, bare

    def release(self, work, name, files, version, keys=None, notes=None, tag=True, requires=None, provides=None):
        d = work / "mods" / name
        for rel, text in files.items():
            if text is None:
                (d / rel).unlink()
            else:
                write(d / rel, text)
        meta = {"name": name, "version": version, "requires": requires or {"herdr-app": ">=0.1.14"},
                "provides": provides or {}, "keys": "keys.json" if keys else None}
        write(d / "corgi.json", json.dumps(meta, indent=2) + "\n")
        if keys:
            write(work / "keys.json", json.dumps(keys, indent=2))
        log = work / "CHANGELOG.md"
        old = log.read_text().split("\n", 1)[1] if log.exists() else ""
        write(log, f"# Changelog\n\n## {version}\n\n- {notes or 'release ' + version}\n{old}")
        git(work, "add", "-A")
        git(work, "commit", "-q", "-m", f"feat: {version}")
        if tag:
            git(work, "tag", f"v{version}")
        git(work, "push", "-q", "origin", "HEAD", "--tags")

    def run_cli(self, *argv):
        out = io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(out):
            code = corgi.main(list(argv))
        return code, out.getvalue()

    def quiet(self, fn, *args, **kw):
        with contextlib.redirect_stdout(io.StringIO()):
            return fn(*args, **kw)

    def installed(self):
        return json.loads((self.state / "installed.json").read_text())

    def lock(self):
        return json.loads((self.app / "corgi.lock").read_text())

    def live(self, name):
        return self.app / "mods" / name


GOTO = {"mod.json": '{"place": "none"}\n', "main.js": "export default 1\n", "lib/util.js": "a\nb\nc\nd\ne\nf\ng\n"}


class B1InstallAdopt(Base):
    def test_manifest_format(self):
        self.make_repo("goto", GOTO)
        m = corgi.load_manifest()
        self.assertEqual(m["goto"]["path"], "mods/goto")
        self.assertTrue(m["goto"]["default"])

    def test_fresh_install_writes_all_files_and_records_hashes(self):
        self.make_repo("goto", GOTO)
        code, out = self.run_cli("enable", "goto", "--keys=skip")
        self.assertEqual(code, 0, out)
        self.assertEqual((self.live("goto") / "lib/util.js").read_text(), GOTO["lib/util.js"])
        rec = self.installed()["goto"]
        self.assertEqual(rec["version"], "0.1.0")
        self.assertEqual(rec["source"], "release")
        self.assertEqual(rec["files"]["main.js"], corgi.sha(self.live("goto") / "main.js"))
        self.assertIn("corgi.json", rec["files"])
        lock = self.lock()["goto"]
        self.assertEqual((lock["version"], lock["dev"], lock["history"]), ("0.1.0", None, []))
        self.assertTrue((self.state / "pristine/goto/0.1.0/main.js").is_file())

    def test_install_writes_mod_json_first(self):
        src = self.tmp / "src"
        for rel, text in GOTO.items():
            write(src / rel, text)
        rep = corgi.install("goto", src, self.tmp / "dest", {})
        self.assertEqual(rep.written[0], "mod.json")

    def test_reinstall_after_manual_edit_keeps_the_edit(self):
        src, dest = self.tmp / "src", self.tmp / "dest"
        for rel, text in GOTO.items():
            write(src / rel, text)
        rep = corgi.install("goto", src, dest, {})
        write(dest / "main.js", "mine\n")
        write(src / "main.js", "export default 2\n")
        write(src / "lib/util.js", "new\n")
        rep2 = corgi.install("goto", src, dest, {"files": rep.files})
        self.assertEqual((dest / "main.js").read_text(), "mine\n")
        self.assertEqual(rep2.changed, ["main.js"])
        self.assertEqual((dest / "lib/util.js").read_text(), "new\n")

    def test_adopt_identical_folder(self):
        self.make_repo("goto", GOTO)
        for rel, text in GOTO.items():
            write(self.live("goto") / rel, text)
        shutil.copy(self.tmp / "work/goto/mods/goto/corgi.json", self.live("goto"))
        write(self.live("goto") / "gpui-kit.d.ts", "generated")
        code, out = self.run_cli("enable", "goto", "--keys=skip")
        self.assertEqual(code, 0, out)
        self.assertIn("adopted", out)
        rec = self.installed()["goto"]
        self.assertEqual(rec["files"], corgi.hashes(self.tmp / "work/goto/mods/goto"))
        self.assertEqual(corgi.local_changes(rec, self.live("goto")), [])

    def test_adopt_differing_folder_lists_files_and_leaves_them(self):
        self.make_repo("goto", GOTO)
        for rel, text in GOTO.items():
            write(self.live("goto") / rel, text)
        write(self.live("goto") / "main.js", "my version\n")
        write(self.live("goto") / "notes.txt", "private\n")
        code, out = self.run_cli("enable", "goto", "--keys=skip")
        self.assertEqual(code, 0, out)
        self.assertIn("main.js", out)
        self.assertEqual((self.live("goto") / "main.js").read_text(), "my version\n")
        self.assertFalse((self.live("goto") / "corgi.json").exists())  # adopt never writes
        rec = self.installed()["goto"]
        self.assertEqual(sorted(corgi.local_changes(rec, self.live("goto"))), ["corgi.json", "main.js"])

    def test_dry_run_writes_nothing(self):
        self.make_repo("goto", GOTO)
        code, out = self.run_cli("enable", "goto", "--keys=skip", "--dry-run")
        self.assertEqual(code, 0, out)
        self.assertIn("main.js", out)
        self.assertFalse(self.live("goto").exists())
        self.assertFalse((self.state / "installed.json").exists())
        self.assertFalse((self.app / "corgi.lock").exists())

    def test_untagged_repo_installs_head(self):
        self.make_repo("goto", GOTO, tag=False)
        code, out = self.run_cli("enable", "goto", "--keys=skip")
        self.assertEqual(code, 0, out)
        self.assertRegex(self.lock()["goto"]["version"], r"^0\.1\.0\+[0-9a-f]{7}$")

    def test_unreachable_repo_installs_nothing(self):
        self.make_repo("goto", GOTO)
        self.make_repo("chatbar", {"mod.json": "{}", "main.js": "1"})
        shutil.rmtree(self.tmp / "remotes/herdr-corgi-chatbar.git")
        code, out = self.run_cli("enable", "--all")
        self.assertEqual(code, 1)
        self.assertIn("herdr-corgi-chatbar", out)
        self.assertFalse(self.live("goto").exists())


class B2Keys(Base):
    HAND = '{\n    "global":{"cmd-q":"app.quit",\n  "cmd-alt-g": "something.else"},\n "terminal": {"ctrl-1": "terminal"}\n}\n'

    def test_ask_no_leaves_keys_byte_identical(self):
        write(self.app / "keys.json", self.HAND)
        self.answers = [False]
        rep = self.quiet(corgi.merge_keys, self.app / "keys.json", SNIPPET, "ask")
        self.assertEqual((self.app / "keys.json").read_text(), self.HAND)
        self.assertFalse(rep.written)

    def test_merge_adds_new_keeps_existing_and_skips_conflict(self):
        write(self.app / "keys.json", self.HAND)
        rep = self.quiet(corgi.merge_keys, self.app / "keys.json", SNIPPET, "merge")
        data = json.loads((self.app / "keys.json").read_text())
        self.assertEqual(list(data["global"]), ["cmd-q", "cmd-alt-g", "cmd-shift-g"])  # order kept, new appended
        self.assertEqual(data["global"]["cmd-alt-g"], "something.else")
        self.assertEqual(data["terminal"], {"ctrl-1": "terminal"})
        self.assertEqual(rep.added, {"global": {"cmd-shift-g": "mod.open:goto"}})
        self.assertEqual(rep.skipped, [("global", "cmd-alt-g", "something.else")])

    def test_missing_keys_json_created_only_after_consent(self):
        self.answers = [False]
        self.quiet(corgi.merge_keys, self.app / "keys.json", SNIPPET, "ask")
        self.assertFalse((self.app / "keys.json").exists())
        self.answers = [True]
        self.quiet(corgi.merge_keys, self.app / "keys.json", SNIPPET, "ask")
        self.assertEqual(json.loads((self.app / "keys.json").read_text()), SNIPPET)

    def test_enable_asks_and_disable_removes_only_unchanged_corgi_keys(self):
        self.make_repo("goto", GOTO, keys=SNIPPET)
        write(self.app / "keys.json", '{"global": {"cmd-q": "app.quit"}}')
        self.answers = [True]
        code, out = self.run_cli("enable", "goto")
        self.assertEqual(code, 0, out)
        self.assertIn("cmd-shift-g", out)
        self.assertIn("new default shortcuts", out)
        keys = json.loads((self.app / "keys.json").read_text())
        keys["global"]["cmd-alt-g"] = "my.own"  # the person rebinds one of corgi's keys
        write(self.app / "keys.json", json.dumps(keys))
        write(self.live("goto") / "main.js", "edited\n")
        code, out = self.run_cli("disable", "goto")
        self.assertEqual(code, 0, out)
        self.assertEqual(json.loads((self.app / "keys.json").read_text()),
                         {"global": {"cmd-q": "app.quit", "cmd-alt-g": "my.own"}})
        self.assertEqual(sorted(corgi.list_files(self.live("goto"))), ["main.js"])  # the edit survives
        self.assertIn("main.js", out)
        self.assertNotIn("goto", self.lock())
        self.assertNotIn("goto", self.installed())

    def test_disable_removes_untouched_folder(self):
        self.make_repo("goto", GOTO)
        self.run_cli("enable", "goto", "--keys=skip")
        write(self.live("goto") / "jsconfig.json", "{}")  # generated by herdr-app check
        code, out = self.run_cli("disable", "goto")
        self.assertEqual(code, 0, out)
        self.assertFalse(self.live("goto").exists())

    def test_all_without_keys_merge_never_touches_keys_and_prints_snippet(self):
        self.make_repo("goto", GOTO, keys=SNIPPET)
        write(self.app / "keys.json", self.HAND)
        self.answers = [True, True]  # must not be asked
        code, out = self.run_cli("enable", "--all")
        self.assertEqual(code, 0, out)
        self.assertEqual((self.app / "keys.json").read_text(), self.HAND)
        self.assertIn('"cmd-shift-g": "mod.open:goto"', out)
        self.assertEqual(self.answers, [True, True])
        self.assertEqual(self.installed()["goto"].get("keys"), {})

    def test_all_with_keys_merge(self):
        self.make_repo("goto", GOTO, keys=SNIPPET)
        code, out = self.run_cli("enable", "--all", "--keys=merge")
        self.assertEqual(code, 0, out)
        self.assertEqual(json.loads((self.app / "keys.json").read_text()), SNIPPET)

    def test_status_json(self):
        work, _ = self.make_repo("goto", GOTO)
        write(self.live("chatbar") / "main.js", "x")
        self.manifest["mods"]["chatbar"] = {"repo": "/nowhere", "path": "mods/chatbar"}
        write(self.tmp / "mods.json", json.dumps(self.manifest))
        self.run_cli("enable", "goto", "--keys=skip")
        write(self.live("goto") / "main.js", "edited\n")
        self.release(work, "goto", {"main.js": "v2\n"}, "0.2.0", notes="better goto")
        code, out = self.run_cli("status", "--json")
        self.assertEqual(code, 0, out)
        st = json.loads(out)
        g = st["mods"]["goto"]
        self.assertEqual((g["version"], g["latest"], g["update"]), ("0.1.0", "0.2.0", True))
        self.assertEqual(g["changed"], ["main.js"])
        self.assertIn("better goto", g["changelog"])
        self.assertEqual(st["updates"], ["goto"])
        self.assertEqual(st["unmanaged"], ["chatbar"])

    def test_status_json_network_down_reports_error_not_update(self):
        self.make_repo("goto", GOTO)
        self.run_cli("enable", "goto", "--keys=skip")
        shutil.rmtree(self.tmp / "remotes")
        code, out = self.run_cli("status", "--json")
        self.assertEqual(code, 0, out)
        g = json.loads(out)["mods"]["goto"]
        self.assertFalse(g["update"])
        self.assertTrue(g["error"])


class B3Update(Base):
    def setUp(self):
        super().setUp()
        self.work, self.bare = self.make_repo("goto", GOTO)
        self.run_cli("enable", "goto", "--keys=skip")

    def test_update_prints_changelog_between_versions_and_applies(self):
        self.release(self.work, "goto", {"main.js": "v2\n"}, "0.2.0", notes="second")
        self.release(self.work, "goto", {"main.js": "v3\n"}, "0.3.0", notes="third")
        code, out = self.run_cli("update", "goto")
        self.assertEqual(code, 0, out)
        self.assertIn("## 0.2.0", out)
        self.assertIn("## 0.3.0", out)
        self.assertNotIn("## 0.1.0", out)
        self.assertEqual((self.live("goto") / "main.js").read_text(), "v3\n")
        self.assertEqual(self.lock()["goto"]["version"], "0.3.0")
        self.assertEqual(self.lock()["goto"]["history"], ["0.1.0"])

    def test_update_to_a_given_version(self):
        self.release(self.work, "goto", {"main.js": "v2\n"}, "0.2.0")
        self.release(self.work, "goto", {"main.js": "v3\n"}, "0.3.0")
        code, out = self.run_cli("update", "goto@0.2.0")
        self.assertEqual(code, 0, out)
        self.assertEqual((self.live("goto") / "main.js").read_text(), "v2\n")

    def test_failing_check_rolls_back_and_exits_1(self):
        self.release(self.work, "goto", {"main.js": "broken\n", "new.js": "n\n"}, "0.2.0")
        os.environ["CORGI_CHECK"] = "false"
        code, out = self.run_cli("update", "goto")
        self.assertEqual(code, 1, out)
        self.assertIn("rolled back", out)
        self.assertEqual((self.live("goto") / "main.js").read_text(), GOTO["main.js"])
        self.assertFalse((self.live("goto") / "new.js").exists())
        self.assertEqual(self.lock()["goto"]["version"], "0.1.0")
        self.assertEqual(self.lock()["goto"]["failed"], "0.2.0")
        self.assertEqual(self.installed()["goto"]["version"], "0.1.0")

    def test_edited_file_survives_without_force(self):
        write(self.live("goto") / "main.js", "mine\n")
        self.release(self.work, "goto", {"mod.json": '{"place": "none", "size": 1}\n'}, "0.2.0")
        code, out = self.run_cli("update", "goto")
        self.assertEqual(code, 0, out)
        self.assertEqual((self.live("goto") / "main.js").read_text(), "mine\n")
        self.assertIn('"size": 1', (self.live("goto") / "mod.json").read_text())
        self.assertIn("main.js", out)

    def test_force_overwrites_edited_file(self):
        write(self.live("goto") / "main.js", "mine\n")
        self.release(self.work, "goto", {"mod.json": "{}\n"}, "0.2.0")
        code, out = self.run_cli("update", "goto", "--force")
        self.assertEqual(code, 0, out)
        self.assertEqual((self.live("goto") / "main.js").read_text(), GOTO["main.js"])

    def test_rollback_restores_previous_version(self):
        self.release(self.work, "goto", {"main.js": "v2\n", "new.js": "n\n"}, "0.2.0")
        self.run_cli("update", "goto")
        shutil.rmtree(self.tmp / "remotes")  # rollback works offline from the pristine copy
        code, out = self.run_cli("rollback", "goto")
        self.assertEqual(code, 0, out)
        self.assertEqual((self.live("goto") / "main.js").read_text(), GOTO["main.js"])
        self.assertFalse((self.live("goto") / "new.js").exists())
        self.assertEqual(self.lock()["goto"]["version"], "0.1.0")
        self.assertEqual(self.lock()["goto"]["history"], [])
        code, out = self.run_cli("rollback", "goto")
        self.assertEqual(code, 1)

    def test_unmet_requires_refuses_with_reason(self):
        self.release(self.work, "goto", {"main.js": "v2\n"}, "0.2.0", requires={"herdr-app": ">=0.2.0"})
        code, out = self.run_cli("update", "goto")
        self.assertEqual(code, 1, out)
        self.assertIn("herdr-app >=0.2.0", out)
        self.assertIn("0.1.14", out)
        self.assertEqual((self.live("goto") / "main.js").read_text(), GOTO["main.js"])

    def test_enable_refuses_unmet_requires(self):
        self.make_repo("chatbar", {"mod.json": "{}", "main.js": "c"}, requires={"herdr-app": ">=9"})
        code, out = self.run_cli("enable", "chatbar")
        self.assertEqual(code, 1, out)
        self.assertIn("needs herdr-app >=9, found 0.1.14", out)
        self.assertFalse(self.live("chatbar").exists())

    def test_requires_api_of_installed_provider(self):
        self.make_repo("chatbar", {"mod.json": "{}", "main.js": "c"}, provides={"chatbar-api": 1})
        self.run_cli("enable", "chatbar", "--keys=skip")
        self.release(self.work, "goto", {"main.js": "v2\n"}, "0.2.0", requires={"chatbar-api": ">=2"})
        code, out = self.run_cli("update", "goto")
        self.assertEqual(code, 1, out)
        self.assertIn("chatbar-api >=2", out)
        self.release(self.work, "goto", {"main.js": "v3\n"}, "0.3.0", requires={"dictate-api": ">=1"})
        code, out = self.run_cli("update", "goto")  # a missing partner never blocks
        self.assertEqual(code, 0, out)

    def test_network_failure_leaves_everything_unchanged(self):
        self.release(self.work, "goto", {"main.js": "v2\n"}, "0.2.0")
        shutil.rmtree(self.tmp / "remotes")
        before = (self.installed(), self.lock(), corgi.hashes(self.live("goto")))
        code, out = self.run_cli("update", "goto")
        self.assertEqual(code, 1, out)
        self.assertIn("cannot fetch", out)
        self.assertEqual(before, (self.installed(), self.lock(), corgi.hashes(self.live("goto"))))

    def test_dry_run_update_changes_nothing(self):
        self.release(self.work, "goto", {"main.js": "v2\n"}, "0.2.0")
        code, out = self.run_cli("update", "goto", "--dry-run")
        self.assertEqual(code, 0, out)
        self.assertIn("main.js", out)
        self.assertEqual((self.live("goto") / "main.js").read_text(), GOTO["main.js"])
        self.assertEqual(self.lock()["goto"]["version"], "0.1.0")


UTIL = GOTO["lib/util.js"]  # a..g, one per line


class B3bMerge(Base):
    def setUp(self):
        super().setUp()
        self.work, self.bare = self.make_repo("goto", GOTO)
        self.run_cli("enable", "goto", "--keys=skip")

    def util(self):
        return (self.live("goto") / "lib/util.js").read_text()

    def test_merge_file(self):
        text, bad = corgi.merge_file(b"a\nb\nc\nd\n", b"A\nb\nc\nd\n", b"a\nb\nc\nD\n")
        self.assertEqual((text, bad), (b"A\nb\nc\nD\n", False))
        self.assertTrue(corgi.merge_file(b"a\n", b"x\n", b"y\n")[1])

    def test_upstream_only_replaced_local_only_kept(self):
        write(self.live("goto") / "main.js", "mine\n")
        self.release(self.work, "goto", {"lib/util.js": UTIL.replace("d", "D")}, "0.2.0")
        code, out = self.run_cli("update", "goto")
        self.assertEqual(code, 0, out)
        self.assertEqual(self.util(), UTIL.replace("d", "D"))
        self.assertEqual((self.live("goto") / "main.js").read_text(), "mine\n")

    def test_both_changed_non_overlapping_merges(self):
        write(self.live("goto") / "lib/util.js", UTIL.replace("a\n", "MINE\n"))
        self.release(self.work, "goto", {"lib/util.js": UTIL.replace("g\n", "THEIRS\n")}, "0.2.0")
        code, out = self.run_cli("update", "goto")
        self.assertEqual(code, 0, out)
        self.assertEqual(self.util(), UTIL.replace("a\n", "MINE\n").replace("g\n", "THEIRS\n"))
        self.assertEqual(self.lock()["goto"]["version"], "0.2.0")
        code, out = self.run_cli("diff", "goto")  # the customization is still a local change vs 0.2.0
        self.assertIn("+MINE", out)
        self.assertNotIn("THEIRS", out.replace(" THEIRS", ""))

    def conflict(self):
        write(self.live("goto") / "lib/util.js", UTIL.replace("d\n", "MINE\n"))
        self.release(self.work, "goto", {"lib/util.js": UTIL.replace("d\n", "THEIRS\n"), "main.js": "v2\n"}, "0.2.0")

    def test_overlap_is_a_conflict_and_nothing_changes(self):
        self.conflict()
        before = (self.installed(), self.lock(), corgi.hashes(self.live("goto")))
        code, out = self.run_cli("update", "goto")
        self.assertEqual(code, 1, out)
        self.assertIn("CONFLICT", out)
        self.assertIn("corgi resolve goto", out)
        self.assertEqual(before, (self.installed(), self.lock(), corgi.hashes(self.live("goto"))))

    def test_keep_mine(self):
        self.conflict()
        code, out = self.run_cli("update", "goto", "--keep-mine", "lib/util.js")
        self.assertEqual(code, 0, out)
        self.assertEqual(self.util(), UTIL.replace("d\n", "MINE\n"))
        self.assertEqual((self.live("goto") / "main.js").read_text(), "v2\n")

    def test_take_theirs_saves_a_backup_patch(self):
        self.conflict()
        code, out = self.run_cli("update", "goto", "--take-theirs", "lib/util.js")
        self.assertEqual(code, 0, out)
        self.assertEqual(self.util(), UTIL.replace("d\n", "THEIRS\n"))
        backups = list((self.state / "backups").glob("goto-*.patch"))
        self.assertEqual(len(backups), 1)
        self.assertIn("+MINE", backups[0].read_text())

    def test_failed_check_after_merge_rolls_back_whole_mod(self):
        write(self.live("goto") / "lib/util.js", UTIL.replace("a\n", "MINE\n"))
        self.release(self.work, "goto", {"lib/util.js": UTIL.replace("g\n", "THEIRS\n"), "main.js": "v2\n"}, "0.2.0")
        os.environ["CORGI_CHECK"] = "false"
        code, out = self.run_cli("update", "goto")
        self.assertEqual(code, 1, out)
        self.assertEqual(self.util(), UTIL.replace("a\n", "MINE\n"))
        self.assertEqual((self.live("goto") / "main.js").read_text(), GOTO["main.js"])

    def test_resolve_stages_opens_a_tab_and_applies(self):
        self.conflict()
        argfile = self.tmp / "herdr-args.json"
        fake = self.tmp / "fake-herdr-app"
        write(fake, f"#!{sys.executable}\nimport json, sys\njson.dump(sys.argv[1:], open({str(argfile)!r}, 'w'))\n")
        fake.chmod(0o755)
        os.environ["CORGI_HERDR_APP"] = str(fake)
        code, out = self.run_cli("resolve", "goto")
        self.assertEqual(code, 0, out)
        stage = self.state / "staging/goto"
        for part in ("base", "local", "new", "result"):
            self.assertTrue((stage / part / "lib/util.js").is_file(), part)
        args = json.loads(argfile.read_text())
        self.assertEqual(args[:2], ["do", "tab.new"])
        self.assertEqual(json.loads(args[args.index("--argv") + 1]), ["claude"])
        task = args[args.index("--task") + 1]
        self.assertIn("re-apply the user's customizations", task)
        self.assertIn(str(stage / "base"), task)
        # the agent's work:
        write(stage / "result/lib/util.js", UTIL.replace("d\n", "THEIRS+MINE\n"))
        self.answers = [True]
        code, out = self.run_cli("resolve", "goto", "--apply")
        self.assertEqual(code, 0, out)
        self.assertIn("+THEIRS+MINE", out)  # the diff was shown
        self.assertEqual(self.util(), UTIL.replace("d\n", "THEIRS+MINE\n"))
        self.assertEqual((self.live("goto") / "main.js").read_text(), "v2\n")
        self.assertEqual(self.lock()["goto"]["version"], "0.2.0")
        self.assertFalse(stage.exists())

    def test_resolve_apply_declined_changes_nothing(self):
        self.conflict()
        self.run_cli("resolve", "goto")
        self.answers = [False]
        before = corgi.hashes(self.live("goto"))
        code, out = self.run_cli("resolve", "goto", "--apply")
        self.assertEqual(code, 1, out)
        self.assertEqual(before, corgi.hashes(self.live("goto")))

    def test_export_patch_is_reapplied_by_sync_on_a_fresh_install(self):
        write(self.live("goto") / "lib/util.js", UTIL.replace("b\n", "MINE\n"))
        code, out = self.run_cli("customizations", "export")
        self.assertEqual(code, 0, out)
        patch = self.app / "customizations/goto.patch"
        self.assertIn("+MINE", patch.read_text())
        # a new Mac: dot-herdr has corgi.lock and customizations/, nothing else
        shutil.rmtree(self.state)
        shutil.rmtree(self.live("goto"))
        code, out = self.run_cli("sync")
        self.assertEqual(code, 0, out)
        self.assertEqual(self.util(), UTIL.replace("b\n", "MINE\n"))
        self.assertEqual((self.live("goto") / "main.js").read_text(), GOTO["main.js"])
        self.assertEqual(self.installed()["goto"]["version"], "0.1.0")


class B4Dev(Base):
    def setUp(self):
        super().setUp()
        self.work, self.bare = self.make_repo("goto", GOTO)
        self.co = self.tmp / "checkouts/herdr-corgi-goto"
        git(self.tmp, "clone", "-q", self.bare, self.co)
        code, out = self.run_cli("dev", "goto", str(self.co))
        self.assertEqual(code, 0, out)

    def test_dev_records_checkout_installs_and_adds_pre_push_hook(self):
        self.assertEqual(self.lock()["goto"]["dev"], str(self.co))
        self.assertEqual(self.installed()["goto"]["source"], "dev")
        self.assertEqual((self.live("goto") / "main.js").read_text(), GOTO["main.js"])
        hook = self.co / ".git/hooks/pre-push"
        self.assertTrue(os.access(hook, os.X_OK))
        write(self.app / "corgi.leaks", "# private terms\nacme-?corp\n")
        write(self.co / "README.md", "made at ACME-Corp\n")
        git(self.co, "add", "-A")
        git(self.co, "commit", "-q", "-m", "docs: readme")
        p = subprocess.run([str(hook)], cwd=self.co, capture_output=True, text=True)
        self.assertEqual(p.returncode, 1, p.stdout + p.stderr)
        self.assertIn("README.md:1", p.stdout)

    def test_status_and_update_skip_dev_mods(self):
        self.release(self.work, "goto", {"main.js": "v2\n"}, "0.2.0")
        code, out = self.run_cli("update", "goto")
        self.assertEqual(code, 0, out)
        self.assertIn("dev checkout", out)
        self.assertEqual((self.live("goto") / "main.js").read_text(), GOTO["main.js"])

    def test_save_refuses_on_a_dirty_checkout(self):
        write(self.co / "README.md", "wip\n")
        write(self.live("goto") / "main.js", "changed live\n")
        code, out = self.run_cli("save", "goto", "feat: new main")
        self.assertEqual(code, 1, out)
        self.assertIn("README.md", out)
        self.assertEqual((self.co / "mods/goto/main.js").read_text(), GOTO["main.js"])

    def test_save_copies_live_to_checkout_excluding_generated_and_private(self):
        write(self.live("goto") / "main.js", "changed live\n")
        write(self.live("goto") / "new.js", "added\n")
        (self.live("goto") / "lib/util.js").unlink()
        write(self.live("goto") / "gpui-kit.d.ts", "generated")
        write(self.live("goto") / "jsconfig.json", "{}")
        write(self.live("goto") / "__pycache__/x.pyc", "bin")
        write(self.live("goto") / "secret.js", "private adapter\n")
        write(self.live("goto") / ".corgi-private", "secret.js\n")
        code, out = self.run_cli("save", "goto", "feat: new main")
        self.assertEqual(code, 0, out)
        self.assertIn("main.js", out)
        files = git(self.co, "ls-files", "mods/goto").split()
        self.assertEqual(sorted(files), ["mods/goto/corgi.json", "mods/goto/main.js", "mods/goto/mod.json",
                                         "mods/goto/new.js"])
        self.assertEqual(git(self.co, "log", "-1", "--format=%s").strip(), "feat: new main")
        self.assertEqual(git(self.co, "status", "--porcelain"), "")
        code, out = self.run_cli("status", "--json")
        self.assertEqual(json.loads(out)["mods"]["goto"]["changed"], [])

    def commits(self, *subjects):
        for i, s in enumerate(subjects):
            write(self.co / f"mods/goto/f{i}.js", s)
            git(self.co, "add", "-A")
            git(self.co, "commit", "-q", "-m", s)

    def test_release_builds_changelog_bumps_minor_and_does_not_push_when_declined(self):
        self.commits("feat(match): fuzzy titles", "fix: crash on empty list", "docs: typo")
        self.answers = [False]
        code, out = self.run_cli("release", "goto", "minor")
        self.assertEqual(code, 0, out)
        log = (self.co / "CHANGELOG.md").read_text()
        self.assertRegex(log, r"## 0\.2\.0")
        new = log.split("## 0.1.0")[0]
        self.assertIn("### Features\n\n- match: fuzzy titles", new)
        self.assertIn("### Fixes\n\n- crash on empty list", new)
        self.assertIn("- docs: typo", new)
        self.assertEqual(json.loads((self.co / "mods/goto/corgi.json").read_text())["version"], "0.2.0")
        self.assertEqual(json.loads((self.live("goto") / "corgi.json").read_text())["version"], "0.2.0")
        self.assertEqual(git(self.co, "log", "-1", "--format=%s").strip(), "chore(release): v0.2.0")
        self.assertIn("v0.2.0", git(self.co, "tag"))
        self.assertNotIn("v0.2.0", git(self.bare, "tag"))
        self.assertEqual(self.lock()["goto"]["version"], "0.2.0")

    def test_release_yes_pushes_tag(self):
        self.commits("fix: one")
        code, out = self.run_cli("release", "goto", "patch", "--yes")
        self.assertEqual(code, 0, out)
        self.assertIn("v0.1.1", git(self.bare, "tag"))

    def test_private_leak_scan_blocks_release(self):
        write(self.app / "corgi.leaks", "acme-?corp\n")
        self.commits("feat: mention ACMECorp here")
        code, out = self.run_cli("release", "goto", "minor", "--yes")
        self.assertEqual(code, 1, out)
        self.assertIn("f0.js", out)
        self.assertNotIn("v0.2.0", git(self.co, "tag"))

    def test_release_refuses_dirty_checkout(self):
        write(self.co / "x.txt", "wip")
        code, out = self.run_cli("release", "goto", "minor", "--yes")
        self.assertEqual(code, 1, out)
        self.assertIn("x.txt", out)

    def test_sync_restores_a_missing_dev_checkout(self):
        shutil.rmtree(self.co)
        shutil.rmtree(self.state)
        shutil.rmtree(self.live("goto"))
        code, out = self.run_cli("sync")
        self.assertEqual(code, 0, out)
        self.assertTrue((self.co / "mods/goto/main.js").is_file())
        self.assertEqual((self.live("goto") / "main.js").read_text(), GOTO["main.js"])
        self.assertEqual(self.installed()["goto"]["source"], "dev")

    def test_doctor(self):
        code, out = self.run_cli("doctor")
        self.assertIn("herdr-app 0.1.14", out)
        self.assertIn("goto", out)


if __name__ == "__main__":
    unittest.main()
