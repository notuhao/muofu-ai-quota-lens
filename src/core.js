(function (global) {
  "use strict";

  const DAY_SECONDS = 24 * 60 * 60;
  const MAX_IDENTIFIER_LENGTH = 256;
  const MAX_EVIDENCE = 40;
  const MAX_CREDIT_ROWS = 400;
  const MAX_LIMIT_WINDOWS = 16;
  const MAX_RESET_CREDIT_DETAILS = 100;
  const MAX_ACCOUNT_LIMIT_ITEMS = 32;
  const COMMUNITY_REFERENCE_VERSION = "community-2026-q2-v1";
  const COMMUNITY_PLAN_REFERENCES = Object.freeze({
    plus: Object.freeze({
      planId: "plus",
      label: "Plus",
      officialMultiplier: 1,
      credits: 3750,
      minCredits: 3500,
      maxCredits: 4000,
      basis: "由单一社区报告结合学生促销换算所得的 Pro 5x 区间，再作二次倍率推导；证据有限且高度不确定。",
    }),
    pro5x: Object.freeze({
      planId: "pro5x",
      label: "Pro 5x",
      officialMultiplier: 5,
      credits: 18750,
      minCredits: 17500,
      maxCredits: 20000,
      basis: "单一社区报告结合学生促销 Credits 换算得到约 17,500–20,000；证据有限且高度不确定，并非 OpenAI 官方承诺。",
    }),
    pro20x: Object.freeze({
      planId: "pro20x",
      label: "Pro 20x",
      officialMultiplier: 20,
      credits: 75000,
      minCredits: 70000,
      maxCredits: 80000,
      basis: "由单一社区报告结合学生促销换算所得的 Pro 5x 区间，再作二次倍率推导；证据有限且高度不确定。",
    }),
  });
  const STORAGE_KEYS = Object.freeze({
    creditLatest: "ccwCreditLatestV1",
    usageLatest: "ccwUsageLatestV1",
    accountLimitsLatest: "ccwAccountLimitsLatestV1",
    creditSnapshots: "ccwCreditSnapshotsV1",
    captureStatus: "ccwCaptureStatusV2",
    routeObservations: "ccwRouteObservationsV1",
    cycleEvents: "ccwCycleEventsV1",
    resetCreditsLatest: "ccwResetCreditsLatestV1",
    settings: "ccwSettingsV1",
  });
  const DEFAULT_SETTINGS = Object.freeze({
    showOverlay: true,
    overlayCollapsed: false,
    captureCredits: true,
    routeInspection: true,
    planSelection: "auto",
    referenceMode: "community",
    customReferenceCredits: null,
    customReferenceLabel: "",
    alertThresholdPercent: 15,
  });
  const EMPTY_ROUTE_FIELDS = Object.freeze({
    requestedModel: null,
    assistantModel: null,
    serverModel: null,
    resolvedModel: null,
    defaultModel: null,
    thinkingEffort: null,
    fastConvo: null,
    requestedModelExperience: null,
    turnUseCase: null,
    turnMode: null,
    reasoningStatus: null,
    reasoningDurationSec: null,
    requestId: null,
    conversationId: null,
    planType: null,
    evidence: [],
  });

  function isRecord(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
  }
  function normalizeSettings(value) {
    const raw = isRecord(value) ? value : {};
    const planSelection = ["auto", "plus", "pro5x", "pro20x", "business", "enterprise", "edu", "custom"].includes(raw.planSelection)
      ? raw.planSelection
      : DEFAULT_SETTINGS.planSelection;
    const referenceMode = raw.referenceMode === "custom" ? "custom" : "community";
    const customCredits = Number(raw.customReferenceCredits);
    return {
      showOverlay: raw.showOverlay == null ? DEFAULT_SETTINGS.showOverlay : Boolean(raw.showOverlay),
      overlayCollapsed: raw.overlayCollapsed == null ? DEFAULT_SETTINGS.overlayCollapsed : Boolean(raw.overlayCollapsed),
      captureCredits: raw.captureCredits == null ? DEFAULT_SETTINGS.captureCredits : Boolean(raw.captureCredits),
      routeInspection: raw.routeInspection == null ? DEFAULT_SETTINGS.routeInspection : Boolean(raw.routeInspection),
      planSelection,
      referenceMode,
      customReferenceCredits: Number.isFinite(customCredits) && customCredits > 0 ? round(customCredits, 6) : null,
      customReferenceLabel: safeIdentifier(raw.customReferenceLabel, 96) || "",
      alertThresholdPercent: round(clamp(raw.alertThresholdPercent ?? 15, 5, 50), 1),
    };
  }


  function toNumber(value, fallback = 0) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  }

  function clamp(value, minimum, maximum) {
    return Math.min(maximum, Math.max(minimum, toNumber(value)));
  }

  function round(value, digits = 3) {
    const factor = 10 ** digits;
    return Math.round((toNumber(value) + Number.EPSILON) * factor) / factor;
  }

  function safeIdentifier(value, limit = MAX_IDENTIFIER_LENGTH) {
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    if (!trimmed || trimmed.length > limit) return null;
    if (!/^[\p{L}\p{N}._:/+\- ]+$/u.test(trimmed)) return null;
    return trimmed;
  }

  function safeId(value) {
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    if (!trimmed || trimmed.length > MAX_IDENTIFIER_LENGTH) return null;
    if (!/^[A-Za-z0-9._:/+\-]+$/.test(trimmed)) return null;
    return trimmed;
  }

  function safeIso(value) {
    if (typeof value !== "string" || value.length > 64) return null;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }

  function safeEpochSecondsIso(value) {
    const seconds = Number(value);
    if (!Number.isFinite(seconds) || seconds <= 0) return null;
    const date = new Date(seconds * 1000);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }

  function dateKey(dateLike) {
    const date = dateLike instanceof Date ? dateLike : new Date(dateLike);
    return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
  }

  function localDateKey(date = new Date()) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  function addDays(date, days) {
    const copy = new Date(date);
    copy.setDate(copy.getDate() + days);
    return copy;
  }

  function median(values) {
    const clean = values.filter(Number.isFinite).sort((left, right) => left - right);
    if (clean.length === 0) return null;
    const middle = Math.floor(clean.length / 2);
    return clean.length % 2 === 1
      ? clean[middle]
      : (clean[middle - 1] + clean[middle]) / 2;
  }

  function weightedMedian(samples) {
    const clean = samples
      .filter((sample) => Number.isFinite(sample.value) && sample.value > 0 && sample.weight > 0)
      .sort((left, right) => left.value - right.value);
    if (clean.length === 0) return null;
    const totalWeight = clean.reduce((sum, sample) => sum + sample.weight, 0);
    let running = 0;
    for (const sample of clean) {
      running += sample.weight;
      if (running >= totalWeight / 2) return sample.value;
    }
    return clean.at(-1).value;
  }

  function normalizeLimitWindow(value, path) {
    const usedPercent = value.used_percent != null
      ? clamp(value.used_percent, 0, 100)
      : value.remaining_percent != null
        ? clamp(100 - toNumber(value.remaining_percent), 0, 100)
        : null;
    const remainingPercent = value.remaining_percent != null
      ? clamp(value.remaining_percent, 0, 100)
      : usedPercent != null
        ? clamp(100 - usedPercent, 0, 100)
        : null;
    const resetAtSeconds = Number(value.reset_at);
    const durationSeconds = toNumber(value.limit_window_seconds, 0);
    const resetAt = safeEpochSecondsIso(resetAtSeconds);
    const cycleStart = resetAt && durationSeconds > 0
      ? safeEpochSecondsIso(resetAtSeconds - durationSeconds)
      : null;
    const pathText = path.join(".");
    return {
      key: pathText || "rate_limit",
      label: pathText.replaceAll("_", " ") || "rate limit",
      path: [...path],
      usedPercent,
      remainingPercent,
      resetAt,
      cycleStart,
      durationSeconds: durationSeconds || null,
      durationDays: durationSeconds ? round(durationSeconds / DAY_SECONDS, 3) : null,
      rawLimit: value.limit ?? null,
      rawUsed: value.used ?? null,
      rawRemaining: value.remaining ?? null,
    };
  }

  function extractLimitWindows(root) {
    const windows = [];
    const seen = new Set();
    const budget = { count: 0 };

    function visit(value, path = [], depth = 0) {
      if (depth > 12 || budget.count >= 5000) return;
      budget.count += 1;
      if (Array.isArray(value)) {
        for (let index = 0; index < value.length && index < 100 && budget.count < 5000; index += 1) {
          visit(value[index], [...path, index], depth + 1);
        }
        return;
      }
      if (!isRecord(value)) return;
      const looksLikeWindow = value.reset_at != null
        && value.limit_window_seconds != null
        && (value.used_percent != null
          || value.remaining_percent != null
          || value.limit != null
          || value.remaining != null);
      if (looksLikeWindow) {
        const key = path.join(".") || "rate_limit";
        if (!seen.has(key)) {
          seen.add(key);
          windows.push(normalizeLimitWindow(value, path));
        }
      }
      for (const [key, child] of Object.entries(value)) {
        if (child && typeof child === "object") visit(child, [...path, key], depth + 1);
      }
    }

    visit(root);
    return windows.sort((left, right) => {
      const duration = toNumber(right.durationSeconds) - toNumber(left.durationSeconds);
      return duration !== 0 ? duration : left.key.localeCompare(right.key);
    });
  }

  function extractUsageLimitWindows(root) {
    if (!isRecord(root)) return [];
    if (!isRecord(root.rate_limit)) return extractLimitWindows(root);
    return extractLimitWindows(root.rate_limit).map((window) => ({
      ...window,
      key: `rate_limit.${window.key}`,
      label: `rate limit ${window.label}`,
      path: ["rate_limit", ...(Array.isArray(window.path) ? window.path : [])],
    }));
  }

  function selectWeeklyWindow(windows) {
    if (!Array.isArray(windows) || windows.length === 0) return null;
    const weekly = windows.filter((window) => {
      const days = toNumber(window.durationDays, 0);
      return days >= 5 && days <= 9;
    });
    if (weekly.length === 0) return null;
    return weekly
      .map((window) => {
        const days = toNumber(window.durationDays, 0);
        const text = `${window.key} ${window.label}`.toLowerCase();
        let score = -Math.abs(days - 7) * 8;
        if (/week|weekly|7.?day/.test(text)) score += 40;
        if (/secondary/.test(text)) score += 18;
        if (/primary/.test(text)) score += 8;
        if (window.usedPercent != null) score += 5;
        if (window.cycleStart && window.resetAt) score += 4;
        return { window, score };
      })
      .sort((left, right) => right.score - left.score)[0]?.window ?? null;
  }

  function normalizePlanHint(value) {
    const raw = safeIdentifier(value, 96);
    if (!raw) return null;
    const compact = raw.toLowerCase().replace(/[^a-z0-9]+/g, "");
    if (!compact) return null;
    if (/pro.*20x|20x.*pro|pro20/.test(compact)) return "pro20x";
    if (/pro.*5x|5x.*pro|pro5/.test(compact)) return "pro5x";
    if (/chatgptplus|^plus$|personalplus/.test(compact)) return "plus";
    if (/business|team/.test(compact)) return "business";
    if (/enterprise/.test(compact)) return "enterprise";
    if (/education|^edu$/.test(compact)) return "edu";
    if (/chatgptpro|^pro$|personalpro/.test(compact)) return "pro_ambiguous";
    return null;
  }

  function extractPlanHints(root) {
    const hints = [];
    const seen = new Set();
    const budget = { count: 0 };
    const planKey = /^(?:plan|plan_type|plantype|subscription_plan|subscriptionplan|account_plan|accountplan|workspace_plan|workspaceplan|codex_plan|codexplan|product_plan|productplan)$/i;

    function add(value, path) {
      const raw = safeIdentifier(value, 96);
      const planId = normalizePlanHint(raw);
      if (!raw || !planId) return;
      const signature = `${planId}\u0000${raw}`;
      if (seen.has(signature) || hints.length >= 12) return;
      seen.add(signature);
      hints.push({
        planId,
        raw,
        path: path.slice(0, 10).map((item) => String(item).slice(0, 64)).join("."),
      });
    }

    function visit(value, path = [], depth = 0) {
      if (depth > 10 || budget.count >= 3000) return;
      budget.count += 1;
      if (Array.isArray(value)) {
        for (let index = 0; index < value.length && index < 100; index += 1) {
          visit(value[index], [...path, index], depth + 1);
        }
        return;
      }
      if (!isRecord(value)) return;
      for (const [key, child] of Object.entries(value)) {
        if (planKey.test(key) && typeof child === "string") add(child, [...path, key]);
        if (child && typeof child === "object") visit(child, [...path, key], depth + 1);
      }
    }

    visit(root);
    return hints;
  }

  function planLabel(planId) {
    return {
      plus: "Plus",
      pro5x: "Pro 5x",
      pro20x: "Pro 20x",
      pro_ambiguous: "Pro（未区分 5x/20x）",
      business: "Business",
      enterprise: "Enterprise",
      edu: "Edu",
      custom: "自定义套餐",
    }[planId] || "未识别";
  }

  function sanitizePlanSelection(value) {
    return ["auto", "plus", "pro5x", "pro20x", "business", "enterprise", "edu", "custom"].includes(value)
      ? value
      : "auto";
  }

  function resolveCreditReference(settings = {}, planHints = []) {
    const selection = sanitizePlanSelection(settings?.planSelection);
    const detected = [];
    for (const hint of Array.isArray(planHints) ? planHints : []) {
      const planId = normalizePlanHint(isRecord(hint) ? hint.raw || hint.planId : hint)
        || (isRecord(hint) && typeof hint.planId === "string" ? hint.planId : null);
      if (planId && !detected.includes(planId)) detected.push(planId);
    }
    let planId = selection === "auto" ? null : selection;
    let planSource = selection === "auto" ? "unknown" : "user";
    if (selection === "auto") {
      const exact = detected.filter((item) => ["plus", "pro5x", "pro20x", "business", "enterprise", "edu"].includes(item));
      const uniqueExact = [...new Set(exact)];
      const ambiguous = detected.includes("pro_ambiguous");
      if (uniqueExact.length === 1 && !ambiguous) {
        planId = uniqueExact[0];
        planSource = "usage_metadata";
      } else if (uniqueExact.length > 1 || (uniqueExact.length > 0 && ambiguous)) {
        planSource = "conflicting_metadata";
      } else if (ambiguous) {
        planId = "pro_ambiguous";
        planSource = "ambiguous_metadata";
      }
    }

    const community = planId ? COMMUNITY_PLAN_REFERENCES[planId] || null : null;
    const requestedMode = settings?.referenceMode === "custom" || planId === "custom"
      ? "custom"
      : "community";
    const customCredits = toNumber(settings?.customReferenceCredits, 0);
    let referenceMode = "none";
    let referenceCredits = null;
    let rangeMinCredits = null;
    let rangeMaxCredits = null;
    let referenceLabel = "未设置参考基准";
    if (requestedMode === "custom" && customCredits > 0) {
      referenceMode = "custom";
      referenceCredits = round(customCredits, 6);
      rangeMinCredits = referenceCredits;
      rangeMaxCredits = referenceCredits;
      referenceLabel = safeIdentifier(settings?.customReferenceLabel, 96) || "用户自定义校准";
    } else if (community) {
      referenceMode = "community";
      referenceCredits = community.credits;
      rangeMinCredits = community.minCredits;
      rangeMaxCredits = community.maxCredits;
      referenceLabel = `${community.label} 社区参考`;
    }

    return {
      planId,
      planLabel: planLabel(planId),
      planSource,
      detectedPlanHints: detected,
      officialMultiplier: community?.officialMultiplier ?? null,
      referenceMode,
      referenceCredits,
      rangeMinCredits,
      rangeMaxCredits,
      referenceLabel,
      referenceVersion: referenceMode === "community" ? COMMUNITY_REFERENCE_VERSION : null,
      basis: referenceMode === "community" ? community?.basis ?? null : "由用户在本机设置。",
      isOfficialAbsoluteLimit: false,
    };
  }

  function creditReportMatchesSettings(report, settings) {
    if (!isRecord(report?.reference) || !isRecord(report?.referenceComparison) || !isRecord(settings)) return false;
    const normalizedSettings = normalizeSettings(settings);
    const desired = resolveCreditReference(normalizedSettings, report.planHints);
    const stored = report.reference;
    const storedThreshold = Number(report.referenceComparison.thresholdFraction);
    const desiredThreshold = normalizedSettings.alertThresholdPercent / 100;
    return stored.planId === desired.planId
      && stored.planSource === desired.planSource
      && stored.referenceMode === desired.referenceMode
      && stored.referenceCredits === desired.referenceCredits
      && stored.referenceLabel === desired.referenceLabel
      && stored.referenceVersion === desired.referenceVersion
      && Number.isFinite(storedThreshold)
      && Math.abs(storedThreshold - desiredThreshold) < 1e-9;
  }

  function compareCreditReference(impliedQuotaCredits, reference, thresholdPercent = 15) {
    const estimate = toNumber(impliedQuotaCredits, 0);
    const target = toNumber(reference?.referenceCredits, 0);
    const thresholdFraction = clamp(thresholdPercent, 1, 90) / 100;
    if (estimate <= 0 || target <= 0) {
      return {
        status: "insufficient",
        ratio: null,
        differenceFraction: null,
        thresholdFraction,
        rangeStatus: "unknown",
      };
    }
    const ratio = estimate / target;
    const differenceFraction = ratio - 1;
    let status = "near_reference";
    if (differenceFraction <= -thresholdFraction) status = "below_reference";
    else if (differenceFraction >= thresholdFraction) status = "above_reference";
    const minimum = toNumber(reference?.rangeMinCredits, 0);
    const maximum = toNumber(reference?.rangeMaxCredits, 0);
    let rangeStatus = "unknown";
    if (minimum > 0 && maximum >= minimum) {
      if (estimate < minimum) rangeStatus = "below_range";
      else if (estimate > maximum) rangeStatus = "above_range";
      else rangeStatus = "inside_range";
    }
    return {
      status,
      ratio: round(ratio, 6),
      differenceFraction: round(differenceFraction, 6),
      thresholdFraction,
      rangeStatus,
    };
  }

  function sanitizePageUrl(value) {
    if (typeof value !== "string" || value.length > 2048) return null;
    try {
      const url = new URL(value);
      if (url.origin !== "https://chatgpt.com") return null;
      return `${url.origin}${url.pathname}`.slice(0, 512);
    } catch {
      return null;
    }
  }

  function sanitizeLimitWindow(window) {
    if (!isRecord(window)) return null;
    const usedPercent = window.usedPercent == null ? null : round(clamp(window.usedPercent, 0, 100), 6);
    const remainingPercent = window.remainingPercent == null
      ? usedPercent == null ? null : round(100 - usedPercent, 6)
      : round(clamp(window.remainingPercent, 0, 100), 6);
    const durationSeconds = toNumber(window.durationSeconds, 0);
    const cycleStart = safeIso(window.cycleStart);
    const resetAt = safeIso(window.resetAt);
    if (usedPercent == null && remainingPercent == null && !durationSeconds && !resetAt) return null;
    const path = Array.isArray(window.path)
      ? window.path.slice(0, 12).map((item) => String(item).slice(0, 64))
      : [];
    const fallbackKey = path.join(".") || "rate_limit";
    return {
      key: safeIdentifier(window.key, 256) || safeIdentifier(fallbackKey, 256) || "rate_limit",
      label: safeIdentifier(window.label, 256) || safeIdentifier(fallbackKey.replaceAll("_", " "), 256) || "rate limit",
      path,
      usedPercent,
      remainingPercent,
      resetAt,
      cycleStart,
      durationSeconds: durationSeconds > 0 ? Math.min(durationSeconds, 366 * DAY_SECONDS) : null,
      durationDays: durationSeconds > 0 ? round(durationSeconds / DAY_SECONDS, 6) : null,
    };
  }

  function sanitizeDailyRow(row) {
    if (!isRecord(row) || typeof row.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(row.date)) return null;
    const parsedDate = new Date(`${row.date}T00:00:00Z`);
    if (Number.isNaN(parsedDate.getTime()) || parsedDate.toISOString().slice(0, 10) !== row.date) return null;
    const bounded = (value) => round(Math.min(1e18, Math.max(0, toNumber(value))), 6);
    return {
      date: row.date,
      credits: bounded(row.credits),
      turns: bounded(row.turns),
      threads: bounded(row.threads),
      totalTokens: bounded(row.totalTokens),
      inputTokens: bounded(row.inputTokens),
      outputTokens: bounded(row.outputTokens),
      cachedInputTokens: bounded(row.cachedInputTokens),
      uncachedInputTokens: bounded(row.uncachedInputTokens),
    };
  }

  function sanitizePlanHintRecord(hint) {
    if (!isRecord(hint)) return null;
    const raw = safeIdentifier(hint.raw, 96);
    const planId = normalizePlanHint(raw) || safeIdentifier(hint.planId, 32);
    if (!raw || !planId || !["plus", "pro5x", "pro20x", "pro_ambiguous", "business", "enterprise", "edu"].includes(planId)) {
      return null;
    }
    return {
      planId,
      raw,
      path: typeof hint.path === "string" ? hint.path.slice(0, 768) : "",
    };
  }

  function normalizeAvailableCount(value) {
    return typeof value === "number" && Number.isInteger(value) && value >= 0
      ? Math.min(value, 1_000_000)
      : null;
  }

  function extractResetCreditSummary(root) {
    const count = normalizeAvailableCount(root?.rate_limit_reset_credits?.available_count);
    return count == null ? null : { availableCount: count };
  }

  function optionalBoolean(value) {
    return typeof value === "boolean" ? value : null;
  }

  function optionalPercent(value) {
    if (value == null || value === "") return null;
    const number = Number(value);
    return Number.isFinite(number) ? round(clamp(number, 0, 100), 6) : null;
  }

  function optionalNonNegativeNumber(value, maximum = 1e12) {
    if (value == null || value === "") return null;
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? Math.min(number, maximum) : null;
  }

  function normalizeRateLimitReachedType(value) {
    if (typeof value === "string") return safeIdentifier(value, 96);
    if (!isRecord(value)) return null;
    return safeIdentifier(value.type, 96)
      || safeIdentifier(value.kind, 96)
      || null;
  }

  function timestampIso(value) {
    if (typeof value === "number") return safeEpochSecondsIso(value);
    return safeIso(value);
  }

  function limitDescriptor(value, preferredKeys = []) {
    if (typeof value === "string") {
      const name = safeIdentifier(value, 128);
      return name ? { name } : null;
    }
    if (!isRecord(value)) return null;
    const keys = [...preferredKeys, "model_slug", "model", "slug", "feature_name", "feature", "name", "id"];
    let name = null;
    for (const key of keys) {
      name = safeIdentifier(value[key], 128);
      if (name) break;
    }
    const limit = optionalNonNegativeNumber(value.limit);
    const remaining = optionalNonNegativeNumber(value.remaining);
    const usedPercent = optionalPercent(value.usedPercent ?? value.used_percent);
    const resetAt = safeIso(value.resetAt)
      || timestampIso(value.resets_after)
      || timestampIso(value.reset_after)
      || timestampIso(value.reset_at);
    const available = optionalBoolean(value.available);
    const blocked = optionalBoolean(value.blocked);
    const limitReached = optionalBoolean(value.limitReached ?? value.limit_reached);
    const blockReason = safeIdentifier(value.blockReason ?? value.block_reason, 128);
    const usingDefaultModelSlug = safeIdentifier(value.usingDefaultModelSlug ?? value.using_default_model_slug, 128);
    if (!name && remaining == null && usedPercent == null && !resetAt
      && limit == null && available == null && blocked == null && limitReached == null
      && !blockReason && !usingDefaultModelSlug) return null;
    return {
      name,
      limit,
      remaining,
      usedPercent,
      resetAt,
      available,
      blocked,
      limitReached,
      blockReason,
      usingDefaultModelSlug,
    };
  }

  function sanitizeLimitDescriptors(values, preferredKeys = []) {
    if (!Array.isArray(values)) return [];
    return values.slice(0, MAX_ACCOUNT_LIMIT_ITEMS)
      .map((value) => limitDescriptor(value, preferredKeys))
      .filter(Boolean);
  }

  function extractAccountLimitSummary(root) {
    if (!isRecord(root)) return null;
    const rateLimit = isRecord(root.rate_limit) ? root.rate_limit : null;
    const primaryWindow = isRecord(rateLimit?.primary_window) ? rateLimit.primary_window : null;
    const modelUsage = [];
    if (isRecord(root.model_usage)) {
      for (const [modelSlugRaw, raw] of Object.entries(root.model_usage).slice(0, MAX_ACCOUNT_LIMIT_ITEMS)) {
        const modelSlug = safeIdentifier(modelSlugRaw, 128);
        if (!modelSlug || !isRecord(raw)) continue;
        modelUsage.push({
          modelSlug,
          available: optionalBoolean(raw.available),
          availableAt: safeIso(raw.available_at),
          creditsWouldEnable: optionalBoolean(raw.credits_would_enable),
        });
      }
    }
    return {
      allowed: optionalBoolean(rateLimit?.allowed),
      limitReached: optionalBoolean(rateLimit?.limit_reached),
      primaryUsedPercent: optionalPercent(primaryWindow?.used_percent),
      primaryResetAt: safeEpochSecondsIso(primaryWindow?.reset_at),
      primaryWindowSeconds: optionalNonNegativeNumber(primaryWindow?.limit_window_seconds, 366 * DAY_SECONDS),
      rateLimitReachedType: normalizeRateLimitReachedType(root.rate_limit_reached_type),
      overageLimitReached: optionalBoolean(root.credits?.overage_limit_reached),
      spendControlReached: optionalBoolean(root.spend_control?.reached),
      modelUsage,
    };
  }

  function extractConversationLimitSummary(root) {
    if (!isRecord(root) || root.type !== "conversation_detail_metadata") return null;
    const blockedFeatures = sanitizeLimitDescriptors(root.blocked_features, ["feature_name"]);
    const modelLimits = sanitizeLimitDescriptors(root.model_limits, ["model_slug"]);
    const limitsProgress = sanitizeLimitDescriptors(root.limits_progress, ["feature_name"]);
    return {
      blockedFeatures,
      modelLimits,
      limitsProgress,
      defaultModelSlug: safeIdentifier(root.default_model_slug, 128),
      intendedDefaultModelSlug: safeIdentifier(root.intended_default_model_slug, 128),
    };
  }

  function sanitizeAccountLimitObservation(observation) {
    if (!isRecord(observation)) return null;
    const kind = ["usage_limits", "conversation_limits"].includes(observation.kind) ? observation.kind : null;
    const sessionId = safeId(observation.sessionId);
    if (!kind || !sessionId) return null;
    const base = {
      schemaVersion: 1,
      kind,
      sessionId,
      observedAt: safeIso(observation.observedAt) || new Date().toISOString(),
      pageUrl: sanitizePageUrl(observation.pageUrl),
      endpointPath: typeof observation.endpointPath === "string"
        ? observation.endpointPath.replace(/[?#].*$/, "").slice(0, 256)
        : null,
    };
    if (kind === "usage_limits") {
      const modelUsage = Array.isArray(observation.modelUsage)
        ? observation.modelUsage.slice(0, MAX_ACCOUNT_LIMIT_ITEMS).map((item) => {
          if (!isRecord(item)) return null;
          const modelSlug = safeIdentifier(item.modelSlug, 128);
          if (!modelSlug) return null;
          return {
            modelSlug,
            available: optionalBoolean(item.available),
            availableAt: safeIso(item.availableAt),
            creditsWouldEnable: optionalBoolean(item.creditsWouldEnable),
          };
        }).filter(Boolean)
        : [];
      return {
        ...base,
        allowed: optionalBoolean(observation.allowed),
        limitReached: optionalBoolean(observation.limitReached),
        primaryUsedPercent: optionalPercent(observation.primaryUsedPercent),
        primaryResetAt: safeIso(observation.primaryResetAt),
        primaryWindowSeconds: optionalNonNegativeNumber(observation.primaryWindowSeconds, 366 * DAY_SECONDS),
        rateLimitReachedType: normalizeRateLimitReachedType(observation.rateLimitReachedType),
        overageLimitReached: optionalBoolean(observation.overageLimitReached),
        spendControlReached: optionalBoolean(observation.spendControlReached),
        modelUsage,
      };
    }
    return {
      ...base,
      blockedFeatures: sanitizeLimitDescriptors(observation.blockedFeatures, ["feature_name"]),
      modelLimits: sanitizeLimitDescriptors(observation.modelLimits, ["model_slug"]),
      limitsProgress: sanitizeLimitDescriptors(observation.limitsProgress, ["feature_name"]),
      defaultModelSlug: safeIdentifier(observation.defaultModelSlug, 128),
      intendedDefaultModelSlug: safeIdentifier(observation.intendedDefaultModelSlug, 128),
    };
  }

  function mergeAccountLimitState(existing, incoming) {
    const observation = sanitizeAccountLimitObservation(incoming);
    if (!observation) return isRecord(existing) ? existing : null;
    const current = isRecord(existing) ? existing : {};
    const usage = observation.kind === "usage_limits"
      ? observation
      : sanitizeAccountLimitObservation(current.usage);
    const conversation = observation.kind === "conversation_limits"
      ? observation
      : sanitizeAccountLimitObservation(current.conversation);
    const observedTimes = [usage?.observedAt, conversation?.observedAt].filter(Boolean).sort();
    return {
      schemaVersion: 1,
      usage: usage || null,
      conversation: conversation || null,
      updatedAt: observedTimes.at(-1) || observation.observedAt,
    };
  }

  function classifyAccountLimitState(state) {
    const usage = isRecord(state?.usage) ? state.usage : null;
    const conversation = isRecord(state?.conversation) ? state.conversation : null;
    const blockedFeatures = Array.isArray(conversation?.blockedFeatures) ? conversation.blockedFeatures : [];
    const modelLimits = Array.isArray(conversation?.modelLimits) ? conversation.modelLimits : [];
    const blockedModels = modelLimits.filter((item) => item?.blocked === true
      || item?.limitReached === true
      || item?.available === false);
    const limitsProgress = Array.isArray(conversation?.limitsProgress) ? conversation.limitsProgress : [];
    const exhaustedFeatures = limitsProgress.filter((item) => item?.remaining === 0);
    const hardLimit = usage?.allowed === false || usage?.limitReached === true;
    const rateLimitState = Boolean(usage?.rateLimitReachedType);
    const spendLimit = usage?.spendControlReached === true;
    const overageLimit = usage?.overageLimitReached === true;
    const capabilityLimited = blockedFeatures.length > 0
      || blockedModels.length > 0
      || exhaustedFeatures.length > 0;
    let status = "unknown";
    if (hardLimit) status = "hard_limit";
    else if (rateLimitState) status = "rate_limit_state";
    else if (spendLimit) status = "spend_limit";
    else if (overageLimit) status = "overage_limit";
    else if (capabilityLimited) status = "capability_limited";
    else if (usage || conversation) status = "clear";
    return {
      status,
      hardLimit,
      rateLimitState,
      spendLimit,
      overageLimit,
      capabilityLimited,
      allowed: usage?.allowed ?? null,
      limitReached: usage?.limitReached ?? null,
      primaryUsedPercent: usage?.primaryUsedPercent ?? null,
      primaryResetAt: usage?.primaryResetAt ?? null,
      rateLimitReachedType: usage?.rateLimitReachedType ?? null,
      overageLimitReached: usage?.overageLimitReached ?? null,
      spendControlReached: usage?.spendControlReached ?? null,
      blockedFeatures,
      modelLimits,
      blockedModels,
      limitsProgress,
      exhaustedFeatures,
      modelUsage: Array.isArray(usage?.modelUsage) ? usage.modelUsage : [],
      defaultModelSlug: conversation?.defaultModelSlug ?? null,
      intendedDefaultModelSlug: conversation?.intendedDefaultModelSlug ?? null,
      usageObservedAt: usage?.observedAt ?? null,
      conversationObservedAt: conversation?.observedAt ?? null,
    };
  }

  function extractResetCreditDetails(root) {
    if (!isRecord(root) || !Array.isArray(root.credits)) return null;
    const credits = root.credits;
    let nearestExpiresAt = null;
    let nonExpiringObservedCount = 0;
    for (let index = 0; index < credits.length && index < MAX_RESET_CREDIT_DETAILS; index += 1) {
      const credit = credits[index];
      if (!isRecord(credit)) continue;
      if (credit.status !== "available") continue;
      if (credit.expires_at == null) {
        nonExpiringObservedCount += 1;
        continue;
      }
      const expiresAt = safeIso(credit.expires_at);
      if (expiresAt && (!nearestExpiresAt || expiresAt < nearestExpiresAt)) nearestExpiresAt = expiresAt;
    }
    return {
      availableCount: null,
      nearestExpiresAt,
      nonExpiringObservedCount,
      detailsLoaded: true,
    };
  }

  function sanitizeResetCreditsPayload(value) {
    if (!isRecord(value)) return null;
    const availableCount = normalizeAvailableCount(value.availableCount);
    if (availableCount == null) return null;
    return { availableCount };
  }

  function sanitizeResetCreditsDetails(value) {
    if (!isRecord(value)) return null;
    const nearestExpiresAt = safeIso(value.nearestExpiresAt);
    const nonExpiringObservedCount = normalizeAvailableCount(value.nonExpiringObservedCount) ?? 0;
    if (!nearestExpiresAt && nonExpiringObservedCount === 0 && value.detailsLoaded !== true) return null;
    return {
      availableCount: null,
      nearestExpiresAt,
      nonExpiringObservedCount,
      detailsLoaded: value.detailsLoaded === true,
    };
  }

  function sanitizeCreditObservation(observation) {
    if (!isRecord(observation)) return null;
    const kind = ["usage", "daily", "reset_credits"].includes(observation.kind) ? observation.kind : null;
    const sessionId = safeId(observation.sessionId);
    if (!kind || !sessionId) return null;
    const base = {
      schemaVersion: 2,
      kind,
      sessionId,
      observedAt: safeIso(observation.observedAt) || new Date().toISOString(),
      pageUrl: sanitizePageUrl(observation.pageUrl),
      endpointPath: typeof observation.endpointPath === "string"
        ? observation.endpointPath.replace(/[?#].*$/, "").slice(0, 256)
        : null,
    };
    if (kind === "usage") {
      const windows = (Array.isArray(observation.windows) ? observation.windows : [])
        .map(sanitizeLimitWindow)
        .filter(Boolean)
        .slice(0, MAX_LIMIT_WINDOWS);
      const planHints = (Array.isArray(observation.planHints) ? observation.planHints : [])
        .map(sanitizePlanHintRecord)
        .filter(Boolean)
        .slice(0, 12);
      const resetCredits = sanitizeResetCreditsPayload(observation.resetCredits);
      if (windows.length === 0 && !resetCredits) return null;
      return { ...base, windows, planHints, ...(resetCredits ? { resetCredits } : {}) };
    }
    if (kind === "reset_credits") {
      const details = sanitizeResetCreditsDetails(observation);
      if (!details) return null;
      return { ...base, ...details };
    }
    const rows = (Array.isArray(observation.rows) ? observation.rows : [])
      .map(sanitizeDailyRow)
      .filter(Boolean)
      .sort((left, right) => left.date.localeCompare(right.date))
      .slice(-MAX_CREDIT_ROWS);
    if (rows.length === 0) return null;
    const groupBy = safeIdentifier(observation.groupBy, 32);
    return {
      ...base,
      rows,
      startDate: /^\d{4}-\d{2}-\d{2}$/.test(observation.startDate || "") ? observation.startDate : rows[0].date,
      endDate: /^\d{4}-\d{2}-\d{2}$/.test(observation.endDate || "") ? observation.endDate : rows.at(-1).date,
      groupBy,
    };
  }

  function normalizeResetCreditsState(value) {
    if (!isRecord(value)) return null;
    const availableCount = normalizeAvailableCount(value.availableCount);
    const nearestExpiresAt = safeIso(value.nearestExpiresAt);
    const nonExpiringObservedCount = normalizeAvailableCount(value.nonExpiringObservedCount) ?? 0;
    const summaryObservedAt = safeIso(value.summaryObservedAt);
    const detailsObservedAt = safeIso(value.detailsObservedAt);
    const detailsLoaded = value.detailsLoaded === true;
    if (availableCount == null && !summaryObservedAt && !detailsObservedAt && !detailsLoaded) return null;
    return {
      schemaVersion: 1,
      availableCount,
      nearestExpiresAt: availableCount === 0 ? null : nearestExpiresAt,
      nonExpiringObservedCount: availableCount === 0 ? 0 : nonExpiringObservedCount,
      summaryObservedAt,
      detailsObservedAt,
      detailsLoaded,
    };
  }

  function mergeResetCreditsState(previous, observation) {
    const current = normalizeResetCreditsState(previous) || {
      schemaVersion: 1,
      availableCount: null,
      nearestExpiresAt: null,
      nonExpiringObservedCount: 0,
      summaryObservedAt: null,
      detailsObservedAt: null,
      detailsLoaded: false,
    };
    const incoming = sanitizeCreditObservation(observation);
    if (!incoming || (incoming.kind !== "usage" && incoming.kind !== "reset_credits")) return current;
    const payload = incoming.kind === "usage" ? incoming.resetCredits : incoming;
    if (!payload || (incoming.kind === "usage" && payload.availableCount == null)) return current;
    const observedAt = incoming.observedAt;
    const next = { ...current };
    if (incoming.kind === "usage") {
      if (!next.summaryObservedAt || observedAt >= next.summaryObservedAt) {
        next.summaryObservedAt = observedAt;
        next.availableCount = payload.availableCount;
      }
    } else if (!next.detailsObservedAt || observedAt >= next.detailsObservedAt) {
      next.detailsObservedAt = observedAt;
      next.detailsLoaded = incoming.detailsLoaded === true;
      if (next.availableCount !== 0) {
        next.nearestExpiresAt = incoming.nearestExpiresAt;
        next.nonExpiringObservedCount = incoming.nonExpiringObservedCount;
      }
    }
    if (next.availableCount === 0) {
      next.nearestExpiresAt = null;
      next.nonExpiringObservedCount = 0;
    }
    return normalizeResetCreditsState(next);
  }

  function classifyResetCreditsState(rawState, now = Date.now()) {
    const state = normalizeResetCreditsState(rawState);
    const nowMs = now instanceof Date ? now.getTime() : Number(now);
    const availableCount = state?.availableCount ?? null;
    const nearestExpiresAt = state?.nearestExpiresAt ?? null;
    const nonExpiringObservedCount = state?.nonExpiringObservedCount ?? 0;
    let remainingMs = null;
    let status = "unknown";
    if (state) {
      if (availableCount === 0) status = "none";
      else if (!state.detailsLoaded) status = availableCount == null ? "unknown" : "count_only";
      else if (nearestExpiresAt) {
        remainingMs = new Date(nearestExpiresAt).getTime() - (Number.isFinite(nowMs) ? nowMs : Date.now());
        if (remainingMs <= 0) status = "stale";
        else if (remainingMs <= 72 * 60 * 60 * 1000) status = "danger";
        else if (remainingMs <= 7 * DAY_SECONDS * 1000) status = "warning";
        else status = "available";
      } else if (nonExpiringObservedCount > 0) status = "non_expiring";
      else status = "details_without_expiry";
    }
    return {
      status,
      availableCount,
      nearestExpiresAt,
      nonExpiringObservedCount,
      detailsLoaded: state?.detailsLoaded === true,
      remainingMs,
    };
  }

  function tokenStats(totals = {}) {
    const cachedInput = toNumber(totals.cached_text_input_tokens);
    const uncachedInput = toNumber(totals.uncached_text_input_tokens);
    const output = toNumber(totals.text_output_tokens);
    const total = toNumber(totals.text_total_tokens)
      || cachedInput + uncachedInput + output;
    const input = cachedInput + uncachedInput;
    return {
      total,
      input,
      output,
      cachedInput,
      uncachedInput,
      cacheRatio: input > 0 ? cachedInput / input : 0,
    };
  }

  function normalizeDailyRows(dailyData) {
    const source = Array.isArray(dailyData?.data)
      ? dailyData.data
      : Array.isArray(dailyData)
        ? dailyData
        : [];
    const rows = [];
    for (const item of source) {
      if (!isRecord(item) || typeof item.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(item.date)) {
        continue;
      }
      const totals = isRecord(item.totals) ? item.totals : item;
      const tokens = tokenStats(totals);
      rows.push({
        date: item.date,
        credits: Math.max(0, toNumber(totals.credits)),
        turns: Math.max(0, toNumber(totals.turns)),
        threads: Math.max(0, toNumber(totals.threads)),
        totalTokens: Math.max(0, tokens.total),
        inputTokens: Math.max(0, tokens.input),
        outputTokens: Math.max(0, tokens.output),
        cachedInputTokens: Math.max(0, tokens.cachedInput),
        uncachedInputTokens: Math.max(0, tokens.uncachedInput),
      });
    }
    return rows.sort((left, right) => left.date.localeCompare(right.date));
  }

  function sumDailyRows(rows) {
    const stats = (Array.isArray(rows) ? rows : []).reduce((sum, row) => {
      sum.credits += toNumber(row.credits);
      sum.turns += toNumber(row.turns);
      sum.threads += toNumber(row.threads);
      sum.totalTokens += toNumber(row.totalTokens);
      sum.inputTokens += toNumber(row.inputTokens);
      sum.outputTokens += toNumber(row.outputTokens);
      sum.cachedInputTokens += toNumber(row.cachedInputTokens);
      sum.uncachedInputTokens += toNumber(row.uncachedInputTokens);
      return sum;
    }, {
      credits: 0,
      turns: 0,
      threads: 0,
      totalTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      uncachedInputTokens: 0,
    });
    stats.cacheRatio = stats.inputTokens > 0
      ? stats.cachedInputTokens / stats.inputTokens
      : 0;
    return Object.fromEntries(Object.entries(stats).map(([key, value]) => [key, round(value, 6)]));
  }

  function compactCreditSnapshot(report) {
    return {
      schemaVersion: 2,
      capturedAt: safeIso(report?.capturedAt),
      cycleStart: safeIso(report?.weeklyWindow?.cycleStart),
      resetAt: safeIso(report?.weeklyWindow?.resetAt),
      durationSeconds: toNumber(report?.weeklyWindow?.durationSeconds, 0) || null,
      usedPercent: report?.weeklyWindow?.usedPercent == null
        ? null
        : round(clamp(report.weeklyWindow.usedPercent, 0, 100), 4),
      remainingPercent: report?.weeklyWindow?.remainingPercent == null
        ? null
        : round(clamp(report.weeklyWindow.remainingPercent, 0, 100), 4),
      cycleCredits: round(report?.currentCycleStats?.credits, 6),
      cycleTokens: round(report?.currentCycleStats?.totalTokens, 0),
      cycleTurns: round(report?.currentCycleStats?.turns, 0),
      impliedQuotaCredits: report?.estimate?.impliedQuotaCredits == null
        ? null
        : round(report.estimate.impliedQuotaCredits, 6),
      projectedCycleCredits: report?.estimate?.projectedCycleCredits == null
        ? null
        : round(report.estimate.projectedCycleCredits, 6),
      baselineQuotaCredits: report?.estimate?.baselineQuotaCredits == null
        ? null
        : round(report.estimate.baselineQuotaCredits, 6),
      confidence: safeIdentifier(report?.estimate?.confidence, 32),
      comparisonEligible: report?.estimate?.comparisonEligible !== false,
      boundaryDayAmbiguous: Boolean(report?.resetAwareness?.boundaryDayAmbiguous),
      transitionType: safeIdentifier(report?.resetAwareness?.transition?.type, 32),
      referencePlanId: safeIdentifier(report?.reference?.planId, 32),
      referencePlanSource: safeIdentifier(report?.reference?.planSource, 32),
      referenceMode: safeIdentifier(report?.reference?.referenceMode, 32),
      referenceCredits: report?.reference?.referenceCredits == null
        ? null
        : round(report.reference.referenceCredits, 6),
      referenceStatus: safeIdentifier(report?.referenceComparison?.status, 32),
      captureMode: report?.capture?.mode === "passive" ? "passive" : null,
    };
  }

  function cycleKey(sample) {
    return safeIso(sample?.cycleStart) || `${safeIso(sample?.resetAt) || "unknown"}:${toNumber(sample?.durationSeconds)}`;
  }

  const CYCLE_EVENT_TYPES = Object.freeze(["manual_reset", "plan_change", "analysis_boundary"]);

  function sanitizeCycleEvent(event) {
    if (!isRecord(event)) return null;
    const type = CYCLE_EVENT_TYPES.includes(event.type) ? event.type : null;
    const observedAt = safeIso(event.observedAt);
    if (!type || !observedAt) return null;
    const planId = ["plus", "pro5x", "pro20x", "business", "enterprise", "edu", "custom", "pro_ambiguous"].includes(event.planId)
      ? event.planId
      : null;
    return {
      id: safeId(event.id) || `event-${observedAt.replace(/[^0-9]/g, "")}`,
      type,
      observedAt,
      planId,
      source: "user",
    };
  }

  function normalizeCycleEvents(events) {
    const deduped = new Map();
    for (const item of Array.isArray(events) ? events : []) {
      const event = sanitizeCycleEvent(item);
      if (!event) continue;
      deduped.set(event.id, event);
    }
    return [...deduped.values()]
      .sort((left, right) => left.observedAt.localeCompare(right.observedAt))
      .slice(-100);
  }

  function latestBoundaryEventAt(capturedAt, events) {
    const at = safeIso(capturedAt);
    if (!at) return null;
    let latest = null;
    for (const event of normalizeCycleEvents(events)) {
      if (event.observedAt <= at) latest = event;
      else break;
    }
    return latest;
  }

  function analysisCycleKey(sample, events = []) {
    const base = cycleKey(sample);
    const boundary = latestBoundaryEventAt(sample?.capturedAt, events);
    return boundary ? `${base}|manual:${boundary.id}` : base;
  }

  function planContext(value) {
    return safeIdentifier(value, 32);
  }

  function compatiblePlan(left, right) {
    const a = planContext(left?.referencePlanId);
    const b = planContext(right?.referencePlanId);
    return (a == null && b == null) || (a != null && b != null && a === b);
  }

  function compatibleWindow(left, right) {
    const a = toNumber(left?.durationSeconds, 0);
    const b = toNumber(right?.durationSeconds, 0);
    if (!a || !b) return true;
    return Math.abs(a - b) / Math.max(a, b) <= 0.1;
  }

  function classifyCycleTransition(previous, current) {
    if (!previous || !current) return null;
    const previousPlan = planContext(previous.referencePlanId);
    const currentPlan = planContext(current.referencePlanId);
    const planChanged = previousPlan !== currentPlan;
    const previousStart = safeIso(previous.cycleStart);
    const currentStart = safeIso(current.cycleStart);
    const previousReset = safeIso(previous.resetAt);
    const currentReset = safeIso(current.resetAt);
    const previousDuration = toNumber(previous.durationSeconds, 0);
    const currentDuration = toNumber(current.durationSeconds, 0);
    const durationChanged = previousDuration > 0 && currentDuration > 0
      && Math.abs(previousDuration - currentDuration) / Math.max(previousDuration, currentDuration) > 0.1;
    const resetShiftMinutes = previousStart && currentStart && previousStart === currentStart && previousReset && currentReset
      ? (new Date(currentReset) - new Date(previousReset)) / 60_000
      : null;
    const resetBoundaryChanged = resetShiftMinutes != null && Math.abs(resetShiftMinutes) > 120;
    if (!planChanged
      && cycleKey(previous) === cycleKey(current)
      && !durationChanged
      && !resetBoundaryChanged) return null;
    let offsetMinutes = null;
    if (previousReset && currentStart) {
      offsetMinutes = (new Date(currentStart) - new Date(previousReset)) / 60_000;
    }
    let type = "cycle_change";
    let summary = "检测到新的额度周期；后续估计会与上一周期分开计算。";
    if (planChanged) {
      type = "plan_change";
      summary = `套餐上下文由 ${planLabel(previousPlan)} 变为 ${planLabel(currentPlan)}；旧套餐周期不会进入当前个人历史基线。`;
    } else if (durationChanged || resetBoundaryChanged || (offsetMinutes != null && offsetMinutes > 120)) {
      type = "window_rebased";
      summary = "额度窗口长度或起止时间发生重排；按新的独立周期处理，不与旧窗口做同周期增量计算。";
    } else if (offsetMinutes != null && Math.abs(offsetMinutes) <= 120) {
      type = "scheduled_reset";
      summary = "新周期起点与上一周期预定重置时间接近，按自然/计划重置处理。";
    } else if (offsetMinutes != null && offsetMinutes < -120) {
      type = "early_reset";
      summary = "新周期早于上一周期原定重置时间，可能对应主动重置、套餐变更或服务端重新分配窗口。";
    }
    return {
      type,
      observedAt: safeIso(current.capturedAt),
      previousAt: safeIso(previous.capturedAt),
      previousResetAt: previousReset,
      cycleStart: currentStart,
      offsetMinutes: offsetMinutes == null ? null : round(offsetMinutes, 2),
      previousPlanId: previousPlan,
      currentPlanId: currentPlan,
      summary,
      source: "inferred",
    };
  }

  function detectCycleTransitions(snapshots, cycleEvents = []) {
    const clean = (Array.isArray(snapshots) ? snapshots : [])
      .map((sample) => ({
        capturedAt: safeIso(sample?.capturedAt),
        cycleStart: safeIso(sample?.cycleStart),
        resetAt: safeIso(sample?.resetAt),
        durationSeconds: toNumber(sample?.durationSeconds, 0) || null,
        referencePlanId: safeIdentifier(sample?.referencePlanId, 32),
      }))
      .filter((sample) => sample.capturedAt)
      .sort((left, right) => left.capturedAt.localeCompare(right.capturedAt));
    const manual = normalizeCycleEvents(cycleEvents).map((event) => ({
      type: event.type === "manual_reset" ? "user_manual_reset" : event.type === "plan_change" ? "user_plan_change" : "user_boundary",
      observedAt: event.observedAt,
      currentPlanId: event.planId,
      summary: event.type === "manual_reset"
        ? "用户在本机标记了一次主动/手动额度重置；分析从该时间点开始新的本地周期段。"
        : event.type === "plan_change"
          ? "用户在本机标记了套餐切换；该时间点之前的周期不会用于当前套餐个人基线。"
          : "用户在本机标记了分析边界；前后快照不会作为同一周期的增量样本。",
      source: "user",
    }));
    const inferred = [];
    for (let index = 1; index < clean.length; index += 1) {
      const transition = classifyCycleTransition(clean[index - 1], clean[index]);
      if (transition) inferred.push(transition);
    }
    return [...inferred, ...manual]
      .sort((left, right) => String(left.observedAt).localeCompare(String(right.observedAt)))
      .slice(-100);
  }

  function pointEstimate(sample) {
    const used = toNumber(sample?.usedPercent, 0);
    const credits = toNumber(sample?.cycleCredits, 0);
    if (used < 1 || credits <= 0) return null;
    const estimate = credits / (used / 100);
    return Number.isFinite(estimate) && estimate > 0 ? estimate : null;
  }

  function estimateCreditCapacity(currentSample, historicalSnapshots, capturedAt = new Date(), options = {}) {
    const thresholdFraction = clamp(options?.thresholdPercent ?? 15, 1, 90) / 100;
    const analysisEvents = normalizeCycleEvents(options?.analysisEvents);
    const current = {
      ...currentSample,
      capturedAt: safeIso(currentSample?.capturedAt) || capturedAt.toISOString(),
      cycleStart: safeIso(currentSample?.cycleStart),
      resetAt: safeIso(currentSample?.resetAt),
      durationSeconds: toNumber(currentSample?.durationSeconds, 0) || null,
      referencePlanId: safeIdentifier(currentSample?.referencePlanId, 32),
      usedPercent: currentSample?.usedPercent == null ? null : clamp(currentSample.usedPercent, 0, 100),
      cycleCredits: Math.max(0, toNumber(currentSample?.cycleCredits)),
    };
    const currentKey = analysisCycleKey(current, analysisEvents);
    const history = (Array.isArray(historicalSnapshots) ? historicalSnapshots : [])
      .map((sample) => ({
        capturedAt: safeIso(sample?.capturedAt),
        cycleStart: safeIso(sample?.cycleStart),
        resetAt: safeIso(sample?.resetAt),
        durationSeconds: toNumber(sample?.durationSeconds, 0) || null,
        referencePlanId: safeIdentifier(sample?.referencePlanId, 32),
        boundaryDayAmbiguous: sample?.boundaryDayAmbiguous === true,
        usedPercent: sample?.usedPercent == null ? null : clamp(sample.usedPercent, 0, 100),
        cycleCredits: Math.max(0, toNumber(sample?.cycleCredits)),
      }))
      .filter((sample) => sample.capturedAt && sample.usedPercent != null)
      .sort((left, right) => left.capturedAt.localeCompare(right.capturedAt));

    const sameCycle = history.filter((sample) => analysisCycleKey(sample, analysisEvents) === currentKey
      && compatiblePlan(sample, current)
      && compatibleWindow(sample, current));
    const ratioEstimate = pointEstimate(current);
    const deltaSamples = [];
    for (const sample of sameCycle) {
      const deltaUsed = toNumber(current.usedPercent) - toNumber(sample.usedPercent);
      const deltaCredits = current.cycleCredits - sample.cycleCredits;
      if (deltaUsed < 0.5 || deltaCredits <= 0) continue;
      const value = deltaCredits / (deltaUsed / 100);
      if (!Number.isFinite(value) || value <= 0) continue;
      deltaSamples.push({
        value,
        weight: Math.max(0.5, Math.sqrt(deltaUsed)),
        deltaUsed,
        deltaCredits,
        spanHours: Math.max(0, (new Date(current.capturedAt) - new Date(sample.capturedAt)) / 3_600_000),
      });
    }
    const deltaEstimate = weightedMedian(deltaSamples);
    // Day-level usage buckets can include pre-reset activity from the boundary day.
    // Same-cycle deltas cancel that fixed offset, so once available they are preferred completely.
    const impliedQuotaCredits = deltaEstimate ?? ratioEstimate;

    const previousSnapshot = history.at(-1) || null;
    const inferredTransition = previousSnapshot ? classifyCycleTransition(previousSnapshot, current) : null;
    const latestManual = latestBoundaryEventAt(current.capturedAt, analysisEvents);
    const previousManual = previousSnapshot ? latestBoundaryEventAt(previousSnapshot.capturedAt, analysisEvents) : null;
    const manualBoundarySincePrevious = latestManual && latestManual.id !== previousManual?.id ? latestManual : null;
    const boundaryDayAmbiguous = Boolean(options?.boundaryDayAmbiguous);
    const newBoundary = Boolean(inferredTransition || manualBoundarySincePrevious);
    const comparisonEligible = Boolean(impliedQuotaCredits != null && (deltaEstimate != null || (!boundaryDayAmbiguous && !newBoundary)));

    const usedPercent = toNumber(current.usedPercent, 0);
    const longestSpan = Math.max(0, ...deltaSamples.map((sample) => sample.spanHours));
    let confidence = "none";
    const confidenceReasons = [];
    if (impliedQuotaCredits != null) {
      confidence = "low";
      confidenceReasons.push("存在可计算样本");
      if (boundaryDayAmbiguous && deltaEstimate == null) {
        confidenceReasons.push("周期边界日按日汇总可能包含重置前用量；等待第二个同周期快照后再用于比较");
      }
      if (newBoundary && deltaEstimate == null) {
        confidenceReasons.push("刚检测到周期/套餐边界，当前处于新周期保护期");
      }
      if (usedPercent >= 10) confidenceReasons.push("本周期已用比例达到 10% 以上");
      if (deltaSamples.length >= 1 && longestSpan >= 1) {
        confidence = "medium";
        confidenceReasons.push("存在同周期增量样本，已消除边界日固定偏移的主要影响");
      }
      if (usedPercent >= 20 && deltaSamples.length >= 2 && longestSpan >= 12) {
        confidence = "high";
        confidenceReasons.push("覆盖较高用量比例与多个时间点");
      } else if (confidence === "low" && usedPercent >= 20 && comparisonEligible) {
        confidence = "medium";
        confidenceReasons.push("单点比例已覆盖较高用量区间");
      }
    } else {
      confidenceReasons.push("已用比例或 Credits 不足，暂无法估计");
    }

    let elapsedFraction = null;
    let projectedCycleCredits = null;
    if (current.cycleStart && current.resetAt) {
      const start = new Date(current.cycleStart).getTime();
      const end = new Date(current.resetAt).getTime();
      const now = new Date(current.capturedAt).getTime();
      if (Number.isFinite(start) && Number.isFinite(end) && end > start) {
        elapsedFraction = clamp((now - start) / (end - start), 0, 1);
        if (elapsedFraction >= 0.02 && current.cycleCredits > 0) projectedCycleCredits = current.cycleCredits / elapsedFraction;
      }
    }

    const latestPlanBoundary = [...analysisEvents].reverse().find((event) => event.type === "plan_change" && event.observedAt <= current.capturedAt) || null;
    const cycleGroups = new Map();
    let excludedPlanCycles = 0;
    let excludedWindowCycles = 0;
    let excludedPrePlanBoundary = 0;
    for (const sample of history) {
      const key = analysisCycleKey(sample, analysisEvents);
      if (key === currentKey || key.startsWith("unknown")) continue;
      if (latestPlanBoundary && sample.capturedAt < latestPlanBoundary.observedAt) { excludedPrePlanBoundary += 1; continue; }
      if (!compatiblePlan(sample, current)) { excludedPlanCycles += 1; continue; }
      if (!compatibleWindow(sample, current)) { excludedWindowCycles += 1; continue; }
      const group = cycleGroups.get(key) || [];
      group.push(sample);
      cycleGroups.set(key, group);
    }
    const completedCycleEstimates = [];
    for (const [key, samples] of cycleGroups) {
      const ordered = [...samples].sort((left, right) => left.capturedAt.localeCompare(right.capturedAt));
      const byUsed = [...ordered].sort((left, right) => toNumber(left.usedPercent) - toNumber(right.usedPercent));
      const low = byUsed[0];
      const high = byUsed.at(-1);
      const deltaUsed = toNumber(high?.usedPercent) - toNumber(low?.usedPercent);
      const deltaCredits = toNumber(high?.cycleCredits) - toNumber(low?.cycleCredits);
      let estimate = null;
      let method = null;
      if (low !== high && deltaUsed >= 1 && deltaCredits > 0) {
        estimate = deltaCredits / (deltaUsed / 100);
        method = "delta";
      } else {
        const candidate = [...ordered].reverse().find((sample) => toNumber(sample.usedPercent) >= 5 && !sample.boundaryDayAmbiguous);
        estimate = candidate ? pointEstimate(candidate) : null;
        method = estimate == null ? null : "point";
      }
      if (!Number.isFinite(estimate) || estimate <= 0) continue;
      completedCycleEstimates.push({
        key,
        estimate,
        method,
        capturedAt: ordered.at(-1)?.capturedAt,
      });
    }
    const baselineCycleItems = completedCycleEstimates
      .sort((left, right) => String(right.capturedAt).localeCompare(String(left.capturedAt)))
      .slice(0, 6);
    const baselineQuotaCredits = median(baselineCycleItems.map((item) => item.estimate));
    const baselineCycles = baselineCycleItems.length;
    const baselineDeltaCycles = baselineCycleItems.filter((item) => item.method === "delta").length;
    const baselinePointCycles = baselineCycleItems.filter((item) => item.method === "point").length;

    let changeFraction = null;
    let trend = "insufficient";
    if (impliedQuotaCredits != null && baselineQuotaCredits != null && baselineQuotaCredits > 0) {
      changeFraction = impliedQuotaCredits / baselineQuotaCredits - 1;
      if (comparisonEligible && (confidence === "medium" || confidence === "high") && baselineCycles >= 1) {
        if (changeFraction <= -thresholdFraction) trend = "possible_decrease";
        else if (changeFraction >= thresholdFraction) trend = "possible_increase";
        else trend = "stable_range";
      }
    }

    return {
      impliedQuotaCredits: impliedQuotaCredits == null ? null : round(impliedQuotaCredits, 6),
      ratioEstimateCredits: ratioEstimate == null ? null : round(ratioEstimate, 6),
      deltaEstimateCredits: deltaEstimate == null ? null : round(deltaEstimate, 6),
      deltaSampleCount: deltaSamples.length,
      longestDeltaSpanHours: round(longestSpan, 2),
      confidence,
      confidenceReasons,
      comparisonEligible,
      graceActive: !comparisonEligible && impliedQuotaCredits != null,
      boundaryDayAmbiguous,
      transition: inferredTransition,
      manualBoundary: manualBoundarySincePrevious,
      elapsedPercent: elapsedFraction == null ? null : round(elapsedFraction * 100, 3),
      projectedCycleCredits: projectedCycleCredits == null ? null : round(projectedCycleCredits, 6),
      baselineQuotaCredits: baselineQuotaCredits == null ? null : round(baselineQuotaCredits, 6),
      baselineCycles,
      baselineDeltaCycles,
      baselinePointCycles,
      excludedPlanCycles,
      excludedWindowCycles,
      excludedPrePlanBoundary,
      changeFraction: changeFraction == null ? null : round(changeFraction, 6),
      trend,
      thresholdFraction,
      method: "same-cycle delta preferred; ratio shown provisionally across date-bucket reset boundaries; compatible-plan/window historical median baseline",
    };
  }

  function applyCreditReference(report, settings = {}) {
    if (!isRecord(report)) return report;
    const reference = resolveCreditReference(settings, report.planHints);
    const rawReferenceComparison = compareCreditReference(
      report.estimate?.impliedQuotaCredits,
      reference,
      settings?.alertThresholdPercent ?? 15,
    );
    const referenceComparison = report.estimate?.comparisonEligible === false && rawReferenceComparison.status !== "insufficient"
      ? { ...rawReferenceComparison, status: "provisional" }
      : rawReferenceComparison;
    const usedPercent = toNumber(report.weeklyWindow?.usedPercent, 0);
    const referenceCredits = toNumber(reference.referenceCredits, 0);
    return {
      ...report,
      reference,
      referenceComparison: {
        ...referenceComparison,
        expectedCreditsAtObservedPercent: referenceCredits > 0 && usedPercent >= 0
          ? round(referenceCredits * usedPercent / 100, 6)
          : null,
        estimatedDifferenceCredits: referenceCredits > 0 && toNumber(report.estimate?.impliedQuotaCredits, 0) > 0
          ? round(toNumber(report.estimate.impliedQuotaCredits) - referenceCredits, 6)
          : null,
      },
    };
  }

  function detectCreditAnomalies(snapshots, options = {}) {
    const minimumGapMinutes = Math.max(5, toNumber(options.minimumGapMinutes, 30));
    const minimumUsedDelta = Math.max(0.1, toNumber(options.minimumUsedDelta, 1));
    const clean = (Array.isArray(snapshots) ? snapshots : [])
      .map((sample) => ({
        capturedAt: safeIso(sample?.capturedAt),
        cycleStart: safeIso(sample?.cycleStart),
        resetAt: safeIso(sample?.resetAt),
        durationSeconds: toNumber(sample?.durationSeconds, 0) || null,
        referencePlanId: safeIdentifier(sample?.referencePlanId, 32),
        usedPercent: sample?.usedPercent == null ? null : clamp(sample.usedPercent, 0, 100),
        cycleCredits: Math.max(0, toNumber(sample?.cycleCredits)),
        cycleTokens: Math.max(0, toNumber(sample?.cycleTokens)),
      }))
      .filter((sample) => sample.capturedAt && sample.usedPercent != null)
      .sort((left, right) => left.capturedAt.localeCompare(right.capturedAt));
    const anomalies = [];
    for (let index = 1; index < clean.length; index += 1) {
      const previous = clean[index - 1];
      const current = clean[index];
      if (analysisCycleKey(previous, options.analysisEvents) !== analysisCycleKey(current, options.analysisEvents)) continue;
      if (!compatiblePlan(previous, current)) continue;
      if (!compatibleWindow(previous, current)) continue;
      const gapMinutes = (new Date(current.capturedAt) - new Date(previous.capturedAt)) / 60_000;
      if (!Number.isFinite(gapMinutes) || gapMinutes <= 0) continue;
      const usedDelta = current.usedPercent - previous.usedPercent;
      const creditsDelta = current.cycleCredits - previous.cycleCredits;
      const tokensDelta = current.cycleTokens - previous.cycleTokens;
      const base = {
        observedAt: current.capturedAt,
        previousAt: previous.capturedAt,
        cycleStart: current.cycleStart,
        gapMinutes: round(gapMinutes, 2),
        usedDelta: round(usedDelta, 6),
        creditsDelta: round(creditsDelta, 6),
        tokensDelta: round(tokensDelta, 0),
      };
      if (usedDelta <= -1) {
        anomalies.push({
          ...base,
          code: "usage_percent_reversal",
          severity: "warning",
          summary: "同一周期的已用百分比出现回退；可能是接口修正、字段语义变化或暂时性不一致。",
        });
      }
      if (creditsDelta <= -0.05) {
        anomalies.push({
          ...base,
          code: "credit_total_reversal",
          severity: "warning",
          summary: "同一周期的累计 Credits 出现回退；建议稍后重新加载 Usage 页面复核。",
        });
      }
      if (gapMinutes >= minimumGapMinutes
        && usedDelta >= minimumUsedDelta
        && Math.abs(creditsDelta) <= 0.01
        && Math.abs(tokensDelta) <= 100) {
        anomalies.push({
          ...base,
          code: "usage_increase_without_daily_delta",
          severity: "notice",
          summary: "已用百分比增加，但被动捕获的每日 Credits/Tokens 尚未同步变化；这通常需要等待后台汇总后复核。",
        });
      }
      if (gapMinutes <= 15 && usedDelta >= 10) {
        anomalies.push({
          ...base,
          code: "abrupt_usage_jump",
          severity: "notice",
          summary: "短时间内已用百分比出现较大跃升；可能包含后台任务、延迟记账或批量汇总。",
        });
      }
    }
    return anomalies.slice(-50);
  }

  function buildCreditReport({
    usage,
    dailyData,
    windows: observedWindows,
    dailyRows: observedRows,
    planHints: observedPlanHints,
    capturedAt = new Date().toISOString(),
    snapshots = [],
    lookbackStart = null,
    lookbackEnd = null,
    pageUrl = null,
    settings = DEFAULT_SETTINGS,
    capture = null,
    analysisEvents = [],
  }) {
    const capturedIso = safeIso(capturedAt) || new Date().toISOString();
    const rateLimitRoot = isRecord(usage?.rate_limit) ? usage.rate_limit : usage;
    const rawWindows = Array.isArray(observedWindows)
      ? observedWindows
      : extractLimitWindows(isRecord(rateLimitRoot) ? rateLimitRoot : {});
    const windows = rawWindows.map(sanitizeLimitWindow).filter(Boolean).slice(0, MAX_LIMIT_WINDOWS);
    const weeklyWindow = selectWeeklyWindow(windows);
    const rawDailyRows = Array.isArray(observedRows) ? observedRows : normalizeDailyRows(dailyData);
    const dailyRows = rawDailyRows.map(sanitizeDailyRow).filter(Boolean).sort((left, right) => left.date.localeCompare(right.date)).slice(-MAX_CREDIT_ROWS);
    const cycleStartDate = dateKey(weeklyWindow?.cycleStart);
    const capturedDate = dateKey(capturedIso);
    const currentCycleRows = cycleStartDate
      ? dailyRows.filter((row) => row.date >= cycleStartDate && (!capturedDate || row.date <= capturedDate))
      : [];
    const historyRows = cycleStartDate
      ? dailyRows.filter((row) => row.date < cycleStartDate)
      : [...dailyRows];
    const currentCycleStats = sumDailyRows(currentCycleRows);
    const totalStats = sumDailyRows(dailyRows);
    const historyStats = sumDailyRows(historyRows);
    const rawPlanHints = Array.isArray(observedPlanHints) ? observedPlanHints : extractPlanHints(usage);
    const planHints = rawPlanHints.map(sanitizePlanHintRecord).filter(Boolean).slice(0, 12);
    const reference = resolveCreditReference(settings, planHints);
    const normalizedEvents = normalizeCycleEvents(analysisEvents);
    const boundaryDayAmbiguous = Boolean(cycleStartDate && currentCycleRows.some((row) => row.date === cycleStartDate));
    const currentSample = {
      capturedAt: capturedIso,
      cycleStart: weeklyWindow?.cycleStart ?? null,
      resetAt: weeklyWindow?.resetAt ?? null,
      durationSeconds: weeklyWindow?.durationSeconds ?? null,
      referencePlanId: reference.planId,
      usedPercent: weeklyWindow?.usedPercent ?? null,
      cycleCredits: currentCycleStats.credits,
    };
    const estimate = estimateCreditCapacity(currentSample, snapshots, new Date(capturedIso), {
      thresholdPercent: settings?.alertThresholdPercent ?? 15,
      boundaryDayAmbiguous,
      analysisEvents: normalizedEvents,
    });
    const safeCapture = isRecord(capture) ? {
      mode: capture.mode === "passive" ? "passive" : null,
      sessionId: safeId(capture.sessionId),
      usageObservedAt: safeIso(capture.usageObservedAt),
      dailyObservedAt: safeIso(capture.dailyObservedAt),
      dailyStartDate: /^\d{4}-\d{2}-\d{2}$/.test(capture.dailyStartDate || "") ? capture.dailyStartDate : null,
      dailyEndDate: /^\d{4}-\d{2}-\d{2}$/.test(capture.dailyEndDate || "") ? capture.dailyEndDate : null,
      dailyRowCount: Math.min(MAX_CREDIT_ROWS, Math.max(0, toNumber(capture.dailyRowCount))),
    } : { mode: "passive" };
    let report = {
      schemaVersion: 2,
      capturedAt: capturedIso,
      pageUrl: sanitizePageUrl(pageUrl),
      lookbackStart: /^\d{4}-\d{2}-\d{2}$/.test(lookbackStart || "") ? lookbackStart : dailyRows[0]?.date ?? null,
      lookbackEnd: /^\d{4}-\d{2}-\d{2}$/.test(lookbackEnd || "") ? lookbackEnd : dailyRows.at(-1)?.date ?? null,
      windows,
      weeklyWindow,
      cycleStartDate,
      currentCycleStats,
      historyStats,
      totalStats,
      currentCycleRows,
      historyRows,
      dailyRows,
      planHints,
      capture: safeCapture,
      resetAwareness: {
        boundaryDayAmbiguous,
        analysisCycleId: analysisCycleKey(currentSample, normalizedEvents),
        transition: estimate.transition,
        manualBoundary: estimate.manualBoundary,
        graceActive: estimate.graceActive,
        cycleEvents: normalizedEvents.slice(-20),
      },
      estimate,
      caveats: [
        "数据由扩展被动观察 ChatGPT Usage 页面自身发出的请求；扩展不会读取令牌或主动调用用量接口。",
        "被动捕获范围取决于页面实际加载的日期区间和私有接口字段，二者可能随时变化。",
        "额度估计把已用比例与 Credits 观测联系起来，不是 OpenAI 官方额度承诺。",
        "社区套餐参考是版本化的非官方经验值；低用量、取整、数据延迟和周期边界均可能显著影响比较。",
        "按日 Credits 在重置边界当天可能同时包含重置前后用量；插件会进入新周期保护期，优先等待同周期第二个快照再做额度比较。",
      ],
    };
    report = applyCreditReference(report, settings);
    const currentSnapshot = compactCreditSnapshot(report);
    report.anomalies = detectCreditAnomalies([...snapshots, currentSnapshot], { analysisEvents: normalizedEvents });
    report.cycleTransitions = detectCycleTransitions([...snapshots, currentSnapshot], normalizedEvents);
    return report;
  }

  function emptyRouteFields() {
    return { ...EMPTY_ROUTE_FIELDS, evidence: [] };
  }

  function pushEvidence(fields, field, value, path) {
    const safeValue = safeIdentifier(value);
    if (!safeValue || fields.evidence.length >= MAX_EVIDENCE) return;
    const safePath = Array.isArray(path)
      ? path.slice(0, 12).map((item) => String(item).slice(0, 64)).join(".")
      : "";
    const signature = `${field}\u0000${safeValue}\u0000${safePath}`;
    if (fields.evidence.some((item) => `${item.field}\u0000${item.value}\u0000${item.path}` === signature)) {
      return;
    }
    fields.evidence.push({ field, value: safeValue, path: safePath });
  }

  function assignRouteField(fields, key, value, path, evidenceName = key) {
    const safe = key === "requestId" || key === "conversationId"
      ? safeId(value)
      : safeIdentifier(value);
    if (!safe) return;
    fields[key] = safe;
    pushEvidence(fields, evidenceName, safe, path);
  }

  function assignRouteBoolean(fields, key, value, path, evidenceName = key) {
    if (typeof value !== "boolean") return;
    fields[key] = value;
    pushEvidence(fields, evidenceName, String(value), path);
  }

  function assignRouteNumber(fields, key, value, path, evidenceName = key, maximum = 24 * 60 * 60) {
    const number = Number(value);
    if (!Number.isFinite(number) || number < 0 || number > maximum) return;
    fields[key] = round(number, 3);
    pushEvidence(fields, evidenceName, String(fields[key]), path);
  }

  function mergeRouteFields(...items) {
    const merged = emptyRouteFields();
    for (const item of items) {
      if (!isRecord(item)) continue;
      for (const key of [
        "requestedModel",
        "assistantModel",
        "serverModel",
        "resolvedModel",
        "defaultModel",
        "thinkingEffort",
        "requestedModelExperience",
        "turnUseCase",
        "turnMode",
        "reasoningStatus",
        "requestId",
        "conversationId",
        "planType",
      ]) {
        if (item[key] != null) assignRouteField(merged, key, item[key], [], key);
      }
      if (typeof item.fastConvo === "boolean") {
        assignRouteBoolean(merged, "fastConvo", item.fastConvo, [], "fast_convo");
      }
      if (item.reasoningDurationSec != null) {
        assignRouteNumber(merged, "reasoningDurationSec", item.reasoningDurationSec, [], "finished_duration_sec");
      }
      if (Array.isArray(item.evidence)) {
        for (const evidence of item.evidence) {
          if (!isRecord(evidence)) continue;
          pushEvidence(merged, evidence.field, evidence.value, String(evidence.path || "").split("."));
        }
      }
    }
    return merged;
  }

  function parseConversationRequest(raw) {
    const fields = emptyRouteFields();
    if (typeof raw !== "string" || raw.length > 2 * 1024 * 1024) return fields;
    let root;
    try {
      root = JSON.parse(raw);
    } catch {
      return fields;
    }
    if (!isRecord(root)) return fields;
    assignRouteField(fields, "requestedModel", root.model, ["model"], "model");
    assignRouteField(fields, "thinkingEffort", root.thinking_effort, ["thinking_effort"], "thinking_effort");
    assignRouteField(fields, "conversationId", root.conversation_id, ["conversation_id"], "conversation_id");
    return fields;
  }

  function extractMetadata(fields, metadata, path, modelKind = "none") {
    if (!isRecord(metadata)) return;
    if (modelKind === "assistant") {
      assignRouteField(fields, "assistantModel", metadata.model_slug, [...path, "model_slug"], "model_slug");
    } else if (modelKind === "server") {
      assignRouteField(fields, "serverModel", metadata.model_slug, [...path, "model_slug"], "server_ste_metadata.model_slug");
    }
    assignRouteField(fields, "resolvedModel", metadata.resolved_model_slug, [...path, "resolved_model_slug"], "resolved_model_slug");
    assignRouteField(fields, "defaultModel", metadata.default_model_slug, [...path, "default_model_slug"], "default_model_slug");
    assignRouteField(fields, "serverModel", metadata.server_model_slug, [...path, "server_model_slug"], "server_model_slug");
    assignRouteField(fields, "requestId", metadata.request_id, [...path, "request_id"], "request_id");
    assignRouteField(fields, "conversationId", metadata.conversation_id, [...path, "conversation_id"], "conversation_id");
    assignRouteField(fields, "planType", metadata.plan_type, [...path, "plan_type"], "plan_type");
    assignRouteField(fields, "thinkingEffort", metadata.thinking_effort, [...path, "thinking_effort"], "thinking_effort");
    assignRouteBoolean(fields, "fastConvo", metadata.fast_convo, [...path, "fast_convo"], "fast_convo");
    assignRouteField(fields, "requestedModelExperience", metadata.requested_model_experience, [...path, "requested_model_experience"], "requested_model_experience");
    assignRouteField(fields, "turnUseCase", metadata.turn_use_case, [...path, "turn_use_case"], "turn_use_case");
    assignRouteField(fields, "turnMode", metadata.turn_mode, [...path, "turn_mode"], "turn_mode");
    assignRouteField(fields, "reasoningStatus", metadata.reasoning_status, [...path, "reasoning_status"], "reasoning_status");
    assignRouteNumber(fields, "reasoningDurationSec", metadata.finished_duration_sec, [...path, "finished_duration_sec"], "finished_duration_sec");
  }

  function walkRouteFields(value, fields, path = [], depth = 0, budget = { count: 0 }) {
    if (depth > 12 || budget.count >= 5000) return fields;
    budget.count += 1;
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length && budget.count < 5000; index += 1) {
        walkRouteFields(value[index], fields, [...path, index], depth + 1, budget);
      }
      return fields;
    }
    if (!isRecord(value)) return fields;

    const metadata = isRecord(value.metadata) ? value.metadata : null;
    const author = isRecord(value.author) ? value.author : null;
    if (value.type === "server_ste_metadata" && metadata) {
      extractMetadata(fields, metadata, [...path, "metadata"], "server");
    } else {
      extractMetadata(fields, value, path, "none");
      if (metadata) {
        extractMetadata(fields, metadata, [...path, "metadata"], author?.role === "assistant" ? "assistant" : "none");
        if (isRecord(metadata.server_ste_metadata)) {
          extractMetadata(fields, metadata.server_ste_metadata, [...path, "metadata", "server_ste_metadata"], "server");
        }
      }
    }
    assignRouteField(fields, "conversationId", value.conversation_id, [...path, "conversation_id"], "conversation_id");
    if (value.type === "reasoning_status") {
      assignRouteField(fields, "reasoningStatus", value.reasoning_status || value.status, [...path, "reasoning_status"], "reasoning_status");
      assignRouteNumber(fields, "reasoningDurationSec", value.finished_duration_sec, [...path, "finished_duration_sec"], "finished_duration_sec");
    }

    for (const [key, child] of Object.entries(value)) {
      if (value.type === "server_ste_metadata" && key === "metadata") continue;
      if (child && typeof child === "object") {
        walkRouteFields(child, fields, [...path, key], depth + 1, budget);
      }
    }
    return fields;
  }

  function parseMessageNode(rawNode, key) {
    const node = isRecord(rawNode) ? rawNode : null;
    const message = isRecord(node?.message) ? node.message : node;
    const author = isRecord(message?.author) ? message.author : null;
    const parentObject = isRecord(node?.parent) ? node.parent : null;
    const parentId = safeId(node?.parent)
      || safeId(parentObject?.id)
      || safeId(message?.parent_id);
    const messageId = safeId(message?.id) || safeId(key) || String(key);
    const fields = emptyRouteFields();
    if (message) walkRouteFields(message, fields, ["mapping", key, "message"]);
    return {
      key: String(key),
      messageId,
      parentId,
      role: safeIdentifier(author?.role, 32),
      fields,
    };
  }

  function parseConversationRecord(root) {
    if (!isRecord(root)) return null;
    const mapping = isRecord(root.mapping) ? root.mapping : null;
    const nodes = [];
    const byId = new Map();
    if (mapping) {
      for (const [key, rawNode] of Object.entries(mapping)) {
        const node = parseMessageNode(rawNode, key);
        nodes.push(node);
        byId.set(node.key, node);
        byId.set(node.messageId, node);
      }
    } else if (Array.isArray(root.messages)) {
      for (let index = 0; index < root.messages.length && index < 5000; index += 1) {
        const rawMessage = root.messages[index];
        if (!isRecord(rawMessage)) continue;
        const key = safeId(rawMessage.id) || `message-${index}`;
        const node = parseMessageNode(rawMessage, key);
        if (!node.parentId && nodes.length > 0) node.parentId = nodes.at(-1).messageId;
        nodes.push(node);
        byId.set(node.key, node);
        byId.set(node.messageId, node);
      }
    } else {
      return null;
    }
    let currentId = safeId(root.current_node)
      || safeId(isRecord(root.current_node) ? root.current_node.id : null);
    const visited = new Set();
    for (let depth = 0; currentId && depth < 80; depth += 1) {
      if (visited.has(currentId)) break;
      visited.add(currentId);
      const node = byId.get(currentId);
      if (!node) break;
      if (node.role === "assistant") {
        const result = emptyRouteFields();
        let cursor = node;
        const parentVisited = new Set();
        for (let parentDepth = 0; cursor && parentDepth < 80; parentDepth += 1) {
          if (parentVisited.has(cursor.key)) break;
          parentVisited.add(cursor.key);
          const merged = mergeRouteFields(result, cursor.fields);
          Object.assign(result, merged);
          if (cursor.role === "user") break;
          cursor = cursor.parentId ? byId.get(cursor.parentId) : null;
        }
        assignRouteField(result, "conversationId", root.id || root.conversation_id, ["conversation_id"], "conversation_id");
        return result;
      }
      currentId = node.parentId;
    }
    return null;
  }

  function parseJsonRoutePayload(value) {
    const conversation = parseConversationRecord(value);
    if (conversation) return conversation;
    return walkRouteFields(value, emptyRouteFields());
  }

  function parseSseResponse(raw) {
    let fields = emptyRouteFields();
    if (typeof raw !== "string") return fields;
    for (const line of raw.split(/\r?\n/)) {
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      try {
        fields = mergeRouteFields(fields, parseJsonRoutePayload(JSON.parse(payload)));
      } catch {
        // Ignore partial or non-JSON SSE events.
      }
    }
    return fields;
  }

  function parseResponseText(raw) {
    if (typeof raw !== "string" || raw.length > 8 * 1024 * 1024) return emptyRouteFields();
    if (/^\s*data:/m.test(raw)) return parseSseResponse(raw);
    try {
      return parseJsonRoutePayload(JSON.parse(raw));
    } catch {
      return emptyRouteFields();
    }
  }

  function parseWebSocketText(raw) {
    if (typeof raw !== "string" || raw.length > 1024 * 1024) return emptyRouteFields();
    let result = parseResponseText(raw);
    const hasEvidence = result.evidence.length > 0;
    if (hasEvidence) return result;
    let root;
    try {
      root = JSON.parse(raw);
    } catch {
      return result;
    }
    const budget = { count: 0 };
    function visit(value, depth = 0) {
      if (depth > 5 || budget.count >= 1000) return;
      budget.count += 1;
      if (typeof value === "string" && value.length <= 1024 * 1024) {
        const parsed = parseResponseText(value);
        if (parsed.evidence.length > 0) result = mergeRouteFields(result, parsed);
        return;
      }
      if (Array.isArray(value)) {
        for (const child of value) visit(child, depth + 1);
        return;
      }
      if (isRecord(value)) {
        for (const child of Object.values(value)) visit(child, depth + 1);
      }
    }
    visit(root);
    return result;
  }

  function normalizeModelForComparison(value) {
    const safe = safeIdentifier(value);
    if (!safe) return null;
    return safe.toLowerCase().replace(/[^a-z0-9]+/g, "");
  }

  function routeAssessment(fields) {
    const requestedModel = safeIdentifier(fields?.requestedModel);
    const responseCandidates = [
      ["resolved_model_slug", safeIdentifier(fields?.resolvedModel)],
      ["server_model_slug", safeIdentifier(fields?.serverModel)],
      ["assistant_model_slug", safeIdentifier(fields?.assistantModel)],
    ].filter(([, value]) => value);
    const effectiveModel = responseCandidates[0]?.[1] ?? null;
    const requestedEffectiveDifferent = Boolean(
      requestedModel
      && effectiveModel
      && normalizeModelForComparison(requestedModel) !== normalizeModelForComparison(effectiveModel),
    );
    const distinct = new Set(responseCandidates.map(([, value]) => normalizeModelForComparison(value)).filter(Boolean));
    let status = "insufficient";
    if (distinct.size > 1) {
      status = "field_conflict";
    } else if (requestedModel && effectiveModel) {
      status = normalizeModelForComparison(requestedModel) === normalizeModelForComparison(effectiveModel)
        ? "matched"
        : "different";
    }

    const fastConvo = typeof fields?.fastConvo === "boolean" ? fields.fastConvo : null;
    const thinkingEffort = safeIdentifier(fields?.thinkingEffort);
    const reasoningDuration = Number(fields?.reasoningDurationSec);
    const reasoningDurationSec = Number.isFinite(reasoningDuration) && reasoningDuration >= 0
      ? round(reasoningDuration, 3)
      : null;
    const highEffort = /^(?:high|max|xhigh|extra[ _-]?high)$/i.test(thinkingEffort || "");
    const shortHighEffort = highEffort && reasoningDurationSec != null && reasoningDurationSec <= 60;
    const diagnosticSignals = [];
    if (fastConvo === true) diagnosticSignals.push({
      code: "fast_convo",
      severity: "notice",
      summary: "服务端元数据标记 fast_convo=true；该字段本身不等于限流。",
    });
    if (requestedEffectiveDifferent) diagnosticSignals.push({
      code: "requested_resolved_mismatch",
      severity: "warning",
      summary: "请求模型与优先响应模型字段不同。",
    });
    if (status === "field_conflict") diagnosticSignals.push({
      code: "response_field_conflict",
      severity: "warning",
      summary: "多个响应侧模型字段互相冲突。",
    });
    if (shortHighEffort) diagnosticSignals.push({
      code: "short_high_effort_reasoning",      severity: "notice",
      summary: "高 thinking effort 下观测到较短 reasoning 时长；时长本身不能证明受限。",
    });

    let diagnosticStatus = "insufficient";
    if (fastConvo === true && (requestedEffectiveDifferent || shortHighEffort)) {
      diagnosticStatus = "restriction_suspected";
    } else if (requestedEffectiveDifferent || status === "field_conflict") {
      diagnosticStatus = "route_anomaly";
    } else if (fastConvo === true) {
      diagnosticStatus = "fast_path_observed";
    } else if (status === "matched") {
      diagnosticStatus = "consistent";
    }

    return {
      status,
      diagnosticStatus,
      requestedModel,
      effectiveModel,
      fastConvo,
      thinkingEffort,
      reasoningDurationSec,
      diagnosticSignals,
      anomalous: diagnosticStatus === "restriction_suspected" || diagnosticStatus === "route_anomaly",
      responseCandidates: responseCandidates.map(([field, value]) => ({ field, value })),
      caveat: "These are heuristic page-visible signals. fast_convo, response fields, or short duration alone do not prove hidden restriction or the physical inference backend.",
    };
  }

  function sanitizeEvidence(evidence) {
    const result = [];
    for (const item of Array.isArray(evidence) ? evidence : []) {
      if (!isRecord(item) || result.length >= MAX_EVIDENCE) continue;
      const field = safeIdentifier(item.field, 96);
      const value = safeIdentifier(item.value, MAX_IDENTIFIER_LENGTH);
      const path = typeof item.path === "string" ? item.path.slice(0, 768) : "";
      if (!field || !value) continue;
      result.push({ field, value, path });
    }
    return result;
  }

  function sanitizeRouteObservation(observation) {
    if (!isRecord(observation)) return null;
    const captureId = safeId(observation.captureId);
    const phase = ["requested", "responding", "completed", "failed"].includes(observation.phase)
      ? observation.phase
      : "responding";
    const source = ["page_fetch", "page_websocket", "conversation_record"].includes(observation.source)
      ? observation.source
      : null;
    if (!captureId || !source) return null;
    const reasoningDuration = Number(observation.reasoningDurationSec);
    const sanitized = {
      schemaVersion: 1,
      captureId,
      source,
      phase,
      observedAt: safeIso(observation.observedAt) || new Date().toISOString(),
      startedAt: safeIso(observation.startedAt),
      completedAt: safeIso(observation.completedAt),
      pageUrl: typeof observation.pageUrl === "string"
        ? observation.pageUrl.replace(/[?#].*$/, "").slice(0, 512)
        : null,
      requestedModel: safeIdentifier(observation.requestedModel),
      assistantModel: safeIdentifier(observation.assistantModel),
      serverModel: safeIdentifier(observation.serverModel),
      resolvedModel: safeIdentifier(observation.resolvedModel),
      defaultModel: safeIdentifier(observation.defaultModel),
      thinkingEffort: safeIdentifier(observation.thinkingEffort),
      fastConvo: typeof observation.fastConvo === "boolean" ? observation.fastConvo : null,
      requestedModelExperience: safeIdentifier(observation.requestedModelExperience),
      turnUseCase: safeIdentifier(observation.turnUseCase),
      turnMode: safeIdentifier(observation.turnMode),
      reasoningStatus: safeIdentifier(observation.reasoningStatus),
      reasoningDurationSec: Number.isFinite(reasoningDuration)
        && reasoningDuration >= 0
        && reasoningDuration <= 24 * 60 * 60
        ? round(reasoningDuration, 3)
        : null,
      requestId: safeId(observation.requestId),
      conversationId: safeId(observation.conversationId),
      planType: safeIdentifier(observation.planType),
      errorCode: safeIdentifier(observation.errorCode, 96),
      evidence: sanitizeEvidence(observation.evidence),
    };
    sanitized.assessment = routeAssessment(sanitized);
    return sanitized;
  }

  function mergeRouteObservations(existing, incoming) {
    const left = sanitizeRouteObservation(existing);
    const right = sanitizeRouteObservation(incoming);
    if (!right) return left;
    if (!left || left.captureId !== right.captureId) return right;
    const sourceSet = new Set([
      ...(Array.isArray(existing?.sources) ? existing.sources : [left.source]),
      ...(Array.isArray(incoming?.sources) ? incoming.sources : [right.source]),
      left.source,
      right.source,
    ].filter((source) => ["page_fetch", "page_websocket", "conversation_record"].includes(source)));
    const mergedFields = mergeRouteFields(left, right);
    const phaseRank = { requested: 1, responding: 2, failed: 3, completed: 4 };
    const phase = phaseRank[right.phase] >= phaseRank[left.phase] ? right.phase : left.phase;
    const merged = sanitizeRouteObservation({
      ...left,
      ...right,
      ...mergedFields,
      source: right.source,
      phase,
      startedAt: left.startedAt || right.startedAt,
      completedAt: right.completedAt || left.completedAt,
      observedAt: right.observedAt > left.observedAt ? right.observedAt : left.observedAt,
      evidence: [...left.evidence, ...right.evidence],
    });
    if (merged) merged.sources = [...sourceSet];
    return merged;
  }

  function csvEscape(value) {
    const string = value == null ? "" : String(value);
    return /[",\r\n]/.test(string) ? `"${string.replaceAll('"', '""')}"` : string;
  }

  function rowsToCsv(headers, rows) {
    const lines = [headers.map(csvEscape).join(",")];
    for (const row of rows) lines.push(row.map(csvEscape).join(","));
    return `\uFEFF${lines.join("\r\n")}\r\n`;
  }

  global.CodexCreditsWatchCore = Object.freeze({
    DAY_SECONDS,
    MAX_CREDIT_ROWS,
    MAX_LIMIT_WINDOWS,
    COMMUNITY_REFERENCE_VERSION,
    COMMUNITY_PLAN_REFERENCES,
    DEFAULT_SETTINGS,
    STORAGE_KEYS,
    EMPTY_ROUTE_FIELDS,
    addDays,
    applyCreditReference,
    buildCreditReport,
    clamp,
    compareCreditReference,
    compactCreditSnapshot,
    creditReportMatchesSettings,
    dateKey,
    detectCreditAnomalies,
    detectCycleTransitions,
    classifyCycleTransition,
    classifyResetCreditsState,
    classifyAccountLimitState,
    analysisCycleKey,
    normalizeCycleEvents,
    sanitizeCycleEvent,
    CYCLE_EVENT_TYPES,
    emptyRouteFields,
    estimateCreditCapacity,
    extractLimitWindows,
    extractUsageLimitWindows,
    extractAccountLimitSummary,
    extractConversationLimitSummary,
    extractPlanHints,
    extractResetCreditDetails,
    extractResetCreditSummary,
    isRecord,
    localDateKey,
    median,
    mergeRouteFields,
    mergeRouteObservations,
    mergeResetCreditsState,
    mergeAccountLimitState,
    normalizeDailyRows,
    normalizeModelForComparison,
    normalizeSettings,
    normalizePlanHint,
    parseConversationRequest,
    parseResponseText,
    parseSseResponse,
    parseWebSocketText,
    planLabel,
    resolveCreditReference,
    round,
    routeAssessment,
    rowsToCsv,
    safeIdentifier,
    sanitizeCreditObservation,
    sanitizeAccountLimitObservation,
    sanitizeDailyRow,
    sanitizeLimitWindow,
    sanitizeRouteObservation,
    selectWeeklyWindow,
    sumDailyRows,
    toNumber,
    weightedMedian,
  });
})(globalThis);