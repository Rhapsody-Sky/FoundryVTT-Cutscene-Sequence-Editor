"""Build the public Foundry release using Python's standard library only."""

import argparse
import io
import json
from pathlib import Path, PurePosixPath
import re
import zipfile

REPOSITORY = "Rhapsody-Sky/FoundryVTT-Stagecraft"
REPOSITORY_URL = f"https://github.com/{REPOSITORY}"
STABLE_TAG = re.compile(r"v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)", re.ASCII)
RUNTIME_FILES = (
    "module.json",
    "scripts/module.js",
    "styles/module.css",
    "styles/editor.css",
    "styles/editor-elements.css",
    "lang/de.json",
    "lang/en.json",
    "templates/editor.hbs",
    "templates/status.hbs",
    "assets/button-textures/grain.svg",
    "assets/button-textures/diagonal.svg",
    "assets/button-textures/honeycomb.svg",
    "assets/button-textures/facets.svg",
)
ARCHIVE_FILES = frozenset((*RUNTIME_FILES, "README.md", "LICENSE"))


def version_tuple(tag):
    match = STABLE_TAG.fullmatch(tag)
    if not match:
        raise ValueError("Release tag must be stable vMAJOR.MINOR.PATCH without leading zeroes.")
    return tuple(map(int, match.groups()))


def validate_manifest(data, tag, repository):
    version_tuple(tag)
    if repository != REPOSITORY:
        raise ValueError(f"Release repository must be {REPOSITORY}.")
    manifest = json.loads(data)
    if not isinstance(manifest, dict):
        raise ValueError("Manifest must be a JSON object.")
    if manifest.get("id") != "stagecraft" or manifest.get("version") != tag[1:]:
        raise ValueError("Release tag and Stagecraft manifest version must match.")
    expected_urls = {
        "url": REPOSITORY_URL,
        "manifest": f"{REPOSITORY_URL}/releases/latest/download/module.json",
        "download": f"{REPOSITORY_URL}/releases/download/{tag}/stagecraft.zip",
    }
    for key, expected in expected_urls.items():
        if manifest.get(key) != expected:
            raise ValueError(f"Manifest {key} must be {expected}.")
    languages = manifest.get("languages")
    if not isinstance(languages, list) or not all(isinstance(item, dict) for item in languages):
        raise ValueError("Manifest languages must list language objects.")
    references = {
        "esmodules": manifest.get("esmodules"),
        "styles": manifest.get("styles"),
        "languages": [item.get("path") for item in languages],
    }
    expected = {
        "esmodules": ["scripts/module.js"],
        "styles": ["styles/module.css", "styles/editor.css"],
        "languages": ["lang/de.json", "lang/en.json"],
    }
    for key, paths in references.items():
        if not isinstance(paths, list):
            raise ValueError(f"Manifest {key} must list supported runtime files.")
        for relative in paths:
            if (not isinstance(relative, str) or not relative or "\\" in relative
                    or PurePosixPath(relative).is_absolute() or ":" in relative
                    or ".." in PurePosixPath(relative).parts):
                raise ValueError(f"Unsafe runtime reference: {relative!r}.")
        if sorted(paths) != sorted(expected[key]):
            raise ValueError(f"Manifest {key} differs from the runtime allowlist.")
    if manifest.get("packs") or manifest.get("scripts"):
        raise ValueError("Additional manifest packs/scripts require an explicit release allowlist update.")
    return manifest


def read_regular_file(root, relative):
    root = Path(root).resolve()
    candidate = root / relative
    try:
        candidate.resolve().relative_to(root)
    except ValueError as error:
        raise ValueError(f"Release input escapes its root: {relative}.") from error
    current = candidate
    while current != root:
        if current.is_symlink() or (hasattr(current, "is_junction") and current.is_junction()):
            raise ValueError(f"Symbolic links are not release inputs: {relative}.")
        current = current.parent
    if not candidate.is_file():
        raise ValueError(f"Required release input is missing: {relative}.")
    data = candidate.read_bytes()
    if not data:
        raise ValueError(f"Required release input is empty: {relative}.")
    return data


def release_inputs(root, readme, tag, repository):
    root = Path(root).resolve()
    files = {name: read_regular_file(root, f"dist/stagecraft/{name}") for name in RUNTIME_FILES}
    manifest = validate_manifest(files["module.json"], tag, repository)
    if read_regular_file(root, "module.json") != files["module.json"]:
        raise ValueError("Built manifest differs from the source manifest; rebuild first.")
    for name in ("package.json", "package-lock.json"):
        package = json.loads(read_regular_file(root, name))
        if package.get("name") != manifest["id"] or package.get("version") != manifest["version"]:
            raise ValueError(f"{name} identity/version differs from the release manifest.")
        if name == "package-lock.json":
            locked = package.get("packages", {}).get("")
            if not locked or locked.get("name") != manifest["id"] or locked.get("version") != manifest["version"]:
                raise ValueError("Lockfile root package identity/version differs from the release manifest.")
    readme_path = Path(readme)
    if readme_path.as_posix() not in ("README.md", "publication/README.md"):
        raise ValueError("Select the English README explicitly: README.md or publication/README.md.")
    files["README.md"] = read_regular_file(root, readme_path)
    files["LICENSE"] = read_regular_file(root, "LICENSE")
    return files


def archive_bytes(files):
    stream = io.BytesIO()
    with zipfile.ZipFile(stream, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for name in sorted(files):
            info = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
            info.create_system = 3
            info.external_attr = 0o100644 << 16
            info.compress_type = zipfile.ZIP_DEFLATED
            archive.writestr(info, files[name], compresslevel=9)
    return stream.getvalue()


def validate_assets(assets, tag, repository):
    manifest_data = read_regular_file(assets, "module.json")
    validate_manifest(manifest_data, tag, repository)
    with zipfile.ZipFile(io.BytesIO(read_regular_file(assets, "stagecraft.zip"))) as archive:
        if len(archive.namelist()) != len(ARCHIVE_FILES) or set(archive.namelist()) != ARCHIVE_FILES:
            raise ValueError("Release ZIP differs from the explicit production allowlist.")
        if archive.read("module.json") != manifest_data:
            raise ValueError("Standalone and archived manifests differ.")
        for entry in archive.infolist():
            if not archive.read(entry) or (entry.external_attr >> 16) & 0o170000 != 0o100000:
                raise ValueError(f"ZIP entry is empty or not a regular file: {entry.filename}.")
    return manifest_data


def package_release(root, readme, tag, repository, output):
    files = release_inputs(root, readme, tag, repository)
    payloads = {"module.json": files["module.json"], "stagecraft.zip": archive_bytes(files)}
    output = Path(output)
    output.mkdir(parents=True, exist_ok=True)
    if any((output / name).exists() for name in payloads):
        raise ValueError("Release assets already exist; choose a new empty output directory.")
    for name, data in payloads.items():
        with (output / name).open("xb") as destination:
            destination.write(data)
    validate_assets(output, tag, repository)
    return output


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--readme", required=True, help="Explicit English README source path relative to root")
    parser.add_argument("--tag", required=True)
    parser.add_argument("--repository", required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    try:
        destination = package_release(args.root, args.readme, args.tag, args.repository, args.output)
    except (ValueError, OSError, zipfile.BadZipFile) as error:
        parser.exit(1, f"Release packaging failed: {error}\n")
    print(f"Verified release assets: {destination.resolve()}")


if __name__ == "__main__":
    main()
