import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const source = await readFile(new URL('../src/core.js', import.meta.url), 'utf8');
const context = vm.createContext({
  console,
  Date,
  Intl,
  JSON,
  Math,
  Number,
  Object,
  Array,
  Set,
  Map,
  RegExp,
  String,
  Boolean,
  URL,
  crypto: globalThis.crypto,
});
vm.runInContext(source, context, { filename: 'core.js' });
const Core = context.CodexCreditsWatchCore;

function weeklyUsage({ used = 25, reset = 1_778_000_000 } = {}) {
  return {
    rate_limit: {
      primary_window: {
        reset_at: reset - 6 * 24 * 60 * 60,
        limit_window_seconds: 5 * 60 * 60,
        used_percent: 15,
      },
      secondary_window: {
        reset_at: reset,
        limit_window_seconds: 7 * 24 * 60 * 60,
        used_percent: used,
      },
    },
  };
}

test('extracts nested limit windows and selects the weekly window', () => {
  const windows = Core.extractLimitWindows(weeklyUsage().rate_limit);
  assert.equal(windows.length, 2);
  const weekly = Core.selectWeeklyWindow(windows);
  assert.equal(weekly.key, 'secondary_window');
  assert.equal(weekly.durationDays, 7);
  assert.equal(weekly.usedPercent, 25);
  assert.equal(weekly.remainingPercent, 75);
});

test('normalizes daily data and aggregates token categories', () => {
  const rows = Core.normalizeDailyRows({ data: [
    { date: '2026-08-28', totals: { credits: 3.5, turns: 2, cached_text_input_tokens: 100, uncached_text_input_tokens: 50, text_output_tokens: 25 } },
    { date: '2026-08-29', totals: { credits: 1.5, turns: 1, text_total_tokens: 200, cached_text_input_tokens: 80, uncached_text_input_tokens: 20, text_output_tokens: 100 } },
  ] });
  const stats = Core.sumDailyRows(rows);
  assert.equal(stats.credits, 5);
  assert.equal(stats.turns, 3);
  assert.equal(stats.totalTokens, 375);
  assert.equal(stats.cachedInputTokens, 180);
  assert.equal(stats.cacheRatio, 0.72);
});

test('uses a low-confidence point estimate when no delta sample exists', () => {
  const estimate = Core.estimateCreditCapacity({
    capturedAt: '2026-08-30T12:00:00.000Z',
    cycleStart: '2026-08-25T00:00:00.000Z',
    resetAt: '2026-09-01T00:00:00.000Z',
    usedPercent: 10,
    cycleCredits: 12,
  }, []);
  assert.equal(estimate.impliedQuotaCredits, 120);
  assert.equal(estimate.ratioEstimateCredits, 120);
  assert.equal(estimate.deltaSampleCount, 0);
  assert.equal(estimate.confidence, 'low');
});

test('prefers same-cycle delta evidence and reaches medium confidence', () => {
  const estimate = Core.estimateCreditCapacity({
    capturedAt: '2026-08-30T12:00:00.000Z',
    cycleStart: '2026-08-25T00:00:00.000Z',
    resetAt: '2026-09-01T00:00:00.000Z',
    usedPercent: 50,
    cycleCredits: 50,
  }, [
    { capturedAt: '2026-08-29T10:00:00.000Z', cycleStart: '2026-08-25T00:00:00.000Z', resetAt: '2026-09-01T00:00:00.000Z', usedPercent: 20, cycleCredits: 20 },
  ]);
  assert.equal(estimate.deltaEstimateCredits, 100);
  assert.equal(estimate.impliedQuotaCredits, 100);
  assert.equal(estimate.deltaSampleCount, 1);
  assert.equal(estimate.confidence, 'medium');
});

test('flags a possible increase only after the 15 percent threshold and baseline evidence', () => {
  const estimate = Core.estimateCreditCapacity({
    capturedAt: '2026-08-30T12:00:00.000Z', cycleStart: '2026-08-25T00:00:00.000Z', resetAt: '2026-09-01T00:00:00.000Z', usedPercent: 50, cycleCredits: 50,
  }, [
    { capturedAt: '2026-08-29T10:00:00.000Z', cycleStart: '2026-08-25T00:00:00.000Z', resetAt: '2026-09-01T00:00:00.000Z', usedPercent: 20, cycleCredits: 20 },
    { capturedAt: '2026-08-23T20:00:00.000Z', cycleStart: '2026-08-18T00:00:00.000Z', resetAt: '2026-08-25T00:00:00.000Z', usedPercent: 80, cycleCredits: 64 },
  ]);
  assert.equal(estimate.baselineQuotaCredits, 80);
  assert.equal(estimate.changeFraction, 0.25);
  assert.equal(estimate.trend, 'possible_increase');
});

test('keeps a sub-threshold change in the stable range', () => {
  const estimate = Core.estimateCreditCapacity({
    capturedAt: '2026-08-30T12:00:00.000Z', cycleStart: '2026-08-25T00:00:00.000Z', resetAt: '2026-09-01T00:00:00.000Z', usedPercent: 50, cycleCredits: 50,
  }, [
    { capturedAt: '2026-08-29T10:00:00.000Z', cycleStart: '2026-08-25T00:00:00.000Z', resetAt: '2026-09-01T00:00:00.000Z', usedPercent: 20, cycleCredits: 20 },
    { capturedAt: '2026-08-23T20:00:00.000Z', cycleStart: '2026-08-18T00:00:00.000Z', resetAt: '2026-08-25T00:00:00.000Z', usedPercent: 90, cycleCredits: 85.5 },
  ]);
  assert.equal(estimate.baselineQuotaCredits, 95);
  assert.ok(Math.abs(estimate.changeFraction) < 0.15);
  assert.equal(estimate.trend, 'stable_range');
});

test('buildCreditReport excludes rows before the weekly cycle boundary', () => {
  const resetAt = Date.parse('2026-09-01T00:00:00.000Z') / 1000;
  const report = Core.buildCreditReport({
    usage: weeklyUsage({ used: 40, reset: resetAt }),
    dailyData: { data: [
      { date: '2026-08-24', totals: { credits: 99 } },
      { date: '2026-08-25', totals: { credits: 10 } },
      { date: '2026-08-26', totals: { credits: 20 } },
    ] },
    capturedAt: '2026-08-30T12:00:00.000Z',
    snapshots: [],
  });
  assert.equal(report.cycleStartDate, '2026-08-25');
  assert.equal(report.currentCycleStats.credits, 30);
  assert.equal(report.historyStats.credits, 99);
});

test('parses requested model without retaining prompt text', () => {
  const raw = JSON.stringify({
    model: 'gpt-5-6-pro',
    thinking_effort: 'high',
    conversation_id: 'conv-123',
    messages: [{ content: { parts: ['PRIVATE SECRET PROMPT'] } }],
  });
  const fields = Core.parseConversationRequest(raw);
  assert.equal(fields.requestedModel, 'gpt-5-6-pro');
  assert.equal(fields.thinkingEffort, 'high');
  assert.equal(fields.conversationId, 'conv-123');
  assert.doesNotMatch(JSON.stringify(fields), /PRIVATE SECRET PROMPT/);
});

test('parses SSE assistant, server, and resolved model fields', () => {
  const raw = [
    'data: {"type":"server_ste_metadata","metadata":{"model_slug":"gpt-5-5-mini","resolved_model_slug":"gpt-5-5-mini","request_id":"req-1"}}',
    'data: {"message":{"author":{"role":"assistant"},"metadata":{"model_slug":"gpt-5-6-pro"}}}',
    'data: [DONE]',
  ].join('\n');
  const fields = Core.parseSseResponse(raw);
  assert.equal(fields.serverModel, 'gpt-5-5-mini');
  assert.equal(fields.resolvedModel, 'gpt-5-5-mini');
  assert.equal(fields.assistantModel, 'gpt-5-6-pro');
  assert.equal(fields.requestId, 'req-1');
});

test('conversation record follows the current branch instead of an older assistant', () => {
  const record = {
    id: 'conv-current',
    current_node: 'assistant-new',
    mapping: {
      'assistant-old': { parent: null, message: { id: 'assistant-old', author: { role: 'assistant' }, metadata: { model_slug: 'old-model' } } },
      'user-new': { parent: null, message: { id: 'user-new', author: { role: 'user' }, metadata: {} } },
      'assistant-new': { parent: 'user-new', message: { id: 'assistant-new', author: { role: 'assistant' }, metadata: { model_slug: 'new-model', resolved_model_slug: 'new-route' } } },
    },
  };
  const fields = Core.parseResponseText(JSON.stringify(record));
  assert.equal(fields.assistantModel, 'new-model');
  assert.equal(fields.resolvedModel, 'new-route');
  assert.notEqual(fields.assistantModel, 'old-model');
});

test('route assessment distinguishes matches, differences, conflicts, and missing fields', () => {
  assert.equal(Core.routeAssessment({ requestedModel: 'gpt-5.6-pro', resolvedModel: 'gpt-5-6-pro' }).status, 'matched');
  assert.equal(Core.routeAssessment({ requestedModel: 'gpt-5-6-pro', resolvedModel: 'gpt-5-5-mini' }).status, 'different');
  assert.equal(Core.routeAssessment({ requestedModel: 'gpt-5-6-pro', resolvedModel: 'gpt-5-5-mini', serverModel: 'gpt-5-6-pro' }).status, 'field_conflict');
  assert.equal(Core.routeAssessment({ requestedModel: 'gpt-5-6-pro' }).status, 'insufficient');
});

test('sanitizer enforces a route-only allowlist', () => {
  const sanitized = Core.sanitizeRouteObservation({
    captureId: 'capture-1',
    source: 'page_fetch',
    phase: 'completed',
    observedAt: '2026-08-30T12:00:00.000Z',
    requestedModel: 'gpt-5-6-pro',
    resolvedModel: 'gpt-5-5-mini',
    prompt: 'SECRET_PROMPT',
    answer: 'SECRET_ANSWER',
    authorization: 'Bearer SECRET_TOKEN',
    evidence: [{ field: 'resolved_model_slug', value: 'gpt-5-5-mini', path: 'metadata.resolved_model_slug' }],
  });
  const serialized = JSON.stringify(sanitized);
  assert.match(serialized, /gpt-5-5-mini/);
  assert.doesNotMatch(serialized, /SECRET_PROMPT|SECRET_ANSWER|SECRET_TOKEN|authorization/);
});

test('merges requested and completed observations by capture id', () => {
  const requested = Core.sanitizeRouteObservation({
    captureId: 'capture-2', source: 'page_fetch', phase: 'requested', observedAt: '2026-08-30T12:00:00.000Z', requestedModel: 'gpt-5-6-pro',
  });
  const completed = Core.sanitizeRouteObservation({
    captureId: 'capture-2', source: 'page_fetch', phase: 'completed', observedAt: '2026-08-30T12:00:01.000Z', resolvedModel: 'gpt-5-5-mini',
  });
  const merged = Core.mergeRouteObservations(requested, completed);
  assert.equal(merged.phase, 'completed');
  assert.equal(merged.requestedModel, 'gpt-5-6-pro');
  assert.equal(merged.resolvedModel, 'gpt-5-5-mini');
  assert.equal(merged.assessment.status, 'different');
});

test('CSV exporter quotes cells and prepends UTF-8 BOM', () => {
  const csv = Core.rowsToCsv(['a', 'b'], [['plain', 'comma,value'], ['quote', '"value"']]);
  assert.ok(csv.startsWith('\uFEFF'));
  assert.match(csv, /"comma,value"/);
  assert.match(csv, /"""value"""/);
});


test('sanitizes passive credit observations to an explicit allowlist', () => {
  const observation = Core.sanitizeCreditObservation({
    kind: 'usage',
    sessionId: 'session-1',
    observedAt: '2026-08-30T12:00:00.000Z',
    pageUrl: 'https://chatgpt.com/codex/cloud/settings/analytics?secret=1',
    endpointPath: '/backend-api/wham/usage?secret=1',
    windows: [{
      key: 'secondary_window',
      label: 'secondary window',
      path: ['secondary_window'],
      usedPercent: 20,
      remainingPercent: 80,
      resetAt: '2026-09-01T00:00:00.000Z',
      cycleStart: '2026-08-25T00:00:00.000Z',
      durationSeconds: 7 * 24 * 60 * 60,
      rawSecret: 'SECRET',
    }],
    planHints: [{ planId: 'pro5x', raw: 'chatgpt_pro_5x', path: 'plan_type' }],
    token: 'SECRET_TOKEN',
    email: 'private@example.com',
  });
  assert.equal(observation.pageUrl, 'https://chatgpt.com/codex/cloud/settings/analytics');
  assert.equal(observation.endpointPath, '/backend-api/wham/usage');
  assert.equal(observation.windows[0].usedPercent, 20);
  assert.equal(observation.planHints[0].planId, 'pro5x');
  assert.doesNotMatch(JSON.stringify(observation), /SECRET|private@example\.com|token|email|rawSecret/i);
});

test('resolves community plan references and preserves their unofficial status', () => {
  const reference = Core.resolveCreditReference({ planSelection: 'pro5x', referenceMode: 'community' });
  assert.equal(reference.planId, 'pro5x');
  assert.equal(reference.referenceCredits, 18750);
  assert.equal(reference.rangeMinCredits, 17500);
  assert.equal(reference.rangeMaxCredits, 20000);
  assert.equal(reference.officialMultiplier, 5);
  assert.equal(reference.isOfficialAbsoluteLimit, false);
  assert.equal(reference.referenceVersion, 'community-2026-q2-v1');
  assert.match(reference.basis, /单一社区报告/);
  assert.match(reference.basis, /学生促销/);
  assert.match(reference.basis, /高度不确定/);

  const plus = Core.resolveCreditReference({ planSelection: 'plus', referenceMode: 'community' });
  const pro20x = Core.resolveCreditReference({ planSelection: 'pro20x', referenceMode: 'community' });
  assert.match(plus.basis, /二次倍率推导/);
  assert.match(pro20x.basis, /二次倍率推导/);
});

test('custom reference overrides the embedded community reference', () => {
  const reference = Core.resolveCreditReference({
    planSelection: 'pro5x',
    referenceMode: 'custom',
    customReferenceCredits: 12345,
    customReferenceLabel: 'My calibration',
  });
  assert.equal(reference.referenceMode, 'custom');
  assert.equal(reference.referenceCredits, 12345);
  assert.equal(reference.referenceLabel, 'My calibration');
  assert.equal(reference.referenceVersion, null);
});

test('auto plan detection refuses to guess between Pro 5x and Pro 20x', () => {
  const reference = Core.resolveCreditReference(
    { planSelection: 'auto', referenceMode: 'community' },
    [{ planId: 'pro_ambiguous', raw: 'chatgpt_pro', path: 'plan_type' }],
  );
  assert.equal(reference.planId, 'pro_ambiguous');
  assert.equal(reference.referenceCredits, null);
  assert.equal(reference.planSource, 'ambiguous_metadata');

  const conflicting = Core.resolveCreditReference(
    { planSelection: 'auto', referenceMode: 'community' },
    [
      { planId: 'pro5x', raw: 'chatgpt_pro_5x', path: 'workspace.plan_type' },
      { planId: 'pro_ambiguous', raw: 'chatgpt_pro', path: 'account.plan_type' },
    ],
  );
  assert.equal(conflicting.planId, null);
  assert.equal(conflicting.planSource, 'conflicting_metadata');
});

test('reference comparison uses the user-selected threshold', () => {
  const reference = Core.resolveCreditReference({ planSelection: 'plus', referenceMode: 'community' });
  assert.equal(Core.compareCreditReference(3150, reference, 15).status, 'below_reference');
  assert.equal(Core.compareCreditReference(3150, reference, 20).status, 'near_reference');
});

test('matches a captured report only when its reference context still equals current settings', () => {
  const unknownReference = Core.resolveCreditReference(
    { planSelection: 'auto', referenceMode: 'community' },
    [],
  );
  const report = {
    planHints: [],
    reference: unknownReference,
    referenceComparison: { thresholdFraction: 0.15 },
  };
  assert.equal(Core.creditReportMatchesSettings(report, {
    planSelection: 'auto',
    referenceMode: 'community',
    alertThresholdPercent: 15,
  }), true);
  assert.equal(Core.creditReportMatchesSettings(report, {
    planSelection: 'plus',
    referenceMode: 'community',
    alertThresholdPercent: 15,
  }), false);
  assert.equal(Core.creditReportMatchesSettings(report, {
    planSelection: 'auto',
    referenceMode: 'community',
    alertThresholdPercent: 20,
  }), false);

  const customSettings = {
    planSelection: 'plus',
    referenceMode: 'custom',
    customReferenceCredits: 4321,
    customReferenceLabel: '本机校准',
    alertThresholdPercent: 15,
  };
  const customReference = Core.resolveCreditReference(customSettings, []);
  assert.equal(Core.creditReportMatchesSettings({
    planHints: [],
    reference: customReference,
    referenceComparison: { thresholdFraction: 0.15 },
  }, customSettings), true);
  assert.equal(Core.creditReportMatchesSettings({
    planHints: [],
    reference: customReference,
    referenceComparison: { thresholdFraction: 0.15 },
  }, { ...customSettings, customReferenceCredits: 5000 }), false);
});

test('detects delayed reconciliation and same-cycle reversals without claiming causation', () => {
  const anomalies = Core.detectCreditAnomalies([
    { capturedAt: '2026-08-30T10:00:00.000Z', cycleStart: '2026-08-25T00:00:00.000Z', resetAt: '2026-09-01T00:00:00.000Z', usedPercent: 20, cycleCredits: 100, cycleTokens: 1000 },
    { capturedAt: '2026-08-30T11:00:00.000Z', cycleStart: '2026-08-25T00:00:00.000Z', resetAt: '2026-09-01T00:00:00.000Z', usedPercent: 22, cycleCredits: 100, cycleTokens: 1000 },
    { capturedAt: '2026-08-30T12:00:00.000Z', cycleStart: '2026-08-25T00:00:00.000Z', resetAt: '2026-09-01T00:00:00.000Z', usedPercent: 19, cycleCredits: 99, cycleTokens: 900 },
  ]);
  assert.ok(anomalies.some((item) => item.code === 'usage_increase_without_daily_delta'));
  assert.ok(anomalies.some((item) => item.code === 'usage_percent_reversal'));
  assert.ok(anomalies.some((item) => item.code === 'credit_total_reversal'));
  assert.ok(anomalies.every((item) => /可能|建议|通常|需要/.test(item.summary)));
  assert.doesNotMatch(JSON.stringify(anomalies), /Analytics/);
});

test('buildCreditReport accepts sanitized passive inputs and adds reference analysis', () => {
  const resetAt = Date.parse('2026-09-01T00:00:00.000Z') / 1000;
  const windows = Core.extractLimitWindows(weeklyUsage({ used: 20, reset: resetAt }).rate_limit);
  const report = Core.buildCreditReport({
    windows,
    dailyRows: Core.normalizeDailyRows({ data: [
      { date: '2026-08-25', totals: { credits: 100, text_total_tokens: 1000 } },
      { date: '2026-08-26', totals: { credits: 650, text_total_tokens: 2000 } },
    ] }),
    planHints: [{ planId: 'plus', raw: 'plus', path: 'plan_type' }],
    capturedAt: '2026-08-30T12:00:00.000Z',
    settings: { planSelection: 'auto', referenceMode: 'community', alertThresholdPercent: 15 },
    capture: { mode: 'passive', sessionId: 'session-2', dailyRowCount: 2 },
  });
  assert.equal(report.schemaVersion, 2);
  assert.equal(report.capture.mode, 'passive');
  assert.equal(report.reference.planId, 'plus');
  assert.equal(report.reference.referenceCredits, 3750);
  assert.equal(report.estimate.impliedQuotaCredits, 3750);
  assert.equal(report.referenceComparison.status, 'provisional');
  assert.equal(report.estimate.comparisonEligible, false);
});

test('settings normalization bounds user-controlled values', () => {
  const settings = Core.normalizeSettings({
    planSelection: 'not-a-plan',
    referenceMode: 'custom',
    customReferenceCredits: '123.4567',
    customReferenceLabel: '<script>',
    alertThresholdPercent: 999,
    captureCredits: false,
  });
  assert.equal(settings.planSelection, 'auto');
  assert.equal(settings.customReferenceCredits, 123.4567);
  assert.equal(settings.customReferenceLabel, '');
  assert.equal(settings.alertThresholdPercent, 50);
  assert.equal(settings.captureCredits, false);
});

test('classifies scheduled and early reset transitions without treating them as same-cycle reversals', () => {
  const scheduled = Core.classifyCycleTransition(
    { capturedAt: '2026-08-24T23:00:00.000Z', cycleStart: '2026-08-18T00:00:00.000Z', resetAt: '2026-08-25T00:00:00.000Z', durationSeconds: 7 * 86400, referencePlanId: 'pro5x' },
    { capturedAt: '2026-08-25T01:00:00.000Z', cycleStart: '2026-08-25T00:00:00.000Z', resetAt: '2026-09-01T00:00:00.000Z', durationSeconds: 7 * 86400, referencePlanId: 'pro5x' },
  );
  assert.equal(scheduled.type, 'scheduled_reset');

  const early = Core.classifyCycleTransition(
    { capturedAt: '2026-08-23T12:00:00.000Z', cycleStart: '2026-08-18T00:00:00.000Z', resetAt: '2026-08-25T00:00:00.000Z', durationSeconds: 7 * 86400, referencePlanId: 'pro5x' },
    { capturedAt: '2026-08-24T01:00:00.000Z', cycleStart: '2026-08-24T00:00:00.000Z', resetAt: '2026-08-31T00:00:00.000Z', durationSeconds: 7 * 86400, referencePlanId: 'pro5x' },
  );
  assert.equal(early.type, 'early_reset');
});

test('manual reset marker splits an otherwise unchanged server cycle', () => {
  const events = Core.normalizeCycleEvents([{
    id: 'manual-reset-1', type: 'manual_reset', observedAt: '2026-08-30T11:00:00.000Z', planId: 'pro5x', note: 'PRIVATE NOTE MUST NOT SURVIVE',
  }]);
  assert.doesNotMatch(JSON.stringify(events), /PRIVATE NOTE/);
  const estimate = Core.estimateCreditCapacity({
    capturedAt: '2026-08-30T12:00:00.000Z', cycleStart: '2026-08-25T00:00:00.000Z', resetAt: '2026-09-01T00:00:00.000Z', durationSeconds: 7 * 86400, referencePlanId: 'pro5x', usedPercent: 12, cycleCredits: 60,
  }, [
    { capturedAt: '2026-08-30T10:00:00.000Z', cycleStart: '2026-08-25T00:00:00.000Z', resetAt: '2026-09-01T00:00:00.000Z', durationSeconds: 7 * 86400, referencePlanId: 'pro5x', usedPercent: 40, cycleCredits: 200 },
  ], new Date('2026-08-30T12:00:00.000Z'), { analysisEvents: events });
  assert.equal(estimate.deltaSampleCount, 0);
  assert.equal(estimate.graceActive, true);
  assert.equal(estimate.comparisonEligible, false);
});

test('boundary-day point estimate stays provisional until a same-cycle delta is available', () => {
  const first = Core.estimateCreditCapacity({
    capturedAt: '2026-08-30T12:00:00.000Z', cycleStart: '2026-08-30T10:30:00.000Z', resetAt: '2026-09-06T10:30:00.000Z', durationSeconds: 7 * 86400, referencePlanId: 'plus', usedPercent: 10, cycleCredits: 500,
  }, [], new Date('2026-08-30T12:00:00.000Z'), { boundaryDayAmbiguous: true });
  assert.equal(first.impliedQuotaCredits, 5000);
  assert.equal(first.comparisonEligible, false);
  assert.equal(first.graceActive, true);

  const second = Core.estimateCreditCapacity({
    capturedAt: '2026-08-30T15:00:00.000Z', cycleStart: '2026-08-30T10:30:00.000Z', resetAt: '2026-09-06T10:30:00.000Z', durationSeconds: 7 * 86400, referencePlanId: 'plus', usedPercent: 20, cycleCredits: 875,
  }, [
    { capturedAt: '2026-08-30T12:00:00.000Z', cycleStart: '2026-08-30T10:30:00.000Z', resetAt: '2026-09-06T10:30:00.000Z', durationSeconds: 7 * 86400, referencePlanId: 'plus', usedPercent: 10, cycleCredits: 500 },
  ], new Date('2026-08-30T15:00:00.000Z'), { boundaryDayAmbiguous: true });
  assert.equal(second.deltaEstimateCredits, 3750);
  assert.equal(second.impliedQuotaCredits, 3750);
  assert.equal(second.comparisonEligible, true);
});

test('personal baseline excludes incompatible plan cycles after a plan switch', () => {
  const estimate = Core.estimateCreditCapacity({
    capturedAt: '2026-08-30T12:00:00.000Z', cycleStart: '2026-08-25T00:00:00.000Z', resetAt: '2026-09-01T00:00:00.000Z', durationSeconds: 7 * 86400, referencePlanId: 'pro20x', usedPercent: 50, cycleCredits: 500,
  }, [
    { capturedAt: '2026-08-29T10:00:00.000Z', cycleStart: '2026-08-25T00:00:00.000Z', resetAt: '2026-09-01T00:00:00.000Z', durationSeconds: 7 * 86400, referencePlanId: 'pro20x', usedPercent: 20, cycleCredits: 200 },
    { capturedAt: '2026-08-23T20:00:00.000Z', cycleStart: '2026-08-18T00:00:00.000Z', resetAt: '2026-08-25T00:00:00.000Z', durationSeconds: 7 * 86400, referencePlanId: 'pro5x', usedPercent: 80, cycleCredits: 80 },
    { capturedAt: '2026-08-16T20:00:00.000Z', cycleStart: '2026-08-11T00:00:00.000Z', resetAt: '2026-08-18T00:00:00.000Z', durationSeconds: 7 * 86400, referencePlanId: 'pro20x', usedPercent: 80, cycleCredits: 800 },
  ]);
  assert.equal(estimate.baselineQuotaCredits, 1000);
  assert.ok(estimate.excludedPlanCycles >= 1);
  assert.equal(estimate.trend, 'stable_range');
});

test('manual boundary prevents reversal diagnostics across the marked reset', () => {
  const anomalies = Core.detectCreditAnomalies([
    { capturedAt: '2026-08-30T10:00:00.000Z', cycleStart: '2026-08-25T00:00:00.000Z', resetAt: '2026-09-01T00:00:00.000Z', usedPercent: 80, cycleCredits: 800, cycleTokens: 8000 },
    { capturedAt: '2026-08-30T12:00:00.000Z', cycleStart: '2026-08-25T00:00:00.000Z', resetAt: '2026-09-01T00:00:00.000Z', usedPercent: 5, cycleCredits: 50, cycleTokens: 500 },
  ], { analysisEvents: [{ id: 'manual-reset-2', type: 'manual_reset', observedAt: '2026-08-30T11:00:00.000Z' }] });
  assert.equal(anomalies.length, 0);
});

test('historical baseline prefers within-cycle deltas to avoid reset-day carryover bias', () => {
  const estimate = Core.estimateCreditCapacity({
    capturedAt: '2026-08-30T12:00:00.000Z', cycleStart: '2026-08-25T10:30:00.000Z', resetAt: '2026-09-01T10:30:00.000Z', durationSeconds: 7 * 86400, referencePlanId: 'plus', usedPercent: 50, cycleCredits: 1875,
  }, [
    { capturedAt: '2026-08-29T10:00:00.000Z', cycleStart: '2026-08-25T10:30:00.000Z', resetAt: '2026-09-01T10:30:00.000Z', durationSeconds: 7 * 86400, referencePlanId: 'plus', boundaryDayAmbiguous: true, usedPercent: 20, cycleCredits: 750 },
    { capturedAt: '2026-08-23T10:00:00.000Z', cycleStart: '2026-08-18T10:30:00.000Z', resetAt: '2026-08-25T10:30:00.000Z', durationSeconds: 7 * 86400, referencePlanId: 'plus', boundaryDayAmbiguous: true, usedPercent: 20, cycleCredits: 500 },
    { capturedAt: '2026-08-24T20:00:00.000Z', cycleStart: '2026-08-18T10:30:00.000Z', resetAt: '2026-08-25T10:30:00.000Z', durationSeconds: 7 * 86400, referencePlanId: 'plus', boundaryDayAmbiguous: true, usedPercent: 80, cycleCredits: 2750 },
  ]);
  assert.equal(estimate.baselineQuotaCredits, 3750);
  assert.equal(estimate.baselineDeltaCycles, 1);
  assert.equal(estimate.baselinePointCycles, 0);
});

test('treats missing and known plan contexts as incomparable', () => {
  const estimate = Core.estimateCreditCapacity({
    capturedAt: '2026-08-30T12:00:00.000Z', cycleStart: '2026-08-25T00:00:00.000Z', resetAt: '2026-09-01T00:00:00.000Z', durationSeconds: 7 * 86400, referencePlanId: null, usedPercent: 50, cycleCredits: 500,
  }, [
    { capturedAt: '2026-08-29T10:00:00.000Z', cycleStart: '2026-08-25T00:00:00.000Z', resetAt: '2026-09-01T00:00:00.000Z', durationSeconds: 7 * 86400, referencePlanId: 'plus', usedPercent: 20, cycleCredits: 200 },
    { capturedAt: '2026-08-23T20:00:00.000Z', cycleStart: '2026-08-18T00:00:00.000Z', resetAt: '2026-08-25T00:00:00.000Z', durationSeconds: 7 * 86400, referencePlanId: 'plus', usedPercent: 80, cycleCredits: 800 },
  ]);
  assert.equal(estimate.deltaSampleCount, 0);
  assert.equal(estimate.baselineQuotaCredits, null);
  assert.ok(estimate.excludedPlanCycles >= 1);
});

test('treats the same cycle key with a changed plan as a protected transition', () => {
  const estimate = Core.estimateCreditCapacity({
    capturedAt: '2026-08-30T12:00:00.000Z', cycleStart: '2026-08-25T00:00:00.000Z', resetAt: '2026-09-01T00:00:00.000Z', durationSeconds: 7 * 86400, referencePlanId: 'pro5x', usedPercent: 40, cycleCredits: 400,
  }, [
    { capturedAt: '2026-08-30T10:00:00.000Z', cycleStart: '2026-08-25T00:00:00.000Z', resetAt: '2026-09-01T00:00:00.000Z', durationSeconds: 7 * 86400, referencePlanId: 'plus', usedPercent: 20, cycleCredits: 200 },
  ]);
  assert.equal(estimate.deltaSampleCount, 0);
  assert.equal(estimate.transition?.type, 'plan_change');
  assert.equal(estimate.graceActive, true);
  assert.equal(estimate.comparisonEligible, false);
});

test('treats a materially changed window as rebased even when cycleStart is unchanged', () => {
  const previous = {
    capturedAt: '2026-08-28T12:00:00.000Z',
    cycleStart: '2026-08-25T00:00:00.000Z',
    resetAt: '2026-09-01T00:00:00.000Z',
    durationSeconds: 7 * 86400,
    referencePlanId: 'plus',
    usedPercent: 10,
    cycleCredits: 100,
  };
  const current = {
    capturedAt: '2026-08-30T12:00:00.000Z',
    cycleStart: '2026-08-25T00:00:00.000Z',
    resetAt: '2026-09-08T00:00:00.000Z',
    durationSeconds: 14 * 86400,
    referencePlanId: 'plus',
    usedPercent: 20,
    cycleCredits: 300,
  };
  assert.equal(Core.classifyCycleTransition(previous, current)?.type, 'window_rebased');
  const estimate = Core.estimateCreditCapacity(current, [previous], new Date(current.capturedAt));
  assert.equal(estimate.deltaSampleCount, 0);
  assert.equal(estimate.transition?.type, 'window_rebased');
  assert.equal(estimate.comparisonEligible, false);
  assert.equal(Core.detectCreditAnomalies([
    previous,
    { ...current, usedPercent: 5, cycleCredits: 50 },
  ]).length, 0);
});

test('does not compare anomaly deltas across different or unknown plan contexts', () => {
  const base = { cycleStart: '2026-08-25T00:00:00.000Z', resetAt: '2026-09-01T00:00:00.000Z' };
  const differentPlans = Core.detectCreditAnomalies([
    { ...base, capturedAt: '2026-08-30T10:00:00.000Z', referencePlanId: 'plus', usedPercent: 80, cycleCredits: 800, cycleTokens: 8000 },
    { ...base, capturedAt: '2026-08-30T12:00:00.000Z', referencePlanId: 'pro5x', usedPercent: 5, cycleCredits: 50, cycleTokens: 500 },
  ]);
  assert.equal(differentPlans.length, 0);

  const unknownToKnown = Core.detectCreditAnomalies([
    { ...base, capturedAt: '2026-08-30T10:00:00.000Z', referencePlanId: null, usedPercent: 80, cycleCredits: 800, cycleTokens: 8000 },
    { ...base, capturedAt: '2026-08-30T12:00:00.000Z', referencePlanId: 'plus', usedPercent: 5, cycleCredits: 50, cycleTokens: 500 },
  ]);
  assert.equal(unknownToKnown.length, 0);
});

test('does not use global route plan metadata to infer a Credits reference', () => {
  const fromUsage = Core.resolveCreditReference(
    { planSelection: 'auto', referenceMode: 'community' },
    [{ planId: 'plus', raw: 'plus', path: 'plan_type' }],
    'chatgpt_pro_5x',
  );
  assert.equal(fromUsage.planId, 'plus');
  assert.equal(fromUsage.planSource, 'usage_metadata');

  const routeOnly = Core.resolveCreditReference(
    { planSelection: 'auto', referenceMode: 'community' },
    [],
    'chatgpt_pro_5x',
  );
  assert.equal(routeOnly.planId, null);
  assert.equal(routeOnly.planSource, 'unknown');
});

test('keeps valid limit windows when another window has an invalid reset timestamp', () => {
  const windows = Core.extractLimitWindows({
    primary_window: { reset_at: 1e20, limit_window_seconds: 5 * 60 * 60, used_percent: 5 },
    additional_rate_limits: [{
      rate_limit: { reset_at: 1_778_000_000, limit_window_seconds: 7 * 86400, used_percent: 20 },
    }],
  });
  assert.equal(windows.length, 2);
  assert.equal(windows.find((window) => window.key === 'primary_window').resetAt, null);
  assert.equal(Core.selectWeeklyWindow(windows).durationDays, 7);
});

test('does not relabel a short limit window as weekly usage', () => {
  const windows = Core.extractLimitWindows({
    primary_window: { reset_at: 1_778_000_000, limit_window_seconds: 5 * 60 * 60, used_percent: 5 },
  });
  assert.equal(Core.selectWeeklyWindow(windows), null);
});

test('bounds additional limit and reset-credit array traversal', () => {
  const additional = Array.from({ length: 101 }, () => null);
  additional[100] = { rate_limit: { reset_at: 1_778_000_000, limit_window_seconds: 7 * 86400, used_percent: 20 } };
  assert.equal(Core.extractLimitWindows({ additional_rate_limits: additional }).length, 0);

  const credits = Array.from({ length: 101 }, () => ({ status: 'available', expires_at: null }));
  assert.equal(Core.extractResetCreditDetails({ credits }).nonExpiringObservedCount, 100);
});

test('sanitizes reset credit summary and details to the accepted minimal schema', () => {
  assert.equal(Core.STORAGE_KEYS.resetCreditsLatest, 'ccwResetCreditsLatestV1');
  const summary = Core.extractResetCreditSummary({
    rate_limit_reset_credits: { available_count: 2, user_id: 'user-secret', title: 'secret title' },
  });
  assert.equal(summary.availableCount, 2);
  assert.deepEqual(Object.keys(summary), ['availableCount']);

  const details = Core.extractResetCreditDetails({
    available_count: 3,
    credits: [
      { id: 'credit-secret-1', status: 'available', expires_at: '2026-09-02T12:00:00.000Z', title: 'secret title', grantor: 'secret grantor' },
      { id: 'credit-secret-2', status: 'available', expires_at: null },
      { id: 'credit-secret-3', status: 'consumed', expires_at: '2026-09-01T12:00:00.000Z' },
      { id: 'credit-secret-4', status: 'available', expires_at: 'invalid timestamp' },
      { id: 'credit-secret-5', expires_at: '2026-09-01T12:00:00.000Z' },
    ],
    authenticationInfo: { token: 'SECRET_TOKEN' },
  });
  assert.equal(details.availableCount, null);
  assert.equal(details.nearestExpiresAt, '2026-09-02T12:00:00.000Z');
  assert.equal(details.nonExpiringObservedCount, 1);
  assert.equal(details.detailsLoaded, true);
  assert.doesNotMatch(JSON.stringify(details), /credit-secret|title|grantor|authentication|token/i);

  const detailOnly = Core.extractResetCreditDetails({
    credits: [{ status: 'available', expires_at: '2026-09-04T12:00:00.000Z' }],
  });
  assert.equal(detailOnly.availableCount, null);
  assert.equal(detailOnly.nearestExpiresAt, '2026-09-04T12:00:00.000Z');
});

test('merges reset credit observations in either order and count zero clears expiry details', () => {
  const detailObservation = Core.sanitizeCreditObservation({
    kind: 'reset_credits',
    sessionId: 'session-reset',
    observedAt: '2026-08-30T12:00:00.000Z',
    endpointPath: '/backend-api/wham/rate-limit-reset-credits',
    availableCount: 2,
    nearestExpiresAt: '2026-09-02T12:00:00.000Z',
    nonExpiringObservedCount: 1,
    detailsLoaded: true,
    id: 'PRIVATE_ID',
    title: 'PRIVATE_TITLE',
  });
  assert.deepEqual(Object.keys(detailObservation).sort(), [
    'availableCount', 'detailsLoaded', 'endpointPath', 'kind', 'nearestExpiresAt',
    'nonExpiringObservedCount', 'observedAt', 'pageUrl', 'schemaVersion', 'sessionId',
  ].sort());

  let state = Core.mergeResetCreditsState(null, detailObservation);
  assert.equal(state.availableCount, null);
  assert.equal(state.nearestExpiresAt, '2026-09-02T12:00:00.000Z');
  assert.equal(state.detailsObservedAt, '2026-08-30T12:00:00.000Z');

  state = Core.mergeResetCreditsState(state, Core.sanitizeCreditObservation({
    kind: 'usage',
    sessionId: 'session-reset',
    observedAt: '2026-08-30T11:00:00.000Z',
    endpointPath: '/backend-api/wham/usage',
    windows: [],
    resetCredits: { availableCount: 2 },
  }));
  assert.equal(state.availableCount, 2);
  assert.equal(state.nearestExpiresAt, '2026-09-02T12:00:00.000Z');
  assert.equal(state.summaryObservedAt, '2026-08-30T11:00:00.000Z');

  state = Core.mergeResetCreditsState(state, Core.sanitizeCreditObservation({
    kind: 'usage',
    sessionId: 'session-reset',
    observedAt: '2026-08-30T12:05:00.000Z',
    endpointPath: '/backend-api/wham/usage',
    windows: [{ resetAt: '2026-09-01T00:00:00.000Z', durationSeconds: 7 * 86400, usedPercent: 20 }],
    resetCredits: { availableCount: 0, title: 'PRIVATE_TITLE' },
  }));
  assert.equal(state.availableCount, 0);
  assert.equal(state.nearestExpiresAt, null);
  assert.equal(state.nonExpiringObservedCount, 0);
  assert.equal(state.summaryObservedAt, '2026-08-30T12:05:00.000Z');

  state = Core.mergeResetCreditsState(state, detailObservation);
  assert.equal(state.availableCount, 0);
  assert.equal(state.nearestExpiresAt, null);
});

test('classifies reset credit expiry boundaries without decrementing the observed count', () => {
  const state = {
    availableCount: 2,
    nearestExpiresAt: '2026-09-06T12:00:00.000Z',
    detailsLoaded: true,
  };
  const warning = Core.classifyResetCreditsState(state, Date.parse('2026-08-30T12:00:00.000Z'));
  assert.equal(warning.status, 'warning');
  assert.equal(warning.detailsLoaded, true);
  assert.equal(warning.availableCount, 2);
  assert.equal(warning.remainingMs, 7 * 86400 * 1000);

  const danger = Core.classifyResetCreditsState(state, Date.parse('2026-09-03T12:00:00.000Z'));
  assert.equal(danger.status, 'danger');
  assert.equal(danger.availableCount, 2);
  assert.equal(danger.remainingMs, 72 * 60 * 60 * 1000);

  const stale = Core.classifyResetCreditsState(state, Date.parse('2026-09-07T12:00:00.000Z'));
  assert.equal(stale.status, 'stale');
  assert.equal(stale.availableCount, 2);

  const available = Core.classifyResetCreditsState(state, Date.parse('2026-08-29T12:00:00.000Z'));
  assert.equal(available.status, 'available');

  assert.equal(Core.classifyResetCreditsState({ availableCount: 0 }).status, 'none');
  assert.equal(Core.classifyResetCreditsState({ availableCount: 2, detailsLoaded: false }).status, 'count_only');
  assert.equal(Core.classifyResetCreditsState({ availableCount: 2, detailsLoaded: true, nonExpiringObservedCount: 1 }).status, 'non_expiring');
  assert.equal(Core.classifyResetCreditsState({ availableCount: 2, detailsLoaded: true }).status, 'details_without_expiry');
  assert.equal(Core.classifyResetCreditsState(null).status, 'unknown');
});
