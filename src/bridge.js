(function () {
  "use strict";

  const Core = globalThis.CodexCreditsWatchCore;
  const api = globalThis.browser ?? globalThis.chrome;
  if (!Core || !api?.storage?.local || globalThis.__codexCreditsWatchBridgeInstalled) return;
  globalThis.__codexCreditsWatchBridgeInstalled = true;

  const KEYS = Core.STORAGE_KEYS;
  const PAGE_SOURCE = "codex-credits-watch-page";
  const BRIDGE_SOURCE = "codex-credits-watch-bridge";
  const SUPPORTED_ORIGIN = "https://chatgpt.com";
  const PREFERRED_USAGE_PATH = "/codex/settings/usage";
  const USAGE_PATHS = new Set([PREFERRED_USAGE_PATH, "/codex/cloud/settings/analytics"]);
  const MAX_SNAPSHOTS = 500;
  const MAX_ROUTE_OBSERVATIONS = 200;
  const MAX_PASSIVE_SESSIONS = 4;
  const OVERLAY_ID = "codex-credits-watch-overlay-host";
  const passiveSessions = new Map();
  let overlay = null;
  let routeWriteQueue = Promise.resolve();
  let creditWriteQueue = Promise.resolve();

  async function storageGet(keys) {
    return await api.storage.local.get(keys);
  }

  async function storageSet(value) {
    await api.storage.local.set(value);
  }

  async function storageRemove(keys) {
    await api.storage.local.remove(keys);
  }

  function normalizeSettings(value) {
    return Core.normalizeSettings(value);
  }

  async function getSettings() {
    const stored = (await storageGet(KEYS.settings))[KEYS.settings];
    return normalizeSettings({ ...Core.DEFAULT_SETTINGS, ...(Core.isRecord(stored) ? stored : {}) });
  }

  async function updateSettings(patch) {
    const settings = normalizeSettings({ ...(await getSettings()), ...(Core.isRecord(patch) ? patch : {}) });
    await storageSet({ [KEYS.settings]: settings });
    postPreferences(settings);
    return settings;
  }

  function postPreferences(settings) {
    if (location.origin !== SUPPORTED_ORIGIN) return;
    window.postMessage({
      source: BRIDGE_SOURCE,
      version: 2,
      type: "preferences",
      payload: {
        captureCredits: Boolean(settings.captureCredits),
        routeInspection: Boolean(settings.routeInspection),
      },
    }, location.origin);
  }

  function safeErrorCode(value) {
    return Core.safeIdentifier(value, 96) || null;
  }

  async function mergeCaptureStatus(patch) {
    const stored = (await storageGet(KEYS.captureStatus))[KEYS.captureStatus];
    const next = {
      schemaVersion: 2,
      mode: "passive",
      state: "waiting",
      ...(Core.isRecord(stored) ? stored : {}),
      ...(Core.isRecord(patch) ? patch : {}),
      updatedAt: new Date().toISOString(),
    };
    next.sessionId = typeof next.sessionId === "string" ? next.sessionId.slice(0, 256) : null;
    next.pageUrl = typeof next.pageUrl === "string" ? next.pageUrl.replace(/[?#].*$/, "").slice(0, 512) : null;
    next.errorCode = safeErrorCode(next.errorCode);
    next.dailyRowCount = Math.min(Core.MAX_CREDIT_ROWS, Math.max(0, Number(next.dailyRowCount) || 0));
    await storageSet({ [KEYS.captureStatus]: next });
    return next;
  }

  function shouldAppendSnapshot(previous, next) {
    if (!previous) return true;
    const previousAt = new Date(previous.capturedAt || 0).getTime();
    const nextAt = new Date(next.capturedAt || 0).getTime();
    const changed = previous.cycleStart !== next.cycleStart
      || previous.resetAt !== next.resetAt
      || previous.durationSeconds !== next.durationSeconds
      || previous.referencePlanId !== next.referencePlanId
      || previous.usedPercent !== next.usedPercent
      || previous.cycleCredits !== next.cycleCredits
      || previous.cycleTokens !== next.cycleTokens
      || previous.impliedQuotaCredits !== next.impliedQuotaCredits;
    return changed || nextAt - previousAt >= 10 * 60 * 1000;
  }

  async function saveCreditReport(report, oldSnapshots) {
    const compact = Core.compactCreditSnapshot(report);
    const snapshots = Array.isArray(oldSnapshots) ? [...oldSnapshots] : [];
    const previous = snapshots.at(-1) || null;
    if (compact.capturedAt && shouldAppendSnapshot(previous, compact)) snapshots.push(compact);
    const trimmed = snapshots
      .filter((sample) => Core.isRecord(sample) && typeof sample.capturedAt === "string")
      .sort((left, right) => left.capturedAt.localeCompare(right.capturedAt))
      .slice(-MAX_SNAPSHOTS);
    await storageSet({
      [KEYS.creditLatest]: report,
      [KEYS.creditSnapshots]: trimmed,
    });
    return trimmed;
  }

  function getPassiveSession(sessionId) {
    let session = passiveSessions.get(sessionId);
    if (!session) {
      session = {
        sessionId,
        usage: null,
        rowsByDate: new Map(),
        dailyObservedAt: null,
        dailyStartDate: null,
        dailyEndDate: null,
        pageUrl: null,
        touchedAt: Date.now(),
      };
      passiveSessions.set(sessionId, session);
      while (passiveSessions.size > MAX_PASSIVE_SESSIONS) {
        const oldest = passiveSessions.keys().next().value;
        passiveSessions.delete(oldest);
      }
    }
    session.touchedAt = Date.now();
    return session;
  }

  async function buildFromPassiveSession(session) {
    if (!session.usage || session.rowsByDate.size === 0) return null;
    const state = await storageGet([
      KEYS.creditSnapshots,
      KEYS.cycleEvents,
      KEYS.settings,
    ]);
    const snapshots = Array.isArray(state[KEYS.creditSnapshots]) ? state[KEYS.creditSnapshots] : [];
    const cycleEvents = Core.normalizeCycleEvents(state[KEYS.cycleEvents]);
    const settings = normalizeSettings({
      ...Core.DEFAULT_SETTINGS,
      ...(Core.isRecord(state[KEYS.settings]) ? state[KEYS.settings] : {}),
    });
    const capturedAt = [session.usage.observedAt, session.dailyObservedAt]
      .filter(Boolean)
      .sort()
      .at(-1) || new Date().toISOString();
    const dailyRows = [...session.rowsByDate.values()].sort((left, right) => left.date.localeCompare(right.date));
    const report = Core.buildCreditReport({
      windows: session.usage.windows,
      dailyRows,
      planHints: session.usage.planHints,
      capturedAt,
      snapshots,
      lookbackStart: session.dailyStartDate,
      lookbackEnd: session.dailyEndDate,
      pageUrl: session.pageUrl,
      settings,
      analysisEvents: cycleEvents,
      capture: {
        mode: "passive",
        sessionId: session.sessionId,
        usageObservedAt: session.usage.observedAt,
        dailyObservedAt: session.dailyObservedAt,
        dailyStartDate: session.dailyStartDate,
        dailyEndDate: session.dailyEndDate,
        dailyRowCount: dailyRows.length,
      },
    });
    await saveCreditReport(report, snapshots);
    await mergeCaptureStatus({
      state: "captured",
      sessionId: session.sessionId,
      pageUrl: session.pageUrl,
      usageObservedAt: session.usage.observedAt,
      dailyObservedAt: session.dailyObservedAt,
      lastReportAt: report.capturedAt,
      dailyStartDate: session.dailyStartDate,
      dailyEndDate: session.dailyEndDate,
      dailyRowCount: dailyRows.length,
      errorCode: null,
    });
    await renderOverlay();
    return report;
  }

  async function saveResetCreditObservation(observation) {
    const stored = await storageGet(KEYS.resetCreditsLatest);
    const next = Core.mergeResetCreditsState(stored[KEYS.resetCreditsLatest], observation);
    await storageSet({ [KEYS.resetCreditsLatest]: next });
    return next;
  }

  function storeCreditObservation(observation) {
    creditWriteQueue = creditWriteQueue.then(async () => {
      const settings = await getSettings();
      if (!settings.captureCredits) return;
      const sanitized = Core.sanitizeCreditObservation(observation);
      if (!sanitized) return;
      if (sanitized.kind === "reset_credits") {
        await saveResetCreditObservation(sanitized);
        await renderOverlay();
        return;
      }
      if (sanitized.kind === "usage" && sanitized.resetCredits) {
        await saveResetCreditObservation(sanitized);
      }
      if (sanitized.kind === "usage" && sanitized.windows.length === 0) {
        await renderOverlay();
        return;
      }
      const session = getPassiveSession(sanitized.sessionId);
      session.pageUrl = sanitized.pageUrl || session.pageUrl;
      if (sanitized.kind === "usage") {
        session.usage = sanitized;
      } else if (sanitized.kind === "daily") {
        for (const row of sanitized.rows) session.rowsByDate.set(row.date, row);
        session.dailyObservedAt = sanitized.observedAt;
        session.dailyStartDate = session.dailyStartDate && session.dailyStartDate < sanitized.startDate
          ? session.dailyStartDate
          : sanitized.startDate;
        session.dailyEndDate = session.dailyEndDate && session.dailyEndDate > sanitized.endDate
          ? session.dailyEndDate
          : sanitized.endDate;
      }
      await mergeCaptureStatus({
        state: session.usage && session.rowsByDate.size > 0 ? "building" : "waiting",
        sessionId: session.sessionId,
        pageUrl: session.pageUrl,
        usageObservedAt: session.usage?.observedAt || null,
        dailyObservedAt: session.dailyObservedAt,
        dailyStartDate: session.dailyStartDate,
        dailyEndDate: session.dailyEndDate,
        dailyRowCount: session.rowsByDate.size,
        waitingFor: !session.usage ? "usage" : session.rowsByDate.size === 0 ? "daily" : null,
        errorCode: null,
      });
      await buildFromPassiveSession(session);
    }).catch(async (error) => {
      await mergeCaptureStatus({
        state: "error",
        errorCode: error instanceof Error ? error.message : "passive_capture_failed",
      }).catch(() => undefined);
    });
    return creditWriteQueue;
  }

  function mergeStoredRoute(existing, incoming) {
    const merged = Core.mergeRouteObservations(existing, incoming);
    if (!merged) return null;
    const sources = new Set([
      ...(Array.isArray(existing?.sources) ? existing.sources : existing?.source ? [existing.source] : []),
      ...(Array.isArray(incoming?.sources) ? incoming.sources : incoming?.source ? [incoming.source] : []),
      merged.source,
    ]);
    merged.sources = [...sources].filter(Boolean).slice(0, 4);
    merged.assessment = Core.routeAssessment(merged);
    return merged;
  }

  function storeRouteObservation(observation) {
    routeWriteQueue = routeWriteQueue.then(async () => {
      const settings = await getSettings();
      if (!settings.routeInspection) return;
      const sanitized = Core.sanitizeRouteObservation(observation);
      if (!sanitized) return;
      const state = await storageGet(KEYS.routeObservations);
      const list = Array.isArray(state[KEYS.routeObservations])
        ? state[KEYS.routeObservations].filter(Core.isRecord)
        : [];
      const index = list.findIndex((item) => item.captureId === sanitized.captureId);
      if (index >= 0) {
        const merged = mergeStoredRoute(list[index], sanitized);
        if (merged) list[index] = merged;
      } else {
        const merged = mergeStoredRoute(null, sanitized);
        if (merged) list.push(merged);
      }
      list.sort((left, right) => String(left.observedAt).localeCompare(String(right.observedAt)));
      await storageSet({ [KEYS.routeObservations]: list.slice(-MAX_ROUTE_OBSERVATIONS) });
      await renderOverlay();
    }).catch(() => undefined);
    return routeWriteQueue;
  }

  async function storeHookStatus(payload) {
    if (!Core.isRecord(payload)) return;
    const stored = (await storageGet(KEYS.captureStatus))[KEYS.captureStatus];
    const state = payload.status === "credit-parse-failed"
      ? "error"
      : stored?.state === "captured"
        ? "captured"
        : "ready";
    await mergeCaptureStatus({
      state,
      sessionId: typeof payload.sessionId === "string" ? payload.sessionId : stored?.sessionId ?? null,
      pageUrl: typeof payload.pageUrl === "string" ? payload.pageUrl : stored?.pageUrl ?? null,
      hookObservedAt: typeof payload.observedAt === "string" ? payload.observedAt : null,
      hookStatus: Core.safeIdentifier(payload.status, 64),
      endpointKind: Core.safeIdentifier(payload.endpointKind, 64),
      errorCode: payload.status === "credit-parse-failed" ? safeErrorCode(payload.errorCode) : null,
    });
  }

  function onPageMessage(event) {
    if (event.source !== window || event.origin !== location.origin || event.origin !== SUPPORTED_ORIGIN) return;
    const envelope = event.data;
    if (!Core.isRecord(envelope)
      || envelope.source !== PAGE_SOURCE
      || envelope.version !== 2) return;
    if (envelope.type === "route-observation") void storeRouteObservation(envelope.payload);
    else if (envelope.type === "credit-observation") void storeCreditObservation(envelope.payload);
    else if (envelope.type === "hook-status") void storeHookStatus(envelope.payload);
  }

  function formatNumber(value, digits = 2) {
    const number = Number(value);
    if (!Number.isFinite(number)) return "—";
    return new Intl.NumberFormat(undefined, { maximumFractionDigits: digits }).format(number);
  }

  function formatCredits(value) {
    return value == null ? "—" : formatNumber(value, 3);
  }

  function formatPercent(value) {
    return value == null ? "—" : `${formatNumber(value, 1)}%`;
  }

  function trendLabel(estimate) {
    if (estimate?.trend === "possible_decrease") return `相对个人历史可能下降 ${formatPercent(Math.abs(estimate.changeFraction) * 100)}`;
    if (estimate?.trend === "possible_increase") return `相对个人历史可能上升 ${formatPercent(Math.abs(estimate.changeFraction) * 100)}`;
    if (estimate?.trend === "stable_range") return "与个人历史基线接近";
    return "个人历史样本不足";
  }

  function referenceLabel(comparison, reference) {
    if (!reference?.referenceCredits) return "尚未设置套餐参考";
    if (comparison?.status === "below_reference") return `低于${reference.referenceLabel} ${formatPercent(Math.abs(comparison.differenceFraction) * 100)}`;
    if (comparison?.status === "above_reference") return `高于${reference.referenceLabel} ${formatPercent(Math.abs(comparison.differenceFraction) * 100)}`;
    if (comparison?.status === "near_reference") return `接近${reference.referenceLabel}`;
    return `${reference.referenceLabel}：${formatCredits(reference.referenceCredits)}`;
  }

  function routeStatusLabel(status) {
    return {
      matched: "请求与响应字段一致",
      different: "请求与响应字段不同",
      field_conflict: "响应路由字段互相冲突",
      insufficient: "路由字段不足",
    }[status] || "路由字段不足";
  }

  function resetCreditStatusLabel(classification) {
    return {
      unknown: "尚未观测到重置机会摘要。",
      none: "最近观测为 0 次可用重置机会。",
      count_only: "已观测到可用数量，尚未观测到期详情。",
      stale: "最近观测到期时间已过；等待页面的新响应更新状态。",
      danger: "最近一笔将在 72 小时内到期。",
      warning: "最近一笔将在 7 天内到期。",
      available: "最近一笔到期时间超过 7 天。",
      non_expiring: `详情中观察到 ${formatNumber(classification.nonExpiringObservedCount, 0)} 项无到期时间；不推断其永久有效。`,
      details_without_expiry: "已观测详情，但未见有效到期时间。",
    }[classification.status] || "尚未观测到重置机会摘要。";
  }

  function resetCreditTone(status) {
    if (status === "danger") return "danger";
    if (status === "warning") return "warning";
    if (status === "stale") return "stale";
    return "status";
  }

  function formatObservedExpiry(value) {
    if (!value) return "—";
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString();
  }

  function overlayNode(tagName, className, text) {
    const node = document.createElement(tagName);
    if (className) node.className = className;
    if (text != null) node.textContent = String(text);
    return node;
  }

  function overlayMetric(label, value) {
    const metric = overlayNode("div", "metric");
    metric.append(
      overlayNode("div", "label", label),
      overlayNode("div", "value", value),
    );
    return metric;
  }

  function overlayRouteRow(label, value) {
    const row = overlayNode("div", "route-row");
    row.append(
      overlayNode("span", null, label),
      overlayNode("strong", null, value),
    );
    return row;
  }

  function ensureOverlay() {
    if (overlay?.host?.isConnected) return overlay;
    const host = document.createElement("div");
    host.id = OVERLAY_ID;
    host.style.all = "initial";
    host.style.position = "fixed";
    host.style.right = "16px";
    host.style.bottom = "16px";
    host.style.zIndex = "2147483646";
    const shadow = host.attachShadow({ mode: "closed" });
    const style = document.createElement("style");
    style.textContent = `
      :host { all: initial; }
      .panel { width: 326px; color:#172033; background:rgba(255,255,255,.97); border:1px solid rgba(15,23,42,.16); border-radius:14px; box-shadow:0 18px 50px rgba(15,23,42,.22); overflow:hidden; backdrop-filter:blur(12px); font:12px/1.45 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
      .panel.collapsed .body { display:none; }
      .header { display:flex; align-items:center; gap:8px; padding:10px 11px; border-bottom:1px solid rgba(15,23,42,.10); background:rgba(248,250,252,.92); }
      .title { min-width:0; flex:1; font-weight:750; font-size:13px; letter-spacing:.01em; }
      button { border:0; border-radius:8px; background:transparent; color:inherit; cursor:pointer; padding:4px 7px; font:inherit; }
      button:hover { background:rgba(15,23,42,.08); }
      .body { padding:10px 11px 11px; display:grid; gap:9px; }
      .section { display:grid; gap:5px; }
      .section-title { color:#64748b; font-size:10px; font-weight:750; text-transform:uppercase; letter-spacing:.08em; }
      .grid { display:grid; grid-template-columns:1fr 1fr; gap:6px; }
      .metric { min-width:0; padding:7px 8px; border-radius:9px; background:#f8fafc; border:1px solid #e2e8f0; }
      .label { color:#64748b; font-size:10px; }
      .value { margin-top:2px; font-size:13px; font-weight:750; overflow-wrap:anywhere; }
      .route { padding:8px; border-radius:9px; background:#f8fafc; border:1px solid #e2e8f0; display:grid; gap:3px; }
      .route-row { display:grid; grid-template-columns:72px 1fr; gap:6px; }
      .route-row span:first-child { color:#64748b; }
      .route-row strong { overflow-wrap:anywhere; }
      .status { padding:6px 8px; border-radius:8px; background:#eef2ff; color:#3730a3; font-weight:650; }
      .warning { padding:7px 8px; border-radius:8px; background:#fff7ed; color:#9a3412; font-size:10px; }
      .danger { padding:7px 8px; border-radius:8px; background:#fef2f2; color:#b91c1c; font-size:10px; font-weight:700; }
      .stale { padding:7px 8px; border-radius:8px; background:#f1f5f9; color:#475569; font-size:10px; }
      @media (prefers-color-scheme:dark) {
        .panel { color:#e5e7eb; background:rgba(17,24,39,.97); border-color:rgba(255,255,255,.16); box-shadow:0 18px 50px rgba(0,0,0,.45); }
        .header { background:rgba(31,41,55,.94); border-color:rgba(255,255,255,.1); }
        button:hover { background:rgba(255,255,255,.09); }
        .metric,.route { background:#111827; border-color:#374151; }
        .label,.section-title,.route-row span:first-child { color:#94a3b8; }
        .status { background:#312e81; color:#e0e7ff; }
        .warning { background:#431407; color:#fed7aa; }
        .danger { background:#450a0a; color:#fecaca; }
        .stale { background:#1e293b; color:#cbd5e1; }
      }
    `;
    const panel = document.createElement("section");
    panel.className = "panel";
    panel.innerHTML = `
      <div class="header">
        <div class="title">Muofu AI Quota Lens</div>
        <button type="button" data-action="capture" title="打开或重载 Usage">↻</button>
        <button type="button" data-action="collapse" title="折叠">−</button>
        <button type="button" data-action="hide" title="隐藏">×</button>
      </div>
      <div class="body">
        <div class="section" data-credit-section></div>
        <div class="section" data-reset-section></div>
        <div class="section" data-route-section></div>
        <div class="warning">Credits 仅被动观察 Usage 页面自身响应；套餐参考与额度估计均非官方承诺。</div>
      </div>
    `;
    shadow.append(style, panel);
    panel.querySelector('[data-action="capture"]').addEventListener("click", () => {
      if (USAGE_PATHS.has(location.pathname)) location.reload();
      else window.open(`${SUPPORTED_ORIGIN}${PREFERRED_USAGE_PATH}`, "_blank", "noopener,noreferrer");
    });
    panel.querySelector('[data-action="collapse"]').addEventListener("click", () => {
      const collapsed = !panel.classList.contains("collapsed");
      panel.classList.toggle("collapsed", collapsed);
      panel.querySelector('[data-action="collapse"]').textContent = collapsed ? "+" : "−";
      void updateSettings({ overlayCollapsed: collapsed });
    });
    panel.querySelector('[data-action="hide"]').addEventListener("click", () => {
      host.remove();
      overlay = null;
      void updateSettings({ showOverlay: false });
    });
    document.documentElement.append(host);
    overlay = { host, shadow, panel };
    return overlay;
  }

  async function renderOverlay() {
    const settings = await getSettings();
    if (!settings.showOverlay) {
      overlay?.host?.remove();
      overlay = null;
      return;
    }
    const view = ensureOverlay();
    view.panel.classList.toggle("collapsed", Boolean(settings.overlayCollapsed));
    view.panel.querySelector('[data-action="collapse"]').textContent = settings.overlayCollapsed ? "+" : "−";
    const state = await storageGet([KEYS.creditLatest, KEYS.resetCreditsLatest, KEYS.routeObservations, KEYS.captureStatus]);
    const routes = Array.isArray(state[KEYS.routeObservations]) ? state[KEYS.routeObservations] : [];
    const latestRoute = routes.at(-1) || null;
    const report = Core.isRecord(state[KEYS.creditLatest])
      ? state[KEYS.creditLatest]
      : null;
    const reportSettingsCurrent = report ? Core.creditReportMatchesSettings(report, settings) : false;
    const resetCredits = Core.classifyResetCreditsState(state[KEYS.resetCreditsLatest]);
    const captureStatus = Core.isRecord(state[KEYS.captureStatus]) ? state[KEYS.captureStatus] : null;
    const creditSection = view.panel.querySelector("[data-credit-section]");
    const resetSection = view.panel.querySelector("[data-reset-section]");
    const routeSection = view.panel.querySelector("[data-route-section]");

    if (!settings.captureCredits) {
      creditSection.replaceChildren(
        overlayNode("div", "section-title", "Codex Credits"),
        overlayNode("div", "status", "被动 Credits 观察已关闭。"),
      );
    } else if (Core.isRecord(report)) {
      const grid = overlayNode("div", "grid");
      grid.append(
        overlayMetric("本周期 Credits", formatCredits(report.currentCycleStats?.credits)),
        overlayMetric("周窗口已用", formatPercent(report.weeklyWindow?.usedPercent)),
        overlayMetric("推算 100%", reportSettingsCurrent ? formatCredits(report.estimate?.impliedQuotaCredits) : "—"),
        overlayMetric("参考基准", reportSettingsCurrent ? formatCredits(report.reference?.referenceCredits) : "—"),
      );
      creditSection.replaceChildren(
        overlayNode("div", "section-title", "Codex Credits · 被动捕获"),
        grid,
        overlayNode(
          "div",
          "status",
          reportSettingsCurrent
            ? `${referenceLabel(report.referenceComparison, report.reference)} · ${trendLabel(report.estimate)}`
            : "设置已变更，等待新的 Usage 捕获后更新比较。",
        ),
      );
    } else {
      const waiting = captureStatus?.waitingFor === "daily" ? "已见限额响应，等待按日用量响应" : captureStatus?.waitingFor === "usage" ? "已见按日用量，等待限额响应" : "打开或重载 Codex Usage 以被动捕获";
      creditSection.replaceChildren(
        overlayNode("div", "section-title", "Codex Credits · 被动捕获"),
        overlayNode("div", "status", waiting),
      );
    }

    const resetGrid = overlayNode("div", "grid");
    resetGrid.append(
      overlayMetric("可用次数", resetCredits.availableCount == null ? "—" : formatNumber(resetCredits.availableCount, 0)),
      overlayMetric("最近已观测到期", formatObservedExpiry(resetCredits.nearestExpiresAt)),
      overlayMetric("无到期时间项（已观测）", resetCredits.detailsLoaded ? formatNumber(resetCredits.nonExpiringObservedCount, 0) : "—"),
    );
    resetSection.replaceChildren(
      overlayNode("div", "section-title", "Usage limit reset · 被动观察"),
      resetGrid,
      overlayNode("div", resetCreditTone(resetCredits.status), resetCreditStatusLabel(resetCredits)),
    );

    if (!settings.routeInspection) {
      routeSection.replaceChildren(
        overlayNode("div", "section-title", "ChatGPT 路由观察"),
        overlayNode("div", "status", "路由元数据观察已关闭。"),
      );
    } else if (Core.isRecord(latestRoute)) {
      const assessment = Core.routeAssessment(latestRoute);
      const route = overlayNode("div", "route");
      route.append(
        overlayRouteRow("请求模型", assessment.requestedModel || "—"),
        overlayRouteRow("响应字段", assessment.effectiveModel || "—"),
        overlayRouteRow("状态", routeStatusLabel(assessment.status)),
      );
      routeSection.replaceChildren(
        overlayNode("div", "section-title", "ChatGPT 路由观察"),
        route,
      );
    } else {
      routeSection.replaceChildren(
        overlayNode("div", "section-title", "ChatGPT 路由观察"),
        overlayNode("div", "status", "发送一条新消息后显示可见模型元数据。"),
      );
    }
  }

  function registerRuntimeMessages() {
    api.runtime.onMessage.addListener((message) => {
      if (!Core.isRecord(message)) return undefined;
      if (message.type === "ccw.renderOverlay") {
        return updateSettings({ showOverlay: Boolean(message.visible) })
          .then(() => renderOverlay())
          .then(() => ({ ok: true }));
      }
      if (message.type === "ccw.settings") {
        return updateSettings(message.patch)
          .then((settings) => renderOverlay().then(() => ({ ok: true, settings })));
      }
      if (message.type === "ccw.clearRoutes") {
        return storageRemove(KEYS.routeObservations)
          .then(() => renderOverlay())
          .then(() => ({ ok: true }));
      }
      if (message.type === "ccw.captureStatus") {
        return storageGet(KEYS.captureStatus).then((state) => ({ ok: true, status: state[KEYS.captureStatus] || null }));
      }
      return undefined;
    });
  }

  window.addEventListener("message", onPageMessage, false);
  registerRuntimeMessages();

  const initialize = async () => {
    const settings = await getSettings();
    postPreferences(settings);
    await renderOverlay();
    if (USAGE_PATHS.has(location.pathname) && settings.captureCredits) {
      await mergeCaptureStatus({
        state: "waiting",
        pageUrl: `${location.origin}${location.pathname}`,
        waitingFor: "usage_and_daily",
        errorCode: null,
      });
    }
  };
  void initialize();

  api.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local") return;
    if (changes[KEYS.settings]) {
      void getSettings().then((settings) => {
        postPreferences(settings);
        return renderOverlay();
      });
      return;
    }
    if (Object.keys(changes).some((key) => [KEYS.creditLatest, KEYS.resetCreditsLatest, KEYS.routeObservations, KEYS.captureStatus].includes(key))) {
      void renderOverlay();
    }
  });
})();
