import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.NO_UPDATE_NOTIFIER = '1';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ignoredFiles = [
  'tests/**',
  'scripts/**',
  'docs/**',
  '.github/**',
  '.tmp/**',
  'release/**',
  'web-ext-artifacts/**',
  'coverage/**',
  'node_modules/**',
  'package.json',
  'package-lock.json',
  'AGENTS.md',
  'README.md',
  'INSTALL.md',
  'CHANGELOG.md',
];
const allowedWarnings = new Map([
  ['KEY_FIREFOX_ANDROID_UNSUPPORTED_BY_MIN_VERSION', 'manifest.json'],
]);

function formatIssue(issue) {
  const location = [issue.file, issue.line, issue.column].filter((value) => value != null).join(':');
  return [
    issue._type?.toUpperCase() || 'ISSUE',
    issue.code || 'UNKNOWN',
    location || '<unknown>',
    issue.message || issue.description || 'No description',
  ].join('  ');
}

const capturedStdout = [];
const originalStdoutWrite = process.stdout.write;
process.stdout.write = function captureStdout(chunk, encoding, callback) {
  capturedStdout.push(Buffer.isBuffer(chunk) ? chunk.toString() : String(chunk));
  if (typeof encoding === 'function') encoding();
  if (typeof callback === 'function') callback();
  return true;
};

let lintFailure = null;
try {
  const { default: webExt } = await import('web-ext');
  await webExt.cmd.lint(
    {
      artifactsDir: path.join(root, 'web-ext-artifacts'),
      boring: true,
      enterprise: false,
      ignoreFiles: ignoredFiles,
      metadata: false,
      output: 'json',
      pretty: false,
      privileged: false,
      selfHosted: false,
      sourceDir: root,
      verbose: false,
      warningsAsErrors: false,
    },
    { shouldExitProgram: false },
  );
} catch (error) {
  lintFailure = error;
} finally {
  process.stdout.write = originalStdoutWrite;
}

if (lintFailure) {
  const message = lintFailure instanceof Error ? lintFailure.stack || lintFailure.message : String(lintFailure);
  process.stderr.write(`FAIL web-ext lint could not complete: ${message}\n`);
  process.exit(1);
}

let report;
try {
  report = JSON.parse(capturedStdout.join('').trim());
  assert.ok(Array.isArray(report.errors), 'errors must be an array');
  assert.ok(Array.isArray(report.notices), 'notices must be an array');
  assert.ok(Array.isArray(report.warnings), 'warnings must be an array');
} catch (error) {
  process.stderr.write('FAIL web-ext lint returned invalid JSON\n');
  process.stderr.write(capturedStdout.join(''));
  if (error instanceof Error) process.stderr.write(`${error.message}\n`);
  process.exit(1);
}

const unexpectedWarnings = report.warnings.filter(
  (warning) => allowedWarnings.get(warning.code) !== warning.file,
);
const unexpected = [...report.errors, ...report.notices, ...unexpectedWarnings];

if (unexpected.length > 0) {
  process.stderr.write(
    `FAIL web-ext lint: ${report.errors.length} error(s), `
      + `${report.notices.length} notice(s), `
      + `${report.warnings.length} warning(s)\n`,
  );
  for (const issue of [...report.errors, ...report.notices, ...report.warnings]) {
    process.stderr.write(`${formatIssue(issue)}\n`);
  }
  process.exit(1);
}

process.stdout.write(
  `PASS web-ext lint: 0 errors, 0 notices, ${report.warnings.length} allowed warning(s)\n`,
);
for (const warning of report.warnings) {
  process.stdout.write(`ALLOW  ${formatIssue(warning)}\n`);
}
