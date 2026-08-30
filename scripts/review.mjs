import assert from 'node:assert/strict';
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const checks = [];

function check(name, fn) {
  try {
    fn();
    checks.push({ name, ok: true });
  } catch (error) {
    checks.push({
      name,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function read(relative) {
  return readFileSync(path.join(root, relative), 'utf8');
}

function walk(directory) {
  const result = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (['.git', '.tmp', 'coverage', 'release', 'node_modules', 'web-ext-artifacts'].includes(entry.name)) continue;
    if (entry.isDirectory()) result.push(...walk(absolute));
    else result.push(absolute);
  }
  return result;
}

function objectKeyPaths(value, target, currentPath = '$') {
  if (value == null || typeof value !== 'object') return [];
  const matches = [];
  for (const [key, child] of Object.entries(value)) {
    const childPath = `${currentPath}.${key}`;
    if (key === target) matches.push(childPath);
    matches.push(...objectKeyPaths(child, target, childPath));
  }
  return matches;
}

function assertOfficialActionsPinned(source) {
  const actions = [...source.matchAll(/^\s*uses:\s*([^\s#]+)/gm)].map((match) => match[1]);
  assert.ok(actions.length > 0, 'workflow has no actions');
  for (const action of actions) {
    assert.match(action, /^actions\/(?:checkout|setup-node)@[0-9a-f]{40}$/, action);
  }
}

const manifest = JSON.parse(read('manifest.json'));
const pkg = JSON.parse(read('package.json'));
const lock = JSON.parse(read('package-lock.json'));
const runtimeJs = [
  'src/core.js',
  'src/page-hook.js',
  'src/bridge.js',
  'popup/popup.js',
  'dashboard/dashboard.js',
];
const htmlFiles = ['popup/popup.html', 'dashboard/dashboard.html'];
const runtimeTexts = Object.fromEntries(runtimeJs.map((file) => [file, read(file)]));
const allRuntimeText = Object.values(runtimeTexts).join('\n');
const hook = runtimeTexts['src/page-hook.js'];
const bridge = runtimeTexts['src/bridge.js'];
const core = runtimeTexts['src/core.js'];
const dashboard = runtimeTexts['dashboard/dashboard.js'];

// Manifest and compatibility.
check('manifest is valid MV3', () => assert.equal(manifest.manifest_version, 3));
check('manifest and package versions match', () => assert.equal(manifest.version, pkg.version));
check('release version is a three-part numeric version', () => {
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
});
check('package metadata uses the public Muofu repository identity', () => {
  assert.equal(pkg.name, 'muofu-ai-quota-lens-firefox');
  assert.match(pkg.description, /Muofu AI Quota Lens/);
  assert.equal(pkg.homepage, 'https://github.com/notuhao/muofu-ai-quota-lens#readme');
  assert.equal(pkg.repository?.url, 'git+https://github.com/notuhao/muofu-ai-quota-lens.git');
  assert.equal(pkg.bugs?.url, 'https://github.com/notuhao/muofu-ai-quota-lens/issues');
});
check('Node and web-ext toolchain versions are exact', () => {
  assert.equal(pkg.engines?.node, '>=22');
  assert.equal(pkg.devDependencies?.['web-ext'], '10.6.0');
  assert.doesNotMatch(pkg.devDependencies['web-ext'], /^[~^<>=*]/);
  assert.equal(pkg.scripts?.['lint:addon'], 'node scripts/lint-addon.mjs');
  assert.doesNotMatch(Object.values(pkg.scripts || {}).join('\n'), /web-ext\s+sign/);
});
check('lint wrapper suppresses update checks and only allows the known Android warning', () => {
  const lintWrapper = read('scripts/lint-addon.mjs');
  assert.match(lintWrapper, /NO_UPDATE_NOTIFIER = '1'/);
  assert.match(lintWrapper, /KEY_FIREFOX_ANDROID_UNSUPPORTED_BY_MIN_VERSION/);
  assert.match(lintWrapper, /unexpectedWarnings/);
  assert.match(lintWrapper, /report\.errors/);
});
check('source packaging copies an explicit script allowlist', () => {
  const packageScript = read('scripts/package.sh');
  assert.doesNotMatch(packageScript, /\btests scripts\b/);
  for (const script of ['archive_audit.py', 'lint-addon.mjs', 'package.sh', 'review.mjs']) {
    assert.match(packageScript, new RegExp(`scripts/${script.replace('.', '\\.')}`));
  }
  const archiveAudit = read('scripts/archive_audit.py');
  assert.match(archiveAudit, /"__pycache__"/);
  assert.match(archiveAudit, /"\.pyc"/);
});
check('lockfile matches package metadata and exact web-ext version', () => {
  assert.equal(lock.lockfileVersion, 3);
  assert.equal(lock.name, pkg.name);
  assert.equal(lock.version, pkg.version);
  assert.equal(lock.packages?.['']?.name, pkg.name);
  assert.equal(lock.packages?.['']?.version, pkg.version);
  assert.equal(lock.packages?.['']?.devDependencies?.['web-ext'], pkg.devDependencies['web-ext']);
  assert.equal(lock.packages?.['node_modules/web-ext']?.version, pkg.devDependencies['web-ext']);
  assert.match(lock.packages['node_modules/web-ext'].resolved, /^https:\/\/registry\.npmjs\.org\/web-ext\//);
  assert.doesNotMatch(read('package-lock.json'), /npmmirror/i);
});
check('package declares MIT', () => assert.equal(pkg.license, 'MIT'));
check('stable Gecko extension id is present', () => {
  assert.equal(manifest.browser_specific_settings.gecko.id, '{af9b8e49-7c4e-4d45-b902-4db62df2f74d}');
});
check('minimum Firefox version is 140+', () => {
  assert.ok(Number.parseFloat(manifest.browser_specific_settings.gecko.strict_min_version) >= 140);
});
check('AMO data declaration is exactly none', () => {
  assert.deepEqual(manifest.browser_specific_settings.gecko.data_collection_permissions, { required: ['none'] });
});
check('manifest does not declare authenticationInfo', () => {
  assert.deepEqual(objectKeyPaths(manifest, 'authenticationInfo'), []);
});
check('incognito execution is disabled', () => assert.equal(manifest.incognito, 'not_allowed'));
check('permissions are minimal and exact', () => assert.deepEqual(manifest.permissions, ['storage']));
check('host permission is limited to current ChatGPT origin', () => {
  assert.deepEqual(manifest.host_permissions, ['https://chatgpt.com/*']);
});
check('no background worker is requested', () => assert.equal(manifest.background, undefined));
check('extension page CSP is self-only', () => {
  assert.equal(
    manifest.content_security_policy.extension_pages,
    "script-src 'self'; object-src 'none'; base-uri 'none'",
  );
});
check('no broad or sensitive permission is requested', () => {
  const prohibited = ['activeTab', 'tabs', 'debugger', 'webRequest', 'webRequestBlocking', 'cookies', 'downloads', 'clipboardRead', 'clipboardWrite', 'nativeMessaging', '<all_urls>'];
  const combined = [...(manifest.permissions || []), ...(manifest.host_permissions || [])];
  for (const permission of prohibited) assert.ok(!combined.includes(permission), permission);
});
check('MAIN and ISOLATED content worlds are declared', () => {
  const worlds = manifest.content_scripts.map((entry) => entry.world).sort();
  assert.deepEqual(worlds, ['ISOLATED', 'MAIN']);
});
check('all content scripts run at document_start', () => {
  for (const item of manifest.content_scripts) assert.equal(item.run_at, 'document_start');
});
check('all content scripts match only chatgpt.com', () => {
  for (const item of manifest.content_scripts) assert.deepEqual(item.matches, ['https://chatgpt.com/*']);
});
check('all manifest-referenced files exist', () => {
  const references = [];
  for (const item of manifest.content_scripts) references.push(...(item.js || []), ...(item.css || []));
  references.push(manifest.action.default_popup, manifest.options_ui.page, ...Object.values(manifest.icons));
  for (const relative of references) assert.ok(existsSync(path.join(root, relative)), relative);
});
check('all required icon sizes exist', () => {
  for (const size of [16, 32, 48, 96, 128]) assert.ok(existsSync(path.join(root, `icons/icon${size}.png`)));
});

// Generic source safety.
check('no symlink exists in source tree', () => {
  for (const file of walk(root)) assert.ok(!lstatSync(file).isSymbolicLink(), file);
});
check('runtime JS has no eval', () => assert.doesNotMatch(allRuntimeText, /\beval\s*\(/));
check('runtime JS has no Function constructor', () => assert.doesNotMatch(allRuntimeText, /\bnew\s+Function\s*\(/));
check('runtime JS has no dynamic import', () => assert.doesNotMatch(allRuntimeText, /\bimport\s*\(/));
check('runtime JS has no remote executable loading', () => {
  assert.doesNotMatch(allRuntimeText, /importScripts\s*\(\s*["']https?:\/\//i);
  assert.doesNotMatch(allRuntimeText, /<script[^>]+src=["']https?:\/\//i);
});
check('runtime JS has no telemetry SDK or endpoint', () => {
  assert.doesNotMatch(allRuntimeText, /google-analytics|segment\.com|sentry\.io|mixpanel|posthog|amplitude\.com/i);
});
check('runtime JS has no console logging', () => {
  assert.doesNotMatch(allRuntimeText, /console\.(?:log|debug|info|warn|error)\s*\(/);
});
check('HTML contains no inline script bodies', () => {
  for (const file of htmlFiles) {
    assert.doesNotMatch(read(file), /<script(?![^>]*\bsrc=)[^>]*>[\s\S]*?<\/script>/i, file);
  }
});
check('HTML contains no inline event handlers', () => {
  for (const file of htmlFiles) assert.doesNotMatch(read(file), /\son[a-z]+\s*=/i, file);
});
check('HTML contains no remote images, styles, or scripts', () => {
  for (const file of htmlFiles) assert.doesNotMatch(read(file), /(?:src|href)=["']https?:\/\//i, file);
});

// Passive Credits boundary.
check('page hook does not access extension APIs', () => {
  assert.doesNotMatch(hook, /\b(?:browser|chrome)\.(?:runtime|storage|tabs|cookies|downloads|webRequest)/);
});
check('isolated bridge is the only storage writer', () => {
  assert.doesNotMatch(hook, /storage\.local/);
  assert.match(bridge, /storage\.local/);
});
check('no runtime code reads client bootstrap or extracts JWTs', () => {
  assert.doesNotMatch(allRuntimeText, /client-bootstrap|getBootstrapToken|bootstrapToken/i);
  assert.doesNotMatch(allRuntimeText, /[\w-]\{30,\}\\\.[\w-]\{30,\}\\\.[\w-]\{30,\}/);
});
check('no runtime code constructs an Authorization or Bearer credential', () => {
  assert.doesNotMatch(allRuntimeText, /Authorization\s*[:=]/i);
  assert.doesNotMatch(allRuntimeText, /Bearer\s+\$?\{/i);
});
check('runtime does not name private reset-credit identity or authentication fields', () => {
  assert.doesNotMatch(
    allRuntimeText,
    /\bauthenticationInfo\b|\bprofile_(?:user_id|image_url)\b|\bcredit_id\b|\bgranted_by\b/i,
  );
});
check('only the page hook names private Credits endpoints', () => {
  assert.match(hook, /\/backend-api\/wham\/usage/);
  assert.match(hook, /\/backend-api\/wham\/analytics\/daily-workspace-usage-counts/);
  assert.doesNotMatch([bridge, runtimeTexts['popup/popup.js'], dashboard].join('\n'), /\/backend-api\/wham\//);
});
check('Credits endpoints are observed only for GET requests', () => {
  assert.match(hook, /method === "GET" && path === "\/backend-api\/wham\/usage"/);
  assert.match(hook, /method === "GET" && path === "\/backend-api\/wham\/analytics\/daily-workspace-usage-counts"/);
  assert.match(hook, /method === "GET" && path === "\/backend-api\/wham\/rate-limit-reset-credits"/);
  assert.doesNotMatch(hook, /path === "\/backend-api\/wham\/rate-limit-reset-credits\/consume"/);
});
check('daily Credits capture rejects non-day grouping', () => {
  assert.match(hook, /!endpoint\.groupBy \|\| endpoint\.groupBy === "day"/);
});
check('page hook preserves the original fetch path', () => {
  assert.match(hook, /Reflect\.apply\(downstream, receiver \?\? globalThis, \[input, init\]\)/);
  assert.match(hook, /const clone = response\.clone\(\)/);
});
check('Credits capture has explicit byte limits', () => {
  assert.match(hook, /MAX_USAGE_BYTES = 1024 \* 1024/);
  assert.match(hook, /MAX_DAILY_BYTES = 4 \* 1024 \* 1024/);
  assert.match(hook, /readBoundedText/);
});
check('Credits observations use explicit sanitizers', () => {
  assert.match(core, /function sanitizeCreditObservation/);
  assert.match(core, /function sanitizeLimitWindow/);
  assert.match(core, /function sanitizeDailyRow/);
  assert.match(core, /function sanitizeResetCreditsPayload/);
  assert.match(core, /function sanitizeResetCreditsDetails/);
});
check('Credits sanitizer does not retain headers, credentials, or raw bodies', () => {
  const block = core.match(/function sanitizeCreditObservation[\s\S]*?\n  }\n\n/)?.[0] || '';
  assert.doesNotMatch(block, /authorization|cookie|bearer|headers\s*:|rawBody|responseText|email|name\s*:/i);
});
check('MAIN-to-ISOLATED page messages never use wildcard target origin', () => {
  assert.doesNotMatch(hook, /postMessage\([\s\S]{0,240}["']\*["']/);
});
check('isolated bridge validates source and origin', () => {
  assert.match(bridge, /event\.source !== window/);
  assert.match(bridge, /event\.origin !== location\.origin/);
});
check('passive capture is user-controllable', () => {
  assert.match(core, /captureCredits: true/);
  assert.match(hook, /preferences\.captureCredits/);
  assert.match(bridge, /if \(!settings\.captureCredits\) return/);
});
check('passive capture sessions are bounded', () => assert.match(bridge, /MAX_PASSIVE_SESSIONS = 4/));

// Credits estimation, references, visualization, and diagnostics.
check('community reference dataset is versioned', () => {
  assert.match(core, /COMMUNITY_REFERENCE_VERSION = "community-2026-q2-v1"/);
});
check('community references are explicitly unofficial', () => {
  assert.match(core, /并非 OpenAI 官方承诺/);
  assert.match(read('REFERENCE_BASELINES.md'), /不得称为官方额度、保证额度或代表性社区统计/);
});
check('embedded Plus, Pro 5x, and Pro 20x ranges are exact', () => {
  assert.match(core, /plus:[\s\S]*credits: 3750,[\s\S]*minCredits: 3500,[\s\S]*maxCredits: 4000/);
  assert.match(core, /pro5x:[\s\S]*credits: 18750,[\s\S]*minCredits: 17500,[\s\S]*maxCredits: 20000/);
  assert.match(core, /pro20x:[\s\S]*credits: 75000,[\s\S]*minCredits: 70000,[\s\S]*maxCredits: 80000/);
});
check('ambiguous Pro is not guessed as a tier', () => {
  assert.match(core, /pro_ambiguous/);
  assert.match(read('REFERENCE_BASELINES.md'), /不猜测 5x 或 20x/);
});
check('custom reference and threshold are bounded', () => {
  assert.match(core, /customReferenceCredits/);
  assert.match(core, /alertThresholdPercent: round\(clamp\([^\n]+5, 50\)/);
});
check('estimator uses same-cycle deltas', () => assert.match(core, /deltaCredits \/ \(deltaUsed \/ 100\)/));
check('estimator uses completed historical-cycle median', () => assert.match(core, /baselineQuotaCredits = median/));
check('reference comparison uses a dynamic threshold', () => {
  assert.match(core, /thresholdFraction = clamp\(thresholdPercent, 1, 90\) \/ 100/);
});
check('anomaly detection covers reversals and delayed reconciliation', () => {
  assert.match(core, /function detectCreditAnomalies/);
  assert.match(core, /usage_percent_reversal/);
  assert.match(core, /credit_total_reversal/);
  assert.match(core, /usage_increase_without_daily_delta/);
});
check('reset-aware analysis segments cycle and plan boundaries', () => {
  assert.match(core, /function classifyCycleTransition/);
  assert.match(core, /scheduled_reset/);
  assert.match(core, /early_reset/);
  assert.match(core, /window_rebased/);
  assert.match(core, /function analysisCycleKey/);
});
check('manual cycle markers are controlled local metadata only', () => {
  assert.match(core, /CYCLE_EVENT_TYPES = Object\.freeze\(\["manual_reset", "plan_change", "analysis_boundary"\]\)/);
  assert.match(core, /function sanitizeCycleEvent/);
  assert.doesNotMatch(core.match(/function sanitizeCycleEvent[\s\S]*?\n  }/)?.[0] || '', /note|description|comment|text/i);
  assert.match(dashboard, /markCycleEvent/);
});
check('new-cycle comparison guard is present', () => {
  assert.match(core, /comparisonEligible/);
  assert.match(core, /boundaryDayAmbiguous/);
  assert.match(core, /status: "provisional"/);
});
check('historical baseline prefers within-cycle deltas and filters incompatible contexts', () => {
  assert.match(core, /deltaCredits \/ \(deltaUsed \/ 100\)/);
  assert.match(core, /compatiblePlan/);
  assert.match(core, /compatibleWindow/);
  assert.match(core, /baselineDeltaCycles/);
});
check('reset timeline UI and manual boundary controls exist', () => {
  assert.match(read('dashboard/dashboard.html'), /RESET AWARENESS/);
  assert.match(read('dashboard/dashboard.html'), /cycleEventType/);
  assert.match(dashboard, /renderCycleTransitions/);
});
check('quota time-series chart accepts a single point', () => {
  assert.match(dashboard, /function drawQuotaChart/);
  assert.match(dashboard, /if \(points\.length === 0\)/);
  assert.doesNotMatch(dashboard, /drawQuotaChart[\s\S]{0,800}points\.length < 2/);
});
check('cycle chart accepts a single point', () => {
  assert.match(dashboard, /function drawCycleChart/);
  assert.match(dashboard, /r: points\.length === 1 \? 6 : 5/);
});
check('daily Credits chart is implemented', () => {
  assert.match(dashboard, /function drawDailyChart/);
  assert.match(dashboard, /report\?\.dailyRows/);
});
check('charts include reference and personal baseline guides', () => {
  assert.match(dashboard, /reference-band/);
  assert.match(dashboard, /baselineQuotaCredits/);
});

// Route privacy and bounded parsing.
check('route sanitizer has an explicit output object', () => {
  assert.match(core, /function sanitizeRouteObservation[\s\S]*const sanitized = \{/);
});
check('route sanitizer excludes prompt, answer, content, and attachments', () => {
  const block = core.match(/function sanitizeRouteObservation[\s\S]*?return sanitized;\n  }/)?.[0] || '';
  assert.doesNotMatch(block, /\bprompt\s*:|\banswer\s*:|\bcontent\s*:|attachment|file_name/i);
});
check('route parser enforces payload and pending-capture limits', () => {
  assert.match(hook, /MAX_STREAM_EVENT_BYTES/);
  assert.match(hook, /MAX_ROUTE_RECORD_BYTES/);
  assert.match(hook, /MAX_PENDING = 32/);
});
check('route inspection is user-controllable', () => {
  assert.match(core, /routeInspection: true/);
  assert.match(hook, /preferences\.routeInspection/);
});
check('snapshot retention is bounded', () => assert.match(bridge, /MAX_SNAPSHOTS = 500/));
check('route retention is bounded', () => assert.match(bridge, /MAX_ROUTE_OBSERVATIONS = 200/));

// Documentation, provenance, and release instructions.
check('privacy notice states passive no-token behavior', () => {
  const privacy = read('PRIVACY.md');
  assert.match(privacy, /不会把任何用户数据传输到本地浏览器之外/);
  assert.match(privacy, /读取或保存 Cookie、Bearer Token/);
  assert.match(privacy, /主动调用 `\/backend-api\/wham\/\*`/);
});
check('security document states the MAIN-world trust boundary', () => {
  assert.match(read('SECURITY.md'), /页面 MAIN world 本身不可信/);
});
check('baseline document includes official multiplier and anecdotal-source URLs', () => {
  const references = read('REFERENCE_BASELINES.md');
  assert.match(references, /developers\.openai\.com\/codex\/pricing/);
  assert.match(references, /github\.com\/openai\/codex\/issues\/26512/);
});
check('upstream MIT notice is preserved', () => {
  assert.match(read('THIRD_PARTY_NOTICES.md'), /Copyright \(c\) 2026 Jun Zhao[\s\S]*Permission is hereby granted/);
});
check('route clean-room provenance is documented', () => {
  assert.match(read('THIRD_PARTY_NOTICES.md'), /does not copy, translate, bundle, or derive source code/);
});
check('installation document distinguishes temporary, signed, and unsigned installation', () => {
  const installation = read('INSTALL.md');
  assert.match(installation, /about:debugging/);
  assert.match(installation, /Mozilla Add-ons（AMO）安装签名版本/);
  assert.match(installation, /GitHub Release[\s\S]*未签名/);
});
check('changelog records removal of active token access', () => {
  assert.match(read('CHANGELOG.md'), /Bearer Token 读取/);
  assert.match(read('CHANGELOG.md'), /主动 `\/backend-api\/wham\/\*` 请求/);
});
check('CI uses read-only permissions and the complete verification chain', () => {
  const workflow = read('.github/workflows/ci.yml');
  assert.match(workflow, /^permissions:\n  contents: read$/m);
  assert.doesNotMatch(workflow, /contents:\s*write/);
  for (const command of ['npm ci', 'npm run check', 'npm run lint:addon', 'npm run package', 'npm run audit']) {
    assert.match(workflow, new RegExp(`run: ${command.replaceAll(' ', '\\s+')}`));
  }
  assertOfficialActionsPinned(workflow);
});
check('tag workflow creates only a draft unsigned GitHub release', () => {
  const workflow = read('.github/workflows/release.yml');
  assert.match(workflow, /tags:\n\s+- ["']v\*["']/);
  assert.match(workflow, /^\s{4}permissions:\n\s{6}contents: write$/m);
  assert.match(workflow, /GITHUB_REF_NAME/);
  assert.match(workflow, /manifest\.json/);
  assert.match(workflow, /package\.json/);
  assert.match(workflow, /gh release create/);
  assert.match(workflow, /--draft/);
  assert.match(workflow, /未签名|unsigned/i);
  assert.match(workflow, /AMO 签名版本/);
  assertOfficialActionsPinned(workflow);
});
check('automation has no AMO signing or secret integration', () => {
  const workflows = `${read('.github/workflows/ci.yml')}\n${read('.github/workflows/release.yml')}`;
  assert.doesNotMatch(workflows, /web-ext\s+sign|api\.addons\.mozilla\.org|AMO_(?:JWT|API|SECRET)|\bsecrets\./i);
});
check('all JavaScript files pass node --check', () => {
  const files = walk(root).filter((file) => /\.(?:js|mjs)$/.test(file));
  for (const file of files) {
    const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
    assert.equal(result.status, 0, `${path.relative(root, file)}\n${result.stderr}`);
  }
});
check('all JSON files parse', () => {
  for (const file of walk(root).filter((item) => item.endsWith('.json'))) {
    JSON.parse(readFileSync(file, 'utf8'));
  }
});

for (const result of checks) {
  process.stdout.write(`${result.ok ? 'PASS' : 'FAIL'}  ${result.name}${result.ok ? '' : ` — ${result.error}`}\n`);
}
const passed = checks.filter((item) => item.ok).length;
const failed = checks.length - passed;
process.stdout.write(`\nReview: ${passed}/${checks.length} passed, ${failed} failed.\n`);
if (failed > 0) process.exitCode = 1;
