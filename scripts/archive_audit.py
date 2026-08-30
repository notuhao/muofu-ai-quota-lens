#!/usr/bin/env python3
"""Audit deterministic, public-only Firefox release archives and checksums."""
from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import os
import pathlib
import re
import stat
import sys
import zipfile


ARTIFACT_PREFIX = "muofu-ai-quota-lens-firefox"
DEFAULT_SOURCE_DATE_EPOCH = 315532800  # 1980-01-01T00:00:00Z, ZIP's lower bound.
MIN_ZIP_EPOCH = 315532800
MAX_ZIP_EPOCH = 4354819198

XPI_ALLOWED_TOP_LEVEL = {
    "manifest.json",
    "_locales",
    "src",
    "popup",
    "dashboard",
    "icons",
    "LICENSE",
    "PRIVACY.md",
    "SECURITY.md",
    "THIRD_PARTY_NOTICES.md",
    "REFERENCE_BASELINES.md",
}
SOURCE_ALLOWED_TOP_LEVEL = XPI_ALLOWED_TOP_LEVEL | {
    ".github",
    "tests",
    "scripts",
    "package.json",
    "package-lock.json",
    "README.md",
    "INSTALL.md",
    "CHANGELOG.md",
}
FORBIDDEN_PARTS = {
    ".git",
    ".tmp",
    "__pycache__",
    "node_modules",
    "release",
    "web-ext-artifacts",
    "coverage",
}
FORBIDDEN_BASENAMES = {
    ".env",
    "amo_submission.md",
    "amo_reviewer_notes.md",
    "review.md",
}
FORBIDDEN_SUFFIXES = {".key", ".pem", ".p12", ".pfx"}
FORBIDDEN_GENERATED_SUFFIXES = {".pyc", ".pyo"}
FORBIDDEN_NAME_FRAGMENT = re.compile(
    r"(?:amo[_-]?(?:review|submission|listing|delivery)|reviewer|"
    r"submission[_-]?(?:id|receipt)|delivery[_-]?record|validator[_-]?output|"
    r"saved[_-]?session)",
    re.IGNORECASE,
)


def expected_zip_datetime() -> tuple[int, int, int, int, int, int]:
    raw_epoch = os.environ.get("SOURCE_DATE_EPOCH", str(DEFAULT_SOURCE_DATE_EPOCH))
    if not raw_epoch.isdecimal():
        raise AssertionError("SOURCE_DATE_EPOCH must be a decimal integer")
    epoch = int(raw_epoch)
    if epoch < MIN_ZIP_EPOCH or epoch > MAX_ZIP_EPOCH:
        raise AssertionError(
            f"SOURCE_DATE_EPOCH must be between {MIN_ZIP_EPOCH} and {MAX_ZIP_EPOCH}"
        )
    instant = dt.datetime.fromtimestamp(epoch, tz=dt.timezone.utc)
    return (
        instant.year,
        instant.month,
        instant.day,
        instant.hour,
        instant.minute,
        instant.second - (instant.second % 2),
    )


def assert_public_name(name: str) -> None:
    pure = pathlib.PurePosixPath(name)
    lowered_parts = {part.lower() for part in pure.parts}
    basename = pure.name.lower()
    if lowered_parts & FORBIDDEN_PARTS:
        raise AssertionError(f"private or generated path in archive: {name}")
    if basename in FORBIDDEN_BASENAMES:
        raise AssertionError(f"private review material in archive: {name}")
    if pathlib.PurePosixPath(basename).suffix in FORBIDDEN_SUFFIXES:
        raise AssertionError(f"credential-like file in archive: {name}")
    if pathlib.PurePosixPath(basename).suffix in FORBIDDEN_GENERATED_SUFFIXES:
        raise AssertionError(f"generated cache file in archive: {name}")
    if FORBIDDEN_NAME_FRAGMENT.search(basename):
        raise AssertionError(f"submission or reviewer record in archive: {name}")


def assert_safe_archive(archive: zipfile.ZipFile) -> list[str]:
    infos = archive.infolist()
    names = [info.filename for info in infos]
    if len(names) != len(set(names)):
        raise AssertionError("archive contains duplicate paths")
    if names != sorted(names):
        raise AssertionError("archive entries are not bytewise sorted")

    expected_timestamp = expected_zip_datetime()
    for info in infos:
        name = info.filename
        pure = pathlib.PurePosixPath(name)
        if not name or pure.is_absolute() or ".." in pure.parts or "\\" in name:
            raise AssertionError(f"unsafe archive path: {name}")
        if info.flag_bits & 0x1:
            raise AssertionError(f"encrypted archive member: {name}")
        mode = (info.external_attr >> 16) & 0xFFFF
        if stat.S_ISLNK(mode):
            raise AssertionError(f"symbolic link in archive: {name}")
        if not info.is_dir() and info.date_time != expected_timestamp:
            raise AssertionError(
                f"non-reproducible timestamp for {name}: "
                f"{info.date_time!r}, expected {expected_timestamp!r}"
            )
        assert_public_name(name)

    bad = archive.testzip()
    if bad:
        raise AssertionError(f"CRC failure: {bad}")
    return names


def assert_allowed_top_level(names: list[str], allowed: set[str], root: str | None) -> None:
    for name in names:
        parts = pathlib.PurePosixPath(name).parts
        if not parts:
            continue
        top_index = 1 if root is not None else 0
        if root is not None and parts[0] != root:
            raise AssertionError(f"source member escapes its root directory: {name}")
        if len(parts) <= top_index:
            continue
        top = parts[top_index]
        if top not in allowed:
            raise AssertionError(f"unexpected archive top-level entry: {top}")


def audit_xpi(path: pathlib.Path) -> tuple[str, list[str]]:
    with zipfile.ZipFile(path) as archive:
        names = assert_safe_archive(archive)
        assert_allowed_top_level(names, XPI_ALLOWED_TOP_LEVEL, root=None)
        required = {
            "manifest.json",
            "src/core.js",
            "src/page-hook.js",
            "src/bridge.js",
            "popup/popup.html",
            "popup/popup.js",
            "dashboard/dashboard.html",
            "dashboard/dashboard.js",
            "LICENSE",
            "PRIVACY.md",
            "SECURITY.md",
            "THIRD_PARTY_NOTICES.md",
        }
        missing = required.difference(names)
        if missing:
            raise AssertionError(f"XPI is missing required files: {sorted(missing)}")

        manifest = json.loads(archive.read("manifest.json"))
        if manifest.get("manifest_version") != 3:
            raise AssertionError("XPI is not Manifest V3")
        version = manifest.get("version")
        if not isinstance(version, str) or not re.fullmatch(r"\d+\.\d+\.\d+", version):
            raise AssertionError(f"invalid manifest version in XPI: {version!r}")
        expected_name = f"{ARTIFACT_PREFIX}-{version}-unsigned.xpi"
        if path.name != expected_name:
            raise AssertionError(f"unexpected XPI filename: {path.name}; expected {expected_name}")
        return version, names


def audit_source(path: pathlib.Path, expected_version: str) -> list[str]:
    with zipfile.ZipFile(path) as archive:
        names = assert_safe_archive(archive)
        roots = {pathlib.PurePosixPath(name).parts[0] for name in names if name}
        expected_root = f"{ARTIFACT_PREFIX}-{expected_version}-source"
        if roots != {expected_root}:
            raise AssertionError(
                f"source archive must have root {expected_root!r}, got {sorted(roots)!r}"
            )
        expected_name = f"{expected_root}.zip"
        if path.name != expected_name:
            raise AssertionError(
                f"unexpected source filename: {path.name}; expected {expected_name}"
            )
        assert_allowed_top_level(names, SOURCE_ALLOWED_TOP_LEVEL, root=expected_root)

        required = {
            f"{expected_root}/manifest.json",
            f"{expected_root}/package.json",
            f"{expected_root}/package-lock.json",
            f"{expected_root}/README.md",
            f"{expected_root}/tests/core.test.mjs",
            f"{expected_root}/tests/page-hook.test.mjs",
            f"{expected_root}/scripts/package.sh",
            f"{expected_root}/scripts/review.mjs",
            f"{expected_root}/scripts/archive_audit.py",
            f"{expected_root}/scripts/lint-addon.mjs",
            f"{expected_root}/.github/workflows/ci.yml",
            f"{expected_root}/.github/workflows/release.yml",
            f"{expected_root}/THIRD_PARTY_NOTICES.md",
            f"{expected_root}/CHANGELOG.md",
        }
        missing = required.difference(names)
        if missing:
            raise AssertionError(f"source archive is missing: {sorted(missing)}")

        manifest = json.loads(archive.read(f"{expected_root}/manifest.json"))
        package = json.loads(archive.read(f"{expected_root}/package.json"))
        lock = json.loads(archive.read(f"{expected_root}/package-lock.json"))
        if manifest.get("version") != expected_version:
            raise AssertionError("source manifest version does not match XPI")
        if package.get("version") != expected_version:
            raise AssertionError("source package version does not match XPI")
        if package.get("name") != ARTIFACT_PREFIX:
            raise AssertionError("source package name does not match artifact prefix")
        if lock.get("name") != ARTIFACT_PREFIX or lock.get("version") != expected_version:
            raise AssertionError("source lockfile metadata does not match package")
        if lock.get("lockfileVersion") != 3:
            raise AssertionError("source lockfile must use lockfileVersion 3")
        return names


def sha256(path: pathlib.Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def audit_checksums(
    path: pathlib.Path, xpi: pathlib.Path, source: pathlib.Path
) -> None:
    expected_files = [xpi, source]
    lines = path.read_text(encoding="utf-8").splitlines()
    if len(lines) != len(expected_files):
        raise AssertionError("checksum file must contain exactly XPI and source ZIP")
    for line, artifact in zip(lines, expected_files, strict=True):
        match = re.fullmatch(r"([0-9a-f]{64})  ([^/\\\s]+)", line)
        if match is None:
            raise AssertionError(f"invalid checksum line: {line!r}")
        recorded_hash, recorded_name = match.groups()
        if recorded_name != artifact.name:
            raise AssertionError(
                f"unexpected checksum target {recorded_name!r}; expected {artifact.name!r}"
            )
        actual_hash = sha256(artifact)
        if recorded_hash != actual_hash:
            raise AssertionError(f"checksum mismatch for {artifact.name}")


def audit_pair(xpi: pathlib.Path, source: pathlib.Path) -> None:
    if (
        not xpi.is_file()
        or not source.is_file()
        or xpi.is_symlink()
        or source.is_symlink()
    ):
        raise AssertionError("XPI and source ZIP must be regular, non-symlink files")
    version, _ = audit_xpi(xpi)
    audit_source(source, version)
    print(f"PASS archive audit: {xpi.name}")
    print(f"PASS archive audit: {source.name}")


def audit_release_directory(release_dir: pathlib.Path) -> None:
    root = pathlib.Path(__file__).resolve().parent.parent
    manifest = json.loads((root / "manifest.json").read_text(encoding="utf-8"))
    package = json.loads((root / "package.json").read_text(encoding="utf-8"))
    version = manifest.get("version")
    if version != package.get("version"):
        raise AssertionError("repository manifest and package versions do not match")

    xpi = release_dir / f"{ARTIFACT_PREFIX}-{version}-unsigned.xpi"
    source = release_dir / f"{ARTIFACT_PREFIX}-{version}-source.zip"
    checksums = release_dir / f"{ARTIFACT_PREFIX}-{version}-SHA256SUMS.txt"
    expected = {xpi.name, source.name, checksums.name}
    actual = {entry.name for entry in release_dir.iterdir()}
    if actual != expected:
        raise AssertionError(
            f"release directory files do not match the public artifact set: "
            f"expected {sorted(expected)!r}, got {sorted(actual)!r}"
        )
    if any(artifact.is_symlink() for artifact in (xpi, source, checksums)):
        raise AssertionError("release artifacts must not be symbolic links")

    audit_pair(xpi, source)
    audit_checksums(checksums, xpi, source)
    print(f"PASS checksum audit: {checksums.name}")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("archives", nargs="*", type=pathlib.Path, metavar="ARCHIVE")
    parser.add_argument("--release-dir", type=pathlib.Path)
    args = parser.parse_args()
    if args.release_dir is not None and args.archives:
        parser.error("--release-dir cannot be combined with positional archives")
    if args.release_dir is None and len(args.archives) != 2:
        parser.error("provide XPI SOURCE_ZIP or --release-dir DIRECTORY")
    return args


def main() -> int:
    args = parse_args()
    try:
        if args.release_dir is not None:
            audit_release_directory(args.release_dir.resolve())
        else:
            audit_pair(args.archives[0].resolve(), args.archives[1].resolve())
    except (AssertionError, OSError, ValueError, json.JSONDecodeError, zipfile.BadZipFile) as error:
        print(f"FAIL archive audit: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
