#!/usr/bin/env bash
set -euo pipefail

export LC_ALL=C
export TZ=UTC

readonly ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly ARTIFACT_PREFIX="muofu-ai-quota-lens-firefox"
readonly RELEASE="$ROOT/release"
# ZIP timestamps start at 1980; callers may override this stable default.
readonly MIN_ZIP_EPOCH=315532800
readonly MAX_ZIP_EPOCH=4354819198

VERSION="$(node -e 'const fs=require("node:fs");process.stdout.write(JSON.parse(fs.readFileSync(process.argv[1],"utf8")).version)' "$ROOT/manifest.json")"
PACKAGE_VERSION="$(node -e 'const fs=require("node:fs");process.stdout.write(JSON.parse(fs.readFileSync(process.argv[1],"utf8")).version)' "$ROOT/package.json")"
PACKAGE_NAME="$(node -e 'const fs=require("node:fs");process.stdout.write(JSON.parse(fs.readFileSync(process.argv[1],"utf8")).name)' "$ROOT/package.json")"

if [[ "$VERSION" != "$PACKAGE_VERSION" ]]; then
  printf 'Manifest version %s does not match package version %s\n' "$VERSION" "$PACKAGE_VERSION" >&2
  exit 1
fi
if [[ "$PACKAGE_NAME" != "$ARTIFACT_PREFIX" ]]; then
  printf 'Package name %s does not match artifact prefix %s\n' "$PACKAGE_NAME" "$ARTIFACT_PREFIX" >&2
  exit 1
fi

SOURCE_DATE_EPOCH="${SOURCE_DATE_EPOCH:-$MIN_ZIP_EPOCH}"
if [[ ! "$SOURCE_DATE_EPOCH" =~ ^[0-9]+$ ]] ||
  (( SOURCE_DATE_EPOCH < MIN_ZIP_EPOCH || SOURCE_DATE_EPOCH > MAX_ZIP_EPOCH )); then
  printf 'SOURCE_DATE_EPOCH must be an integer between %s and %s\n' "$MIN_ZIP_EPOCH" "$MAX_ZIP_EPOCH" >&2
  exit 1
fi
export SOURCE_DATE_EPOCH

ARCHIVE_TOUCH_TIME="$(node -e '
  const date = new Date(Number(process.argv[1]) * 1000);
  const pad = (value) => String(value).padStart(2, "0");
  process.stdout.write(`${date.getUTCFullYear()}${pad(date.getUTCMonth()+1)}${pad(date.getUTCDate())}${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}.${pad(date.getUTCSeconds())}`);
' "$SOURCE_DATE_EPOCH")"

STAGE="$(mktemp -d)"
SOURCE_STAGE="$(mktemp -d)"
OUTPUT_STAGE="$(mktemp -d)"
cleanup() {
  rm -rf -- "$STAGE" "$SOURCE_STAGE" "$OUTPUT_STAGE"
}
trap cleanup EXIT

copy_required_items() {
  local destination="$1"
  shift
  local item
  for item in "$@"; do
    if [[ ! -e "$ROOT/$item" ]]; then
      printf 'Required package input is missing: %s\n' "$item" >&2
      exit 1
    fi
    cp -R -- "$ROOT/$item" "$destination/"
  done
}

normalize_tree() {
  local directory="$1"
  find "$directory" -type d -exec chmod 0755 {} +
  find "$directory" -type f -exec chmod 0644 {} +
  find "$directory" -exec touch -h -t "$ARCHIVE_TOUCH_TIME" {} +
}

cd "$ROOT"

runtime_items=(
  manifest.json _locales src popup dashboard icons
  LICENSE PRIVACY.md SECURITY.md THIRD_PARTY_NOTICES.md REFERENCE_BASELINES.md
)
copy_required_items "$STAGE" "${runtime_items[@]}"

if [[ -n "$(find "$STAGE" -type l -print -quit)" ]]; then
  printf 'Refusing to package symlinks in the XPI\n' >&2
  exit 1
fi
normalize_tree "$STAGE"

XPI="$OUTPUT_STAGE/${ARTIFACT_PREFIX}-${VERSION}-unsigned.xpi"
(
  cd "$STAGE"
  find . -type f -printf '%P\n' | sort | zip -X -q "$XPI" -@
)
unzip -t "$XPI" >/dev/null
unzip -p "$XPI" manifest.json | node -e '
  let source = "";
  process.stdin.on("data", (chunk) => { source += chunk; });
  process.stdin.on("end", () => {
    const manifest = JSON.parse(source);
    if (manifest.manifest_version !== 3 || manifest.version !== process.argv[1]) process.exit(1);
  });
' "$VERSION"

SOURCE_ROOT="${ARTIFACT_PREFIX}-${VERSION}-source"
SOURCE_DIR="$SOURCE_STAGE/$SOURCE_ROOT"
mkdir -p "$SOURCE_DIR"
source_items=(
  manifest.json _locales src popup dashboard icons tests
  package.json package-lock.json
  LICENSE README.md INSTALL.md PRIVACY.md SECURITY.md THIRD_PARTY_NOTICES.md
  REFERENCE_BASELINES.md CHANGELOG.md
)
copy_required_items "$SOURCE_DIR" "${source_items[@]}"
source_script_items=(
  scripts/archive_audit.py scripts/lint-addon.mjs scripts/package.sh scripts/review.mjs
)
mkdir -p "$SOURCE_DIR/scripts"
copy_required_items "$SOURCE_DIR/scripts" "${source_script_items[@]}"
mkdir -p "$SOURCE_DIR/.github"
copy_required_items "$SOURCE_DIR/.github" .github/workflows

if [[ -n "$(find "$SOURCE_DIR" -type l -print -quit)" ]]; then
  printf 'Refusing to package symlinks in the source archive\n' >&2
  exit 1
fi
normalize_tree "$SOURCE_DIR"
chmod 0755 "$SOURCE_DIR/scripts/package.sh" "$SOURCE_DIR/scripts/archive_audit.py"
touch -h -t "$ARCHIVE_TOUCH_TIME" "$SOURCE_DIR/scripts/package.sh" "$SOURCE_DIR/scripts/archive_audit.py"

SOURCE_ZIP="$OUTPUT_STAGE/${ARTIFACT_PREFIX}-${VERSION}-source.zip"
(
  cd "$SOURCE_STAGE"
  find "$SOURCE_ROOT" -type f -printf '%p\n' | sort | zip -X -q "$SOURCE_ZIP" -@
)
unzip -t "$SOURCE_ZIP" >/dev/null
python3 "$ROOT/scripts/archive_audit.py" "$XPI" "$SOURCE_ZIP"

CHECKSUMS="$OUTPUT_STAGE/${ARTIFACT_PREFIX}-${VERSION}-SHA256SUMS.txt"
(
  cd "$OUTPUT_STAGE"
  sha256sum "$(basename "$XPI")" "$(basename "$SOURCE_ZIP")" > "$(basename "$CHECKSUMS")"
  sha256sum -c "$(basename "$CHECKSUMS")" >/dev/null
)

if [[ "$RELEASE" != "$ROOT/release" ]]; then
  printf 'Refusing to replace unexpected release path: %s\n' "$RELEASE" >&2
  exit 1
fi
rm -rf -- "$RELEASE"
mkdir -p "$RELEASE"
cp -- "$XPI" "$SOURCE_ZIP" "$CHECKSUMS" "$RELEASE/"

printf 'Created reproducible artifacts (SOURCE_DATE_EPOCH=%s):\n' "$SOURCE_DATE_EPOCH"
printf '  %s\n' \
  "$RELEASE/$(basename "$XPI")" \
  "$RELEASE/$(basename "$SOURCE_ZIP")" \
  "$RELEASE/$(basename "$CHECKSUMS")"
