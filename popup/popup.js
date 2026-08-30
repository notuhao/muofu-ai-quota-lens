(function () {
  "use strict";

  const Core = globalThis.CodexCreditsWatchCore;
  const api = globalThis.browser ?? globalThis.chrome;
  const KEYS = Core.STORAGE_KEYS;
  const USAGE_URL = "https://chatgpt.com/codex/settings/usage";
  const byId = (id) => document.getElementById(id);
  let currentView = null;

  function formatNumber(value, digits = 2) {
    const number = Number(value);
    if (!Number.isFinite(number)) return "—";
    return new Intl.NumberFormat(undefined, { maximumFractionDigits: digits }).format(number);
  }

  function formatCredits(value) { return value == null ? "—" : formatNumber(value, 3); }
  function formatPercent(value) { return value == null ? "—" : `${formatNumber(value, 1)}%`; }
  function formatDate(value) {
    if (!value) return "—";
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString();
  }
  function safeText(value) { return typeof value === "string" && value ? value : "—"; }

  function setBadge(element, text, tone = "neutral") {
    element.textContent = text;
    element.className = `badge ${tone}`;
  }

  function setNotice(element, text, tone = "neutral") {
    element.textContent = text;
    element.className = `notice ${tone}`;
  }

  function confidenceLabel(value) {
    return { none: "不可估计", low: "低置信度", medium: "中等置信度", high: "较高置信度" }[value] || "—";
  }

  function planSourceLabel(source) {
    return {
      user: "用户指定",
      usage_metadata: "用量响应字段",
      route_metadata: "路由响应字段",
      ambiguous_metadata: "自动识别但 Pro 档位不明",
      conflicting_metadata: "元数据互相冲突",
      unknown: "未识别",
    }[source] || "未识别";
  }

  function referenceSettingsPending(report, settings) {
    return Core.isRecord(report) && Core.isRecord(settings)
      ? !Core.creditReportMatchesSettings(report, settings)
      : false;
  }

  function renderCredits(rawReport, captureStatus, settings) {
    if (!Core.isRecord(rawReport)) {
      byId("creditTimestamp").textContent = "尚无本地快照";
      setBadge(byId("creditConfidence"), "—", "neutral");
      byId("captureState").textContent = captureStatus?.state === "error"
        ? `解析失败：${captureStatus.errorCode || "未知错误"}`
        : captureStatus?.waitingFor === "daily"
          ? "已见限额响应，等待按日用量"
          : captureStatus?.waitingFor === "usage"
            ? "已见按日用量，等待限额响应"
            : "等待 Usage 页面响应";
      return null;
    }
    const report = rawReport;
    const estimate = Core.isRecord(report.estimate) ? report.estimate : {};
    const reference = Core.isRecord(report.reference) ? report.reference : {};
    const comparison = Core.isRecord(report.referenceComparison) ? report.referenceComparison : {};
    byId("creditTimestamp").textContent = `被动采集：${formatDate(report.capturedAt)}`;
    byId("cycleCredits").textContent = formatCredits(report.currentCycleStats?.credits);
    byId("usedPercent").textContent = formatPercent(report.weeklyWindow?.usedPercent);
    byId("quotaEstimate").textContent = formatCredits(estimate.impliedQuotaCredits);
    byId("referenceCredits").textContent = formatCredits(reference.referenceCredits);
    byId("baselineEstimate").textContent = estimate.baselineQuotaCredits == null
      ? "—"
      : `${formatCredits(estimate.baselineQuotaCredits)}（${estimate.baselineCycles || 0} 周）`;
    byId("resetAt").textContent = formatDate(report.weeklyWindow?.resetAt);
    byId("captureRange").textContent = report.lookbackStart && report.lookbackEnd
      ? `${report.lookbackStart} 至 ${report.lookbackEnd}（${report.dailyRows?.length || 0} 天）`
      : "—";
    byId("captureState").textContent = `${captureStatus?.state === "captured" ? "已完成" : "已生成报告"} · 纯被动观察`;
    byId("planReference").textContent = `${reference.planLabel || "未识别"} · ${planSourceLabel(reference.planSource)} · ${reference.referenceMode === "custom" ? "自定义" : reference.referenceMode === "community" ? "社区参考" : "无绝对参考"}`;
    byId("referenceRange").textContent = reference.rangeMinCredits && reference.rangeMaxCredits
      ? `${formatCredits(reference.rangeMinCredits)}–${formatCredits(reference.rangeMaxCredits)} Credits`
      : reference.referenceMode === "custom"
        ? reference.referenceLabel || "用户自定义"
        : "该套餐暂无内置绝对参考";

    const confidence = confidenceLabel(estimate.confidence);
    const confidenceTone = estimate.confidence === "high" ? "good" : estimate.confidence === "medium" ? "neutral" : "warn";
    setBadge(byId("creditConfidence"), confidence, confidenceTone);

    if (comparison.status === "provisional") {
      setNotice(byId("referenceNotice"), `当前推算值仅作暂定显示：刚重置/切换周期或边界日按日汇总可能包含重置前用量。等待同周期第二个快照后再判断是否低于${reference.referenceLabel || "参考基准"}。`, "warn");
    } else if (comparison.status === "below_reference") {
      setNotice(byId("referenceNotice"), `当前推算值低于${reference.referenceLabel} ${formatPercent(Math.abs(comparison.differenceFraction) * 100)}；请结合置信度和后续快照复核。`, "bad");
    } else if (comparison.status === "above_reference") {
      setNotice(byId("referenceNotice"), `当前推算值高于${reference.referenceLabel} ${formatPercent(Math.abs(comparison.differenceFraction) * 100)}。`, "good");
    } else if (comparison.status === "near_reference") {
      setNotice(byId("referenceNotice"), `当前推算值与${reference.referenceLabel}接近，差异 ${formatPercent(Math.abs(comparison.differenceFraction) * 100)}。`, "neutral");
    } else if (reference.planId === "pro_ambiguous") {
      setNotice(byId("referenceNotice"), "已识别为 Pro，但网页字段无法区分 5x/20x；请在下方手动选择档位。", "warn");
    } else {
      setNotice(byId("referenceNotice"), "尚无可比较的套餐绝对参考或当前额度估计。", "warn");
    }

    if (estimate.graceActive) {
      setNotice(byId("historyNotice"), "当前处于新周期保护期：不会把刚重置或套餐切换后的首个快照用于个人历史升降判断。", "subtle");
    } else if (estimate.trend === "possible_decrease") {
      setNotice(byId("historyNotice"), `相对个人历史基线可能下降 ${formatPercent(Math.abs(estimate.changeFraction) * 100)}。`, "bad");
    } else if (estimate.trend === "possible_increase") {
      setNotice(byId("historyNotice"), `相对个人历史基线可能上升 ${formatPercent(Math.abs(estimate.changeFraction) * 100)}。`, "good");
    } else if (estimate.trend === "stable_range") {
      setNotice(byId("historyNotice"), `与个人历史基线差异 ${formatPercent(Math.abs(estimate.changeFraction) * 100)}，未达到 ${formatPercent(estimate.thresholdFraction * 100)} 提示阈值。`, "neutral");
    } else {
      setNotice(byId("historyNotice"), "个人历史周期或当前样本不足，暂不判断长期变化。", "subtle");
    }
    if (referenceSettingsPending(report, settings)) {
      setNotice(byId("referenceNotice"), "套餐、参考或阈值设置已变化；当前报告保留捕获时上下文，重载 Usage 后再进行新比较。", "warn");
    }
    return report;
  }

  function renderResetCredits(rawState) {
    const state = Core.isRecord(rawState) ? rawState : {};
    const classification = Core.classifyResetCreditsState(state);
    const count = classification.availableCount;
    const nonExpiringCount = classification.nonExpiringObservedCount;
    const expiry = classification.nearestExpiresAt ? new Date(classification.nearestExpiresAt) : null;
    const expiryTime = expiry?.getTime() ?? null;
    const summaryObserved = formatDate(state.summaryObservedAt);
    const detailsObserved = formatDate(state.detailsObservedAt);
    const availableLabel = count == null ? "数量未知" : `${count} 个可用`;

    byId("resetCreditCount").textContent = count == null ? "尚未观察" : `${count} 个`;
    byId("resetCreditExpiry").textContent = expiryTime == null ? "—" : expiry.toLocaleString();
    byId("resetCreditObserved").textContent = count == null
      ? state.detailsLoaded ? `数量尚未观察 · 详情观测：${detailsObserved}` : "尚未观察到可用数量"
      : `数量观测：${summaryObserved}${state.detailsLoaded ? ` · 详情观测：${detailsObserved}` : ""}`;

    if (classification.status === "unknown") {
      setBadge(byId("resetCreditBadge"), "未知", "neutral");
      setNotice(byId("resetCreditNotice"), "打开 Usage 页面后进行纯被动观察。", "subtle");
    } else if (classification.status === "none") {
      setBadge(byId("resetCreditBadge"), "0 个可用", "neutral");
      setNotice(byId("resetCreditNotice"), "服务端最近一次摘要显示没有可用重置机会。", "subtle");
    } else if (classification.status === "count_only") {
      setBadge(byId("resetCreditBadge"), availableLabel, "good");
      setNotice(byId("resetCreditNotice"), "到期详情尚未被页面加载；扩展不会为此主动请求接口。", "warn");
    } else if (classification.status === "stale") {
      setBadge(byId("resetCreditBadge"), "缓存已过期", "bad");
      setNotice(byId("resetCreditNotice"), "最近已观测到期时间已经过去；数量不会由本地时钟扣减，请重载 Usage 页面复核。", "bad");
    } else if (classification.status === "danger") {
      setBadge(byId("resetCreditBadge"), "72 小时内到期", "bad");
      setNotice(byId("resetCreditNotice"), `有重置机会即将在 ${expiry.toLocaleString()} 到期。`, "bad");
    } else if (classification.status === "warning") {
      setBadge(byId("resetCreditBadge"), "7 天内到期", "warn");
      setNotice(byId("resetCreditNotice"), `最近已观测到期时间为 ${expiry.toLocaleString()}。`, "warn");
    } else if (classification.status === "available") {
      setBadge(byId("resetCreditBadge"), availableLabel, "good");
      setNotice(byId("resetCreditNotice"), `最近已观测到期时间为 ${expiry.toLocaleString()}。`, "good");
    } else if (classification.status === "non_expiring") {
      setBadge(byId("resetCreditBadge"), availableLabel, "good");
      setNotice(byId("resetCreditNotice"), `详情中观察到 ${nonExpiringCount} 个不设到期时间的可用项。`, "subtle");
    } else {
      setBadge(byId("resetCreditBadge"), availableLabel, "good");
      setNotice(byId("resetCreditNotice"), "详情已加载，但没有观察到有效到期时间。", "subtle");
    }
  }

  function routeStatus(status) {
    return {
      matched: ["字段一致", "good"],
      different: ["字段不同", "bad"],
      field_conflict: ["字段冲突", "warn"],
      insufficient: ["字段不足", "neutral"],
    }[status] || ["字段不足", "neutral"];
  }

  function renderRoutes(routes) {
    const list = Array.isArray(routes) ? routes : [];
    const latest = list.at(-1);
    if (!Core.isRecord(latest)) {
      byId("routeTimestamp").textContent = "尚无观察记录";
      setBadge(byId("routeBadge"), "字段不足", "neutral");
      return null;
    }
    const assessment = Core.routeAssessment(latest);
    const [label, tone] = routeStatus(assessment.status);
    setBadge(byId("routeBadge"), label, tone);
    byId("routeTimestamp").textContent = `观察：${formatDate(latest.observedAt)} · ${latest.phase || "—"}`;
    byId("requestedModel").textContent = safeText(assessment.requestedModel);
    byId("effectiveModel").textContent = safeText(assessment.effectiveModel);
    byId("resolvedModel").textContent = safeText(latest.resolvedModel);
    byId("serverModel").textContent = safeText(latest.serverModel);
    byId("assistantModel").textContent = safeText(latest.assistantModel);
    byId("routeSources").textContent = (Array.isArray(latest.sources) ? latest.sources : [latest.source]).filter(Boolean).join(" + ") || "—";
    return latest;
  }

  function renderSettings(settings) {
    byId("showOverlay").checked = settings.showOverlay;
    byId("captureCredits").checked = settings.captureCredits;
    byId("routeInspection").checked = settings.routeInspection;
    byId("planSelection").value = settings.planSelection;
    byId("referenceMode").value = settings.referenceMode;
    byId("customReferenceCredits").value = settings.customReferenceCredits ?? "";
    byId("customReferenceLabel").value = settings.customReferenceLabel || "";
    byId("alertThresholdPercent").value = settings.alertThresholdPercent;
    byId("referenceHelp").textContent = `内置社区基准版本：${Core.COMMUNITY_REFERENCE_VERSION}。绝对 Credits 均非 OpenAI 官方承诺。`;
  }

  async function readState() {
    const state = await api.storage.local.get([
      KEYS.creditLatest,
      KEYS.creditSnapshots,
      KEYS.captureStatus,
      KEYS.resetCreditsLatest,
      KEYS.routeObservations,
      KEYS.settings,
    ]);
    const settings = Core.normalizeSettings({
      ...Core.DEFAULT_SETTINGS,
      ...(Core.isRecord(state[KEYS.settings]) ? state[KEYS.settings] : {}),
    });
    const routes = Array.isArray(state[KEYS.routeObservations]) ? state[KEYS.routeObservations] : [];
    const latestRoute = renderRoutes(routes);
    const report = renderCredits(state[KEYS.creditLatest], state[KEYS.captureStatus], settings);
    renderResetCredits(state[KEYS.resetCreditsLatest]);
    renderSettings(settings);
    currentView = { state, settings, routes, latestRoute, report };
    return currentView;
  }

  function setStatus(text, error = false) {
    const element = byId("creditStatus");
    element.textContent = text;
    element.className = error ? "status error" : "status";
  }

  async function updateSettings(patch) {
    const current = (await api.storage.local.get(KEYS.settings))[KEYS.settings];
    const settings = Core.normalizeSettings({
      ...Core.DEFAULT_SETTINGS,
      ...(Core.isRecord(current) ? current : {}),
      ...patch,
    });
    await api.storage.local.set({ [KEYS.settings]: settings });
    return settings;
  }

  async function openOrReloadUsage() {
    const button = byId("captureCreditsNow");
    button.disabled = true;
    setStatus("将打开或重载 Usage；扩展只等待页面自身返回数据。", false);
    try {
      await updateSettings({ captureCredits: true });
      await api.storage.local.set({
        [KEYS.captureStatus]: {
          schemaVersion: 2,
          mode: "passive",
          state: "waiting",
          waitingFor: "usage_and_daily",
          updatedAt: new Date().toISOString(),
          pageUrl: USAGE_URL,
        },
      });
      const tabs = await api.tabs.query({ active: true, currentWindow: true });
      const active = tabs[0];
      if (active?.id && typeof active.url === "string" && active.url.startsWith(USAGE_URL)) {
        await api.tabs.reload(active.id);
      } else {
        await api.tabs.create({ url: USAGE_URL });
      }
      setStatus("Usage 已打开或重载；页面实际加载的数据会自动写入本地。", false);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error), true);
    } finally {
      button.disabled = false;
    }
  }

  async function saveReferenceSettings() {
    const settings = await updateSettings({
      planSelection: byId("planSelection").value,
      referenceMode: byId("referenceMode").value,
      customReferenceCredits: byId("customReferenceCredits").value,
      customReferenceLabel: byId("customReferenceLabel").value,
      alertThresholdPercent: byId("alertThresholdPercent").value,
    });
    renderSettings(settings);
    await readState();
    setStatus("参考与阈值已保存；套餐上下文将在下次 Usage 捕获时生效。", false);
  }

  async function calibrateCurrent() {
    const estimate = Number(currentView?.report?.estimate?.impliedQuotaCredits);
    if (!Number.isFinite(estimate) || estimate <= 0) {
      setStatus("当前尚无可用的 100% Credits 推算值，无法校准。", true);
      return;
    }
    const label = `${currentView?.report?.reference?.planLabel || "本机"} ${new Date().toLocaleDateString()} 校准`;
    const settings = await updateSettings({
      referenceMode: "custom",
      customReferenceCredits: Core.round(estimate, 3),
      customReferenceLabel: label,
    });
    renderSettings(settings);
    await readState();
    setStatus(`已将 ${formatCredits(estimate)} Credits 设为本机自定义参考；下次捕获生效。`, false);
  }

  function download(name, type, content) {
    const url = URL.createObjectURL(new Blob([content], { type }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = name;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function exportData() {
    const state = await api.storage.local.get(Object.values(KEYS));
    const payload = {
      exportedAt: new Date().toISOString(),
      extensionVersion: api.runtime.getManifest().version,
      ...state,
      disclaimer: "Passive local observations from private web interfaces; community references and estimates are not official OpenAI limits.",
    };
    download(`muofu-ai-quota-lens-${new Date().toISOString().replaceAll(":", "-")}.json`, "application/json", JSON.stringify(payload, null, 2));
  }

  async function clearRoutes() {
    await api.storage.local.remove(KEYS.routeObservations);
    await readState();
  }

  byId("version").textContent = `v${api.runtime.getManifest().version}`;
  byId("captureCreditsNow").addEventListener("click", () => void openOrReloadUsage());
  byId("openDashboard").addEventListener("click", () => void api.runtime.openOptionsPage());
  byId("exportData").addEventListener("click", () => void exportData());
  byId("clearRoutes").addEventListener("click", () => void clearRoutes());
  byId("saveReference").addEventListener("click", () => void saveReferenceSettings());
  byId("calibrateCurrent").addEventListener("click", () => void calibrateCurrent());
  byId("showOverlay").addEventListener("change", (event) => void updateSettings({ showOverlay: event.target.checked }));
  byId("captureCredits").addEventListener("change", (event) => void updateSettings({ captureCredits: event.target.checked }));
  byId("routeInspection").addEventListener("change", (event) => void updateSettings({ routeInspection: event.target.checked }));

  void readState();
  api.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local") return;
    if (Object.keys(changes).some((key) => Object.values(KEYS).includes(key))) void readState();
  });
})();
