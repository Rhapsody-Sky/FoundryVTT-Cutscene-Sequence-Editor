"""Publish verified assets through a draft; uses only the repository GITHUB_TOKEN."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import sys
import urllib.error
import urllib.request
import zipfile

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "scripts"))
from package_release import REPOSITORY, validate_assets, version_tuple


class SafeRedirect(urllib.request.HTTPRedirectHandler):
    """Asset downloads redirect to storage; never forward the API credential."""

    def redirect_request(self, request, response, code, message, headers, new_url):
        if not new_url.startswith("https://"):
            raise ValueError("GitHub asset download redirected outside HTTPS.")
        redirected = super().redirect_request(request, response, code, message, headers, new_url)
        if redirected is not None:
            redirected.remove_header("Authorization")
        return redirected


class GitHub:
    def __init__(self, token):
        self.token = token
        self.opener = urllib.request.build_opener(SafeRedirect())

    def request(self, method, path, data=None, binary=False, content_type=None):
        if path.startswith("https://uploads.github.com/"):
            url = path
        else:
            url = f"https://api.github.com/repos/{REPOSITORY}{path}"
        headers = {
            "Authorization": f"Bearer {self.token}",
            "Accept": "application/octet-stream" if binary else "application/vnd.github+json",
            "X-GitHub-Api-Version": "2026-03-10",
            "User-Agent": "stagecraft-release-workflow",
        }
        if data is not None:
            if isinstance(data, bytes):
                headers["Content-Type"] = content_type or "application/octet-stream"
            else:
                data = json.dumps(data).encode("utf-8")
                headers["Content-Type"] = "application/json"
        request = urllib.request.Request(url, data=data, headers=headers, method=method)
        with self.opener.open(request, timeout=90) as response:
            payload = response.read()
        return payload if binary else json.loads(payload)

    def releases(self):
        page = 1
        while True:
            batch = self.request("GET", f"/releases?per_page=100&page={page}")
            yield from batch
            if len(batch) < 100:
                return
            page += 1


def require_newer(tag, releases):
    candidate = version_tuple(tag)
    for release in releases:
        if release.get("draft"):
            continue
        if release.get("tag_name") == tag:
            raise ValueError("This tag already has a published release; it will not be overwritten.")
        if release.get("prerelease"):
            continue
        try:
            previous = version_tuple(release.get("tag_name", ""))
        except ValueError:
            continue
        if previous >= candidate:
            raise ValueError("Release must be newer than every published stable version; latest cannot regress.")


def verify_draft(release, tag):
    # GitHub ignores target_commitish when the tag already exists. verify_tag
    # checks the actual (possibly annotated) tag instead of this metadata field.
    if (not release.get("draft") or release.get("prerelease")
            or release.get("tag_name") != tag):
        raise ValueError("Existing draft does not match this stable tag and draft state; inspect it manually.")


def verify_tag(api, tag, commit):
    reference = api.request("GET", f"/git/ref/tags/{tag}")["object"]
    for _ in range(8):
        if reference["type"] == "commit":
            if reference["sha"] != commit:
                raise ValueError("Release tag moved away from the validated commit.")
            return
        if reference["type"] != "tag":
            break
        reference = api.request("GET", f"/git/tags/{reference['sha']}")["object"]
    raise ValueError("Release tag does not resolve to the validated commit.")


def verify_asset(api, asset, expected):
    if asset.get("state") != "uploaded" or asset.get("size") != len(expected):
        raise ValueError(f"Uploaded asset is incomplete: {asset.get('name')}.")
    actual = api.request("GET", f"/releases/assets/{asset['id']}", binary=True)
    if hashlib.sha256(actual).digest() != hashlib.sha256(expected).digest():
        raise ValueError(f"Uploaded bytes differ: {asset.get('name')}.")


def verify_release_assets(api, release_id, payloads):
    uploaded = api.request("GET", f"/releases/{release_id}/assets?per_page=100")
    if len(uploaded) != len(payloads) or {asset["name"] for asset in uploaded} != set(payloads):
        raise ValueError("Release must contain exactly the two verified release assets.")
    for asset in uploaded:
        verify_asset(api, asset, payloads[asset["name"]])


def publish(api, assets, tag, repository, commit):
    if repository != REPOSITORY or not re.fullmatch(r"[0-9a-f]{40}", commit):
        raise ValueError("Expected the Stagecraft repository and a full validated commit SHA.")
    validate_assets(assets, tag, repository)
    payloads = {name: (Path(assets) / name).read_bytes() for name in ("module.json", "stagecraft.zip")}
    releases = list(api.releases())
    matches = [release for release in releases if release.get("tag_name") == tag]
    if len(matches) > 1:
        raise ValueError("Multiple releases exist for this tag; inspect them manually.")
    require_newer(tag, (release for release in releases if release.get("tag_name") != tag))
    verify_tag(api, tag, commit)
    if matches:
        release = matches[0]
        if not release.get("draft"):
            if release.get("prerelease"):
                raise ValueError("This tag already has a published prerelease; it will not be modified.")
            # A prior PATCH may have succeeded even if its response was lost.
            # An exact stable release is an idempotent success through GETs only.
            verify_release_assets(api, release["id"], payloads)
            if api.request("GET", "/releases/latest")["id"] != release["id"]:
                raise ValueError("Existing published release is not latest; it will not be modified.")
            return release
        verify_draft(release, tag)
    else:
        release = api.request("POST", "/releases", {
            "tag_name": tag,
            "target_commitish": commit,
            "name": f"Stagecraft {tag[1:]}",
            "body": (
                "Build animated titles, visual effects and player-paced sequences in Foundry VTT 14.\n\n"
                "- Multitrack editor with 33 title animations and 22 animated background patterns.\n"
                "- Images, video, audio and interactive buttons with per-player choices.\n"
                "- Targeted playback and combat triggers.\n\n"
                "Paste this URL into Foundry's **Install Module → Manifest URL**:\n\n"
                f"```text\nhttps://github.com/{REPOSITORY}/releases/latest/download/module.json\n```\n\n"
                f"[Getting started](https://github.com/{REPOSITORY}/blob/main/docs/getting-started.md)"
            ),
            "draft": True,
            "prerelease": False,
            "make_latest": "false",
        })
        verify_draft(release, tag)
    release_id = release["id"]
    uploaded = api.request("GET", f"/releases/{release_id}/assets?per_page=100")
    if len({asset["name"] for asset in uploaded}) != len(uploaded) or any(asset["name"] not in payloads for asset in uploaded):
        raise ValueError("Draft contains unexpected or duplicate assets; inspect it manually.")
    existing = {asset["name"]: asset for asset in uploaded}
    for name, expected in payloads.items():
        if name in existing:
            verify_asset(api, existing[name], expected)
        else:
            asset = api.request(
                "POST", f"https://uploads.github.com/repos/{REPOSITORY}/releases/{release_id}/assets?name={name}",
                expected, content_type="application/json" if name.endswith(".json") else "application/zip",
            )
            verify_asset(api, asset, expected)
    # Re-read the draft and both uploaded assets before making anything public.
    verify_draft(api.request("GET", f"/releases/{release_id}"), tag)
    verify_release_assets(api, release_id, payloads)
    require_newer(tag, api.releases())
    verify_tag(api, tag, commit)
    published = api.request("PATCH", f"/releases/{release_id}", {"draft": False, "make_latest": "true"})
    if published.get("draft") or published.get("tag_name") != tag:
        raise ValueError("GitHub did not confirm publication of the expected release.")
    if api.request("GET", "/releases/latest")["id"] != release_id:
        raise ValueError("Published release is not GitHub's latest release; inspect release metadata.")
    return published


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--assets", required=True, type=Path)
    parser.add_argument("--tag", required=True)
    parser.add_argument("--repository", required=True)
    parser.add_argument("--commit", required=True)
    args = parser.parse_args()
    token = os.environ.get("GITHUB_TOKEN")
    if not token:
        parser.exit(1, "GITHUB_TOKEN is required.\n")
    try:
        release = publish(GitHub(token), args.assets, args.tag, args.repository, args.commit)
    except (ValueError, OSError, KeyError, zipfile.BadZipFile) as error:
        parser.exit(1, f"Release verification/publication stopped (the release may already be public): {error}\n")
    print(f"Verified published release: {release['html_url']}")


if __name__ == "__main__":
    main()
