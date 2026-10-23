"""Offline release contract tests; run separately from the Node contributor checks."""

import copy
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
import urllib.request
import zipfile

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))
sys.path.insert(0, str(ROOT / ".github" / "scripts"))
import package_release as package
import publish_release as publisher

TAG = "v0.19.6"
COMMIT = "a" * 40


class Fixture(unittest.TestCase):
    def setUp(self):
        temporary_root = ROOT / ".test-build"
        temporary_root.mkdir(exist_ok=True)
        self.temporary = tempfile.TemporaryDirectory(prefix="release-", dir=temporary_root)
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.built = self.root / "dist" / "stagecraft"
        self.output = self.root / "release-assets"
        self.manifest = {
            "id": "stagecraft", "version": TAG[1:],
            "url": package.REPOSITORY_URL,
            "manifest": f"{package.REPOSITORY_URL}/releases/latest/download/module.json",
            "download": f"{package.REPOSITORY_URL}/releases/download/{TAG}/stagecraft.zip",
            "esmodules": ["scripts/module.js"],
            "styles": ["styles/module.css", "styles/editor.css"],
            "languages": [{"path": "lang/de.json"}, {"path": "lang/en.json"}],
        }
        for name in package.RUNTIME_FILES:
            self.write(f"dist/stagecraft/{name}", f"runtime {name}\n".encode())
        self.write_manifest()
        identity = {"name": "stagecraft", "version": TAG[1:]}
        self.write("package.json", json.dumps(identity).encode())
        self.write("package-lock.json", json.dumps({**identity, "packages": {"": identity}}).encode())
        self.write("publication/README.md", b"# Stagecraft\nEnglish installation guide.\n")
        self.write("README.md", b"Private working documentation; never select implicitly.\n")
        self.write("LICENSE", b"MIT License\n")

    def write(self, relative, data):
        target = self.root / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)

    def write_manifest(self):
        data = (json.dumps(self.manifest, indent=2) + "\n").encode()
        self.write("module.json", data)
        self.write("dist/stagecraft/module.json", data)

    def build(self, **overrides):
        args = dict(root=self.root, readme="publication/README.md", tag=TAG,
                    repository=package.REPOSITORY, output=self.output)
        args.update(overrides)
        return package.package_release(**args)


class PackageTests(Fixture):
    def test_installable_allowlist_identical_manifests_and_explicit_english_guide(self):
        self.build()
        with zipfile.ZipFile(self.output / "stagecraft.zip") as archive:
            self.assertEqual(set(archive.namelist()), package.ARCHIVE_FILES)
            self.assertEqual(len(archive.namelist()), 15)
            self.assertEqual(archive.read("module.json"), (self.output / "module.json").read_bytes())
            self.assertEqual(archive.read("README.md"), (self.root / "publication/README.md").read_bytes())
            self.assertTrue(all(entry.date_time == (1980, 1, 1, 0, 0, 0) for entry in archive.infolist()))

    def test_deterministic_across_input_timestamps(self):
        self.build()
        import os
        for path in self.built.rglob("*"):
            if path.is_file():
                os.utime(path, (1_700_000_000, 1_700_000_000))
        second = self.root / "second"
        self.build(output=second)
        self.assertEqual((self.output / "stagecraft.zip").read_bytes(), (second / "stagecraft.zip").read_bytes())

    def test_working_docs_tests_media_sources_and_maps_are_excluded_even_in_dist(self):
        for name in ("docs/internal.md", "tests/test.ts", "scripts/module.js.map", "src/main.ts",
                     "private/secret.txt", "testworld/world.json", "qa/screenshot.png", "movie.webm"):
            self.write(f"dist/stagecraft/{name}", b"private build residue")
        self.build()
        with zipfile.ZipFile(self.output / "stagecraft.zip") as archive:
            self.assertEqual(set(archive.namelist()), package.ARCHIVE_FILES)

    def test_stable_tags_only(self):
        for tag in ("v0.19.6-beta", "v0.19.6+build", "v00.19.6", "0.19.6", "v0.19.6/extra"):
            with self.subTest(tag=tag), self.assertRaises(ValueError):
                self.build(tag=tag)

    def test_mismatched_tag_rejected_without_writing(self):
        with self.assertRaisesRegex(ValueError, "version must match"):
            self.build(tag="v0.19.7")
        self.assertFalse(self.output.exists())

    def test_wrong_repository_rejected(self):
        with self.assertRaisesRegex(ValueError, "repository"):
            self.build(repository="other/repository")

    def test_wrong_urls_rejected(self):
        for key, value in (("url", "https://example.com"), ("manifest", f"{package.REPOSITORY_URL}/raw/main/module.json"),
                           ("download", f"{package.REPOSITORY_URL}/releases/latest/download/stagecraft.zip")):
            with self.subTest(key=key):
                old = self.manifest[key]
                self.manifest[key] = value
                self.write_manifest()
                with self.assertRaisesRegex(ValueError, f"Manifest {key}"):
                    self.build()
                self.manifest[key] = old

    def test_missing_runtime_assets_rejected(self):
        (self.built / "assets/button-textures/grain.svg").unlink()
        with self.assertRaisesRegex(ValueError, "missing"):
            self.build()

    def test_unsafe_manifest_paths_rejected(self):
        for relative in ("../private.js", "/private.js", "C:/private.js", "scripts\\private.js", ""):
            with self.subTest(relative=relative):
                self.manifest["esmodules"] = [relative]
                self.write_manifest()
                with self.assertRaisesRegex(ValueError, "Unsafe"):
                    self.build()

    def test_unlisted_runtime_dependencies_rejected(self):
        self.manifest["esmodules"].append("scripts/additional.js")
        self.write_manifest()
        with self.assertRaisesRegex(ValueError, "allowlist"):
            self.build()

    def test_stale_build_rejected(self):
        self.write("module.json", b"stale source")
        with self.assertRaisesRegex(ValueError, "rebuild"):
            self.build()

    def test_stale_lock_root_rejected(self):
        self.write("package-lock.json", json.dumps({"name": "stagecraft", "version": TAG[1:],
                                                   "packages": {"": {"name": "stagecraft", "version": "0.19.5"}}}).encode())
        with self.assertRaisesRegex(ValueError, "Lockfile"):
            self.build()

    def test_existing_assets_preserved(self):
        self.build()
        previous = (self.output / "stagecraft.zip").read_bytes()
        with self.assertRaisesRegex(ValueError, "already exist"):
            self.build()
        self.assertEqual((self.output / "stagecraft.zip").read_bytes(), previous)

    def test_readme_selection_required_and_restricted(self):
        with self.assertRaisesRegex(ValueError, "English README"):
            self.build(readme="docs/internal.md")

    def test_linked_runtime_files_rejected(self):
        target = self.built / "scripts/module.js"
        target.unlink()
        try:
            target.symlink_to(self.root / "LICENSE")
        except OSError:
            self.skipTest("Creating symlinks requires Windows developer mode or privileges.")
        with self.assertRaisesRegex(ValueError, "Symbolic"):
            self.build()

    def test_mismatched_standalone_manifest_rejected(self):
        self.build()
        self.manifest["title"] = "Changed after packaging"
        (self.output / "module.json").write_text(json.dumps(self.manifest), encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "manifests differ"):
            package.validate_assets(self.output, TAG, package.REPOSITORY)

    def test_added_zip_working_document_rejected(self):
        self.build()
        with zipfile.ZipFile(self.output / "stagecraft.zip", "a") as archive:
            archive.writestr("docs/INTERNAL.md", "working document")
        with self.assertRaisesRegex(ValueError, "allowlist"):
            package.validate_assets(self.output, TAG, package.REPOSITORY)


class FakeGitHub:
    """In-memory GitHub API model: no network requests and no release writes."""
    def __init__(self):
        self.items = []
        self.assets = []
        self.contents = {}
        self.calls = []
        self.tag_commit = COMMIT
        self.lose_publish_response = False
        self.fail_latest_once = False
        self.latest_id = None

    def releases(self):
        return iter(copy.deepcopy(self.items))

    def request(self, method, path, data=None, binary=False, content_type=None):
        self.calls.append((method, path, copy.deepcopy(data)))
        if path.startswith("/git/ref/"):
            return {"object": {"type": "commit", "sha": self.tag_commit}}
        if method == "POST" and path == "/releases":
            self.items.append({**data, "id": 1, "html_url": "https://example.com/release"})
            return copy.deepcopy(self.items[-1])
        if method == "GET" and path.startswith("/releases/assets/"):
            return self.contents[int(path.rsplit("/", 1)[1])]
        if method == "POST" and path.startswith("https://uploads.github.com/"):
            name = path.rsplit("=", 1)[1]
            asset = {"id": len(self.assets) + 1, "name": name, "state": "uploaded", "size": len(data)}
            self.assets.append(asset)
            self.contents[asset["id"]] = data
            return copy.deepcopy(asset)
        if method == "GET" and "/assets?" in path:
            return copy.deepcopy(self.assets)
        if method == "GET" and path in ("/releases/1", "/releases/latest"):
            if path == "/releases/latest":
                if self.fail_latest_once:
                    self.fail_latest_once = False
                    raise OSError("Latest-release response unavailable")
                if self.latest_id is not None:
                    return {"id": self.latest_id}
            return copy.deepcopy(self.items[-1])
        if method == "PATCH" and path == "/releases/1":
            self.items[-1].update(data)
            if self.lose_publish_response:
                self.lose_publish_response = False
                raise OSError("Publication response was lost")
            return copy.deepcopy(self.items[-1])
        raise AssertionError(f"Unexpected fake API call: {method} {path}")


class PublicationTests(Fixture):
    def setUp(self):
        super().setUp()
        self.build()
        self.api = FakeGitHub()

    def publish(self):
        return publisher.publish(self.api, self.output, TAG, package.REPOSITORY, COMMIT)

    def test_publish_only_after_both_uploaded_assets_have_been_downloaded_and_verified(self):
        result = self.publish()
        self.assertFalse(result["draft"])
        self.assertEqual(result["make_latest"], "true")
        calls = self.api.calls
        patch = next(i for i, call in enumerate(calls) if call[0] == "PATCH")
        self.assertTrue(calls[1][2]["draft"])
        downloads = [call[1] for call in calls[:patch] if call[1].startswith("/releases/assets/")]
        self.assertEqual(downloads.count("/releases/assets/1"), 2)
        self.assertEqual(downloads.count("/releases/assets/2"), 2)
        self.assertEqual(sum(call[0] == "PATCH" for call in calls), 1)

    def test_existing_published_release_never_overwritten(self):
        self.api.items = [{"id": 1, "tag_name": TAG, "draft": False, "prerelease": False}]
        with self.assertRaisesRegex(ValueError, "exactly the two"):
            self.publish()
        self.assertTrue(all(call[0] == "GET" for call in self.api.calls))

    def test_older_tag_cannot_regress_latest(self):
        self.api.items = [{"tag_name": "v0.20.0", "draft": False, "prerelease": False}]
        with self.assertRaisesRegex(ValueError, "newer"):
            self.publish()
        self.assertEqual(self.api.calls, [])

    def test_latest_uses_numeric_versions_and_ignores_drafts_and_prereleases(self):
        publisher.require_newer("v0.10.0", [{"tag_name": "v0.9.0", "draft": False},
                                           {"tag_name": "v9.0.0", "draft": True},
                                           {"tag_name": "v9.0.0", "draft": False, "prerelease": True}])

    def test_retry_matching_draft_does_not_replace_assets(self):
        self.publish()
        self.api.items[-1]["draft"] = True
        before = len(self.api.assets)
        self.api.calls.clear()
        self.publish()
        self.assertEqual(len(self.api.assets), before)
        self.assertFalse(any(call[0] == "POST" for call in self.api.calls))

    def test_existing_tag_draft_accepts_ignored_target_commitish_metadata(self):
        self.api.items = [{"id": 1, "tag_name": TAG, "draft": True, "prerelease": False,
                           "target_commitish": "main", "html_url": "https://example.com/release"}]
        self.assertFalse(self.publish()["draft"])
        self.assertFalse(any(call[0] == "POST" and call[1] == "/releases" for call in self.api.calls))

    def test_wrong_tag_or_state_is_not_an_acceptable_draft(self):
        for draft in ({"tag_name": "v0.19.7", "draft": True},
                      {"tag_name": TAG, "draft": False},
                      {"tag_name": TAG, "draft": True, "prerelease": True}):
            with self.subTest(draft=draft), self.assertRaisesRegex(ValueError, "Existing draft"):
                publisher.verify_draft(draft, TAG)

    def test_existing_draft_for_moved_tag_is_preserved(self):
        self.api.items = [{"id": 1, "tag_name": TAG, "draft": True, "target_commitish": COMMIT}]
        self.api.tag_commit = "b" * 40
        with self.assertRaisesRegex(ValueError, "tag moved"):
            self.publish()
        self.assertTrue(all(call[0] == "GET" for call in self.api.calls))

    def test_retry_after_lost_publish_response_is_read_only_success(self):
        self.api.lose_publish_response = True
        with self.assertRaisesRegex(OSError, "response was lost"):
            self.publish()
        self.assertFalse(self.api.items[0]["draft"])
        self.api.calls.clear()
        self.assertFalse(self.publish()["draft"])
        self.assertTrue(all(call[0] == "GET" for call in self.api.calls))
        self.assertIn(("GET", "/releases/assets/1", None), self.api.calls)
        self.assertIn(("GET", "/releases/assets/2", None), self.api.calls)
        self.assertIn(("GET", "/releases/latest", None), self.api.calls)

    def test_retry_after_latest_check_failure_is_read_only_success(self):
        self.api.fail_latest_once = True
        with self.assertRaisesRegex(OSError, "response unavailable"):
            self.publish()
        self.api.calls.clear()
        self.assertFalse(self.publish()["draft"])
        self.assertTrue(all(call[0] == "GET" for call in self.api.calls))

    def test_published_retry_rejects_wrong_asset_bytes_without_mutation(self):
        self.publish()
        self.api.contents[1] = b"different bytes"
        self.api.calls.clear()
        with self.assertRaisesRegex(ValueError, "bytes differ"):
            self.publish()
        self.assertTrue(all(call[0] == "GET" for call in self.api.calls))

    def test_published_retry_rejects_extra_asset_without_mutation(self):
        self.publish()
        self.api.assets.append({"id": 3, "name": "extra.txt", "size": 1, "state": "uploaded"})
        self.api.calls.clear()
        with self.assertRaisesRegex(ValueError, "exactly the two"):
            self.publish()
        self.assertTrue(all(call[0] == "GET" for call in self.api.calls))

    def test_published_retry_rejects_moved_tag_without_mutation(self):
        self.publish()
        self.api.tag_commit = "b" * 40
        self.api.calls.clear()
        with self.assertRaisesRegex(ValueError, "tag moved"):
            self.publish()
        self.assertTrue(all(call[0] == "GET" for call in self.api.calls))

    def test_published_retry_requires_latest_id_without_mutation(self):
        self.publish()
        self.api.latest_id = 2
        self.api.calls.clear()
        with self.assertRaisesRegex(ValueError, "not latest"):
            self.publish()
        self.assertTrue(all(call[0] == "GET" for call in self.api.calls))

    def test_published_retry_rejects_newer_stable_release_without_mutation(self):
        self.publish()
        self.api.items.append({"id": 2, "tag_name": "v0.20.0", "draft": False, "prerelease": False})
        self.api.calls.clear()
        with self.assertRaisesRegex(ValueError, "newer"):
            self.publish()
        self.assertEqual(self.api.calls, [])

    def test_published_prerelease_is_not_accepted_as_retry_success(self):
        self.api.items = [{"id": 1, "tag_name": TAG, "draft": False, "prerelease": True}]
        with self.assertRaisesRegex(ValueError, "published prerelease"):
            self.publish()
        self.assertTrue(all(call[0] == "GET" for call in self.api.calls))

    def test_moved_tag_prevents_any_draft_creation(self):
        self.api.tag_commit = "b" * 40
        with self.assertRaisesRegex(ValueError, "tag moved"):
            self.publish()
        self.assertFalse(any(call[0] == "POST" for call in self.api.calls))

    def test_incomplete_existing_asset_preserves_draft_without_publishing(self):
        self.api.items = [{"id": 1, "tag_name": TAG, "draft": True, "prerelease": False, "target_commitish": COMMIT}]
        self.api.assets = [{"id": 1, "name": "module.json", "state": "starter", "size": 0}]
        with self.assertRaisesRegex(ValueError, "incomplete"):
            self.publish()
        self.assertFalse(any(call[0] in ("PATCH", "DELETE") for call in self.api.calls))

    def test_existing_asset_with_different_bytes_is_not_replaced(self):
        self.publish()
        self.api.items[-1]["draft"] = True
        self.api.contents[1] = b"different bytes"
        self.api.calls.clear()
        with self.assertRaisesRegex(ValueError, "bytes differ"):
            self.publish()
        self.assertFalse(any(call[0] in ("POST", "PATCH", "DELETE") for call in self.api.calls))

    def test_asset_redirect_removes_credential_and_requires_https(self):
        redirect = publisher.SafeRedirect()
        request = urllib.request.Request("https://api.github.com/asset", headers={"Authorization": "Bearer secret"})
        result = redirect.redirect_request(request, None, 302, "Found", {}, "https://storage.example.com/file")
        self.assertIsNone(result.get_header("Authorization"))
        with self.assertRaisesRegex(ValueError, "HTTPS"):
            redirect.redirect_request(request, None, 302, "Found", {}, "http://storage.example.com/file")


if __name__ == "__main__":
    unittest.main()
