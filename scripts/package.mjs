import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ARTIFACT_PREFIX,
  auditReleaseDirectory,
  expectedZipDateTime,
  sha256,
  sourceDateEpoch,
} from './archive-audit.mjs';
import { createZip } from './zip.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const releaseDir = path.join(root, 'release');

const RUNTIME_ITEMS = [
  'manifest.json',
  '_locales',
  'src',
  'popup',
  'dashboard',
  'icons',
  'LICENSE',
  'PRIVACY.md',
  'SECURITY.md',
  'THIRD_PARTY_NOTICES.md',
  'REFERENCE_BASELINES.md',
];
const SOURCE_ITEMS = [
  'manifest.json',
  '_locales',
  'src',
  'popup',
  'dashboard',
  'icons',
  'tests',
  'package.json',
  'package-lock.json',
  'LICENSE',
  'README.md',
  'INSTALL.md',
  'PRIVACY.md',
  'SECURITY.md',
  'THIRD_PARTY_NOTICES.md',
  'REFERENCE_BASELINES.md',
  'CHANGELOG.md',
];
const SOURCE_SCRIPTS = [
  'scripts/archive-audit.mjs',
  'scripts/lint-addon.mjs',
  'scripts/package.mjs',
  'scripts/review.mjs',
  'scripts/zip.mjs',
];
const SOURCE_WORKFLOWS = ['.github/workflows/ci.yml', '.github/workflows/release.yml'];

function readJson(relative) {
  return JSON.parse(readFileSync(path.join(root, relative), 'utf8'));
}

function resolveVersion() {
  const manifestVersion = readJson('manifest.json').version;
  const { version: packageVersion, name: packageName } = readJson('package.json');
  if (manifestVersion !== packageVersion) {
    throw new Error(`Manifest version ${manifestVersion} does not match package version ${packageVersion}`);
  }
  if (packageName !== ARTIFACT_PREFIX) {
    throw new Error(`Package name ${packageName} does not match artifact prefix ${ARTIFACT_PREFIX}`);
  }
  return manifestVersion;
}

function assertPackagable(relative) {
  const absolute = path.join(root, relative);
  if (!existsSync(absolute)) {
    throw new Error(`Required package input is missing: ${relative}`);
  }
  if (lstatSync(absolute).isSymbolicLink()) {
    throw new Error(`Refusing to package symlink in the release archives: ${relative}`);
  }
  return relative;
}

function collectFiles(items) {
  const files = [];
  const visit = (relative) => {
    const absolute = path.join(root, relative);
    const stats = lstatSync(absolute);
    if (stats.isSymbolicLink()) {
      throw new Error(`Refusing to package symlink in the release archives: ${relative}`);
    }
    if (stats.isDirectory()) {
      for (const entry of readdirSync(absolute).sort()) {
        visit(path.join(relative, entry));
      }
      return;
    }
    files.push(relative.split(path.sep).join('/'));
  };
  for (const item of items) {
    visit(assertPackagable(item));
  }
  return files;
}

/**
 * Reproducible packaging depends on a stable order and fixed ZIP timestamps, so
 * entries are sorted bytewise and stamped from SOURCE_DATE_EPOCH rather than
 * the filesystem clock.
 */
function buildZipEntries(files, archiveRoot, dateTime) {
  return [...files]
    .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
    .map((file) => ({
      name: archiveRoot ? `${archiveRoot}/${file}` : file,
      data: readFileSync(path.join(root, file)),
      mode: 0o644,
      dateTime,
    }));
}

function main() {
  const version = resolveVersion();
  const dateTime = expectedZipDateTime(sourceDateEpoch());

  const xpiEntries = buildZipEntries(collectFiles(RUNTIME_ITEMS), null, dateTime);
  const sourceRoot = `${ARTIFACT_PREFIX}-${version}-source`;
  const sourceEntries = buildZipEntries(
    [
      ...collectFiles(SOURCE_ITEMS),
      ...collectFiles(SOURCE_SCRIPTS),
      ...collectFiles(SOURCE_WORKFLOWS),
    ],
    sourceRoot,
    dateTime,
  );

  const xpiName = `${ARTIFACT_PREFIX}-${version}-unsigned.xpi`;
  const sourceName = `${sourceRoot}.zip`;
  const checksumsName = `${ARTIFACT_PREFIX}-${version}-SHA256SUMS.txt`;

  const xpi = createZip(xpiEntries);
  const source = createZip(sourceEntries);
  const checksums = `${sha256(xpi)}  ${xpiName}\n${sha256(source)}  ${sourceName}\n`;

  if (releaseDir !== path.join(root, 'release')) {
    throw new Error(`Refusing to replace unexpected release path: ${releaseDir}`);
  }
  // Stale artifacts from another version must never survive into a release
  // directory. Windows can leave files locked by a virus scanner or indexer, so
  // verify the removal instead of trusting rmSync to have succeeded silently.
  rmSync(releaseDir, { recursive: true, force: true });
  if (existsSync(releaseDir)) {
    const stale = readdirSync(releaseDir).sort();
    if (stale.length > 0) {
      throw new Error(
        `release directory could not be cleared before writing ${version}: `
        + `${JSON.stringify(stale)} (close any process holding these files and retry)`,
      );
    }
  }
  mkdirSync(releaseDir, { recursive: true });
  writeFileSync(path.join(releaseDir, xpiName), xpi);
  writeFileSync(path.join(releaseDir, sourceName), source);
  writeFileSync(path.join(releaseDir, checksumsName), checksums);

  auditReleaseDirectory(releaseDir);

  process.stdout.write(`Created reproducible artifacts (SOURCE_DATE_EPOCH=${sourceDateEpoch()}):\n`);
  for (const name of [xpiName, sourceName, checksumsName]) {
    process.stdout.write(`  ${path.join('release', name)}\n`);
  }
}

try {
  main();
} catch (error) {
  process.stderr.write(`FAIL package: ${error.message}\n`);
  process.exit(1);
}