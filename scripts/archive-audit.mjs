import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readZip } from './zip.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const ARTIFACT_PREFIX = 'muofu-ai-quota-lens-firefox';
export const DEFAULT_SOURCE_DATE_EPOCH = 315532800; // 1980-01-01T00:00:00Z, ZIP's lower bound.
const MIN_ZIP_EPOCH = 315532800;
const MAX_ZIP_EPOCH = 4354819198;

const XPI_ALLOWED_TOP_LEVEL = new Set([
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
]);
const SOURCE_ONLY_TOP_LEVEL = [
  '.github',
  'tests',
  'scripts',
  'package.json',
  'package-lock.json',
  'README.md',
  'INSTALL.md',
  'CHANGELOG.md',
];
const SOURCE_ALLOWED_TOP_LEVEL = new Set([...XPI_ALLOWED_TOP_LEVEL, ...SOURCE_ONLY_TOP_LEVEL]);
const FORBIDDEN_PARTS = new Set([
  '.git',
  '.tmp',
  '__pycache__',
  'node_modules',
  'release',
  'web-ext-artifacts',
  'coverage',
]);
const FORBIDDEN_BASENAMES = new Set([
  '.env',
  'amo_submission.md',
  'amo_reviewer_notes.md',
  'review.md',
]);
const FORBIDDEN_SUFFIXES = new Set(['.key', '.pem', '.p12', '.pfx']);
const FORBIDDEN_GENERATED_SUFFIXES = new Set(['.pyc', '.pyo']);
const FORBIDDEN_NAME_FRAGMENT =
  /(?:amo[_-]?(?:review|submission|listing|delivery)|reviewer|submission[_-]?(?:id|receipt)|delivery[_-]?record|validator[_-]?output|saved[_-]?session)/i;

export function sourceDateEpoch() {
  const raw = process.env.SOURCE_DATE_EPOCH ?? String(DEFAULT_SOURCE_DATE_EPOCH);
  if (!/^\d+$/.test(raw)) {
    throw new Error('SOURCE_DATE_EPOCH must be a decimal integer');
  }
  const epoch = Number.parseInt(raw, 10);
  if (epoch < MIN_ZIP_EPOCH || epoch > MAX_ZIP_EPOCH) {
    throw new Error(`SOURCE_DATE_EPOCH must be between ${MIN_ZIP_EPOCH} and ${MAX_ZIP_EPOCH}`);
  }
  return epoch;
}

export function expectedZipDateTime(epoch = sourceDateEpoch()) {
  const instant = new Date(epoch * 1000);
  return {
    year: instant.getUTCFullYear(),
    month: instant.getUTCMonth() + 1,
    day: instant.getUTCDate(),
    hour: instant.getUTCHours(),
    minute: instant.getUTCMinutes(),
    second: instant.getUTCSeconds() - (instant.getUTCSeconds() % 2),
  };
}

function assertPublicName(name) {
  const normalized = name.split('/').map((part) => part.toLowerCase());
  const basename = normalized.at(-1);
  if (normalized.some((part) => FORBIDDEN_PARTS.has(part))) {
    throw new Error(`private or generated path in archive: ${name}`);
  }
  if (FORBIDDEN_BASENAMES.has(basename)) {
    throw new Error(`private review material in archive: ${name}`);
  }
  const suffix = path.posix.extname(basename);
  if (FORBIDDEN_SUFFIXES.has(suffix)) {
    throw new Error(`credential-like file in archive: ${name}`);
  }
  if (FORBIDDEN_GENERATED_SUFFIXES.has(suffix)) {
    throw new Error(`generated cache file in archive: ${name}`);
  }
  if (FORBIDDEN_NAME_FRAGMENT.test(basename)) {
    throw new Error(`submission or reviewer record in archive: ${name}`);
  }
}

function describeDateTime(dateTime) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${dateTime.year}-${pad(dateTime.month)}-${pad(dateTime.day)} `
    + `${pad(dateTime.hour)}:${pad(dateTime.minute)}:${pad(dateTime.second)}`;
}

export function assertSafeArchive(entries) {
  const names = entries.map((entry) => entry.name);
  const duplicates = names.filter((name, index) => names.indexOf(name) !== index);
  if (duplicates.length > 0) {
    throw new Error(`archive contains duplicate paths: ${[...new Set(duplicates)].join(', ')}`);
  }
  const sorted = [...names].sort();
  const firstUnsorted = names.findIndex((name, index) => name !== sorted[index]);
  if (firstUnsorted !== -1) {
    throw new Error(
      `archive entries are not bytewise sorted at ${names[firstUnsorted]}: `
      + `expected ${sorted[firstUnsorted]}`,
    );
  }

  const expected = expectedZipDateTime();
  for (const entry of entries) {
    const { name, dateTime, externalAttributes } = entry;
    const mode = (externalAttributes >>> 16) & 0xffff;
    if (!name || name.startsWith('/') || name.includes('..') || name.includes('\\')) {
      throw new Error(`unsafe archive path: ${name}`);
    }
    if ((mode & 0o170000) === 0o120000) {
      throw new Error(`symbolic link in archive: ${name}`);
    }
    if (describeDateTime(dateTime) !== describeDateTime(expected)) {
      throw new Error(
        `non-reproducible timestamp for ${name}: `
        + `${describeDateTime(dateTime)}, expected ${describeDateTime(expected)}`,
      );
    }
    assertPublicName(name);
  }
  return names;
}

function assertAllowedTopLevel(names, allowed, archiveRoot) {
  for (const name of names) {
    const parts = name.split('/');
    if (archiveRoot !== null) {
      if (parts[0] !== archiveRoot) {
        throw new Error(`source member escapes its root directory: ${name}`);
      }
      if (parts.length <= 1) continue;
      parts.shift();
    }
    if (!allowed.has(parts[0])) {
      throw new Error(`unexpected archive top-level entry: ${parts[0]}`);
    }
  }
}

function requireEntries(names, required, archiveRoot, label) {
  const prefix = archiveRoot ? `${archiveRoot}/` : '';
  const present = new Set(names.map((name) => (name.startsWith(prefix) ? name.slice(prefix.length) : null)));
  const missing = [...required].filter((name) => !present.has(name)).sort();
  if (missing.length > 0) {
    throw new Error(`${label} is missing required files: ${JSON.stringify(missing)}`);
  }
}

function parseJson(entries, name) {
  const entry = entries.find((candidate) => candidate.name === name);
  if (!entry) throw new Error(`archive does not contain ${name}`);
  return JSON.parse(entry.data.toString('utf8'));
}

export function auditXpi(entries, filename) {
  const names = assertSafeArchive(entries);
  assertAllowedTopLevel(names, XPI_ALLOWED_TOP_LEVEL, null);
  requireEntries(names, [
    'manifest.json',
    'src/core.js',
    'src/page-hook.js',
    'src/bridge.js',
    'popup/popup.html',
    'popup/popup.js',
    'dashboard/dashboard.html',
    'dashboard/dashboard.js',
    'LICENSE',
    'PRIVACY.md',
    'SECURITY.md',
    'THIRD_PARTY_NOTICES.md',
  ], null, 'XPI');

  const manifest = parseJson(entries, 'manifest.json');
  if (manifest.manifest_version !== 3) {
    throw new Error(`XPI is not Manifest V3: manifest_version=${manifest.manifest_version}`);
  }
  const version = manifest.version;
  if (!/^\d+\.\d+\.\d+$/.test(String(version))) {
    throw new Error(`invalid manifest version in XPI: ${version}`);
  }
  const expectedName = `${ARTIFACT_PREFIX}-${version}-unsigned.xpi`;
  if (filename !== expectedName) {
    throw new Error(`unexpected XPI filename: ${filename}; expected ${expectedName}`);
  }
  return version;
}

export function auditSource(entries, expectedVersion) {
  const names = assertSafeArchive(entries);
  const expectedRoot = `${ARTIFACT_PREFIX}-${expectedVersion}-source`;
  const roots = [...new Set(names.filter(Boolean).map((name) => name.split('/')[0]))].sort();
  if (roots.length !== 1 || roots[0] !== expectedRoot) {
    throw new Error(`source archive must have root ${expectedRoot}, got ${roots.join(', ')}`);
  }
  assertAllowedTopLevel(names, SOURCE_ALLOWED_TOP_LEVEL, expectedRoot);
  requireEntries(names, [
    'manifest.json',
    'package.json',
    'package-lock.json',
    'README.md',
    'tests/core.test.mjs',
    'tests/page-hook.test.mjs',
    'scripts/package.mjs',
    'scripts/archive-audit.mjs',
    'scripts/zip.mjs',
    'scripts/review.mjs',
    'scripts/lint-addon.mjs',
    '.github/workflows/ci.yml',
    '.github/workflows/release.yml',
    'THIRD_PARTY_NOTICES.md',
    'CHANGELOG.md',
  ], expectedRoot, 'source archive');

  const manifest = parseJson(entries, `${expectedRoot}/manifest.json`);
  const pkg = parseJson(entries, `${expectedRoot}/package.json`);
  const lock = parseJson(entries, `${expectedRoot}/package-lock.json`);
  const expectations = [
    ['source manifest version', manifest.version, expectedVersion],
    ['source package version', pkg.version, expectedVersion],
    ['source package name', pkg.name, ARTIFACT_PREFIX],
    ['source lockfile name', lock.name, ARTIFACT_PREFIX],
    ['source lockfile version', lock.version, expectedVersion],
    ['source lockfile lockfileVersion', lock.lockfileVersion, 3],
  ];
  for (const [label, actual, expected] of expectations) {
    if (actual !== expected) {
      throw new Error(`${label} mismatch: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
    }
  }
}

export function sha256(data) {
  return createHash('sha256').update(data).digest('hex');
}

export function auditPair(xpiPath, sourcePath) {
  for (const target of [xpiPath, sourcePath]) {
    if (!existsSync(target)) {
      throw new Error(`missing archive: ${target}`);
    }
    if (lstatSync(target).isSymbolicLink()) {
      throw new Error(`archive must not be a symlink: ${target}`);
    }
  }
  const version = auditXpi(readZip(readFileSync(xpiPath)), path.basename(xpiPath));
  auditSource(readZip(readFileSync(sourcePath)), version);
  process.stdout.write(`PASS archive audit: ${path.basename(xpiPath)}\n`);
  process.stdout.write(`PASS archive audit: ${path.basename(sourcePath)}\n`);
}

function auditChecksums(checksumPath, xpiPath, sourcePath) {
  const lines = readFileSync(checksumPath, 'utf8').split(/\r?\n/).filter((line) => line.length > 0);
  const expected = [xpiPath, sourcePath];
  if (lines.length !== expected.length) {
    throw new Error(`checksum file must list exactly the XPI and source ZIP: got ${lines.length} line(s)`);
  }
  for (const [index, artifact] of expected.entries()) {
    const match = /^([0-9a-f]{64})  ([^/\\\s]+)$/.exec(lines[index]);
    if (!match) {
      throw new Error(`invalid checksum line ${index + 1}: ${JSON.stringify(lines[index])}`);
    }
    const [, recordedHash, recordedName] = match;
    if (recordedName !== path.basename(artifact)) {
      throw new Error(`unexpected checksum target: got ${recordedName}, expected ${path.basename(artifact)}`);
    }
    const actualHash = sha256(readFileSync(artifact));
    if (recordedHash !== actualHash) {
      throw new Error(`checksum mismatch for ${recordedName}: recorded ${recordedHash}, actual ${actualHash}`);
    }
  }
}

export function auditReleaseDirectory(releaseDir) {
  const manifest = JSON.parse(readFileSync(path.join(root, 'manifest.json'), 'utf8'));
  const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  if (manifest.version !== pkg.version) {
    throw new Error(
      `repository manifest and package versions do not match: `
      + `${manifest.version} !== ${pkg.version}`,
    );
  }

  const version = manifest.version;
  const xpi = path.join(releaseDir, `${ARTIFACT_PREFIX}-${version}-unsigned.xpi`);
  const source = path.join(releaseDir, `${ARTIFACT_PREFIX}-${version}-source.zip`);
  const checksums = path.join(releaseDir, `${ARTIFACT_PREFIX}-${version}-SHA256SUMS.txt`);
  const expected = new Set([path.basename(xpi), path.basename(source), path.basename(checksums)]);
  const actual = [...readdirSync(releaseDir)].sort();
  const expectedNames = [...expected].sort();
  const unexpectedFiles = actual.filter((name) => !expected.has(name));
  const missingFiles = expectedNames.filter((name) => !actual.includes(name));
  if (unexpectedFiles.length > 0 || missingFiles.length > 0) {
    throw new Error(
      'release directory files do not match the public artifact set: '
      + `unexpected ${JSON.stringify(unexpectedFiles)}, missing ${JSON.stringify(missingFiles)}`,
    );
  }
  for (const artifact of [xpi, source, checksums]) {
    if (lstatSync(artifact).isSymbolicLink()) {
      throw new Error(`release artifact must not be a symbolic link: ${path.basename(artifact)}`);
    }
  }

  auditPair(xpi, source);
  auditChecksums(checksums, xpi, source);
  process.stdout.write(`PASS checksum audit: ${path.basename(checksums)}\n`);
}

function parseArguments(argv) {
  const args = argv.slice(2);
  let releaseDir = null;
  const archives = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--release-dir') {
      releaseDir = args[index + 1];
      index += 1;
    } else {
      archives.push(args[index]);
    }
  }
  if (releaseDir !== null && archives.length > 0) {
    throw new Error('--release-dir cannot be combined with positional archives');
  }
  if (releaseDir === null && archives.length !== 2) {
    throw new Error('provide XPI SOURCE_ZIP or --release-dir DIRECTORY');
  }
  return { releaseDir, archives };
}

function main() {
  try {
    const { releaseDir, archives } = parseArguments(process.argv);
    if (releaseDir !== null) {
      auditReleaseDirectory(path.resolve(releaseDir));
    } else {
      auditPair(path.resolve(archives[0]), path.resolve(archives[1]));
    }
  } catch (error) {
    process.stderr.write(`FAIL archive audit: ${error.message}\n`);
    return 1;
  }
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main());
}