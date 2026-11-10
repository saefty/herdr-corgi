"""Tests for check.py and release_check.py: python3 ci/test_ci.py"""
import json
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import check  # noqa: E402
import release_check  # noqa: E402

# ponytail: built by concatenation so the leak scan of this repo doesn't flag its own fixtures
HOME_PATH = "/Us" + "ers/alice/x"
MAIL = "bob" + "@example.com"


class LeakScan(unittest.TestCase):
    def test_flags_home_path_and_mail(self):
        self.assertTrue(check.leaks("see " + HOME_PATH))
        self.assertTrue(check.leaks("/ho" + "me/carol/.ssh"))
        self.assertTrue(check.leaks("mail " + MAIL))

    def test_passes_noreply(self):
        self.assertEqual(check.leaks("25341735+saefty@users.noreply.github.com"), [])
        self.assertEqual(check.leaks("no" + "reply" + "@" + "github.com"), [])

    def test_ssh_remote_is_not_a_mail(self):
        self.assertEqual(check.leaks('url = "git' + '@github.com:octo/x.git"'), [])
        self.assertTrue(check.leaks("git" + "@github.com wrote"))

    def test_flags_keys_and_tokens(self):
        self.assertTrue(check.leaks("-----BEGIN RSA PRIV" + "ATE KEY-----"))
        self.assertTrue(check.leaks("gh" + "p_" + "a" * 30))
        self.assertTrue(check.leaks("s" + "k-" + "b" * 30))

    def test_patterns_do_not_flag_themselves(self):
        with open(check.__file__, encoding="utf-8") as f:
            self.assertEqual(check.leaks(f.read()), [])

    def test_generated_files(self):
        self.assertEqual(check.generated(["mods/a/main.js", "mods/a/gpui-kit.d.ts", "mods/a/jsconfig.json"]),
                         ["mods/a/gpui-kit.d.ts", "mods/a/jsconfig.json"])


class ReleaseCheck(unittest.TestCase):
    def repo(self, version="0.1.0", changelog="# Changelog\n\n## 0.1.0 — initial release\n\n- first\n"):
        root = tempfile.mkdtemp()
        os.makedirs(os.path.join(root, "mods", "demo"))
        with open(os.path.join(root, "mods", "demo", "corgi.json"), "w") as f:
            json.dump({"name": "demo", "version": version}, f)
        if changelog is not None:
            with open(os.path.join(root, "CHANGELOG.md"), "w") as f:
                f.write(changelog)
        return root

    def test_passes_and_returns_notes(self):
        notes = release_check.notes("v0.1.0", self.repo())
        self.assertIn("- first", notes)

    def test_section_ends_at_next_heading(self):
        log = "## 0.2.0\n\n- new\n\n## 0.1.0\n\n- old\n"
        notes = release_check.notes("v0.2.0", self.repo("0.2.0", log))
        self.assertIn("- new", notes)
        self.assertNotIn("- old", notes)

    def test_fails_on_version_mismatch(self):
        with self.assertRaises(SystemExit):
            release_check.notes("v0.2.0", self.repo())

    def test_fails_on_missing_section(self):
        with self.assertRaises(SystemExit):
            release_check.notes("v0.1.0", self.repo(changelog="# Changelog\n\n## 0.0.9\n"))
        with self.assertRaises(SystemExit):
            release_check.notes("v0.1.0", self.repo(changelog=None))

    def test_fails_on_bad_tag(self):
        with self.assertRaises(SystemExit):
            release_check.notes("0.1.0", self.repo())


if __name__ == "__main__":
    unittest.main()
