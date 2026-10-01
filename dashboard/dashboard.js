(function () {
  "use strict";

  const Core = globalThis.CodexCreditsWatchCore;
  const api = globalThis.browser ?? globalThis.chrome;
  const KEYS = Core.STORAGE_KEYS;
  const USAGE_URL = "https://chatgpt.com/codex/settings/usage";
  const byId = (id) => document.getElementById(id);
  const SVG_NS = "http://www.w3.org/2000/svg";
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
  function text(value) { return typeof value === "string" && value ? value : "—"; }

  function download(name, type, content) {
    const url = URL.createObjectURL(new Blob([content], { type }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = name;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function svgElement(name, attributes = {}) {
    const element = document.createElementNS(SVG_NS, name);
    for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, String(value));
    return element;
  }

  function clearSvg(svg) {
    while (svg.firstChild) svg.firstChild.remove();
  }

  function drawAxes(svg, { width = 1000, height = 320, padding = 50, yMin = 0, yMax = 1, yLabel = "" } = {}) {
    const plotWidth = width - padding * 2;
    const plotHeight = height - padding * 2;
    for (let index = 0; index <= 4; index += 1) {
      const y = padding + (plotHeight * index) / 4;
      svg.append(svgElement("line", { x1: padding, x2: width - padding, y1: y, y2: y, class: "grid" }));
      const label = svgElement("text", { x: padding - 8, y: y + 3, "text-anchor": "end", class: "axis-label" });
      label.textContent = formatNumber(yMax - ((yMax - yMin) * index) / 4, 1);
      svg.append(label);
    }
    if (yLabel) {
      const label = svgElement("text", { x: 12, y: 18, class: "axis-label" });
      label.textContent = yLabel;
      svg.append(label);
    }
    return { padding, plotWidth, plotHeight };
  }

  function horizontalLine(svg, value, yMax, dimensions, className, titleText) {
    if (!Number.isFinite(value) || value <= 0 || yMax <= 0) return;
    const y = dimensions.padding + dimensions.plotHeight - (Math.min(value, yMax) / yMax) * dimensions.plotHeight;
    const line = svgElement("line", {
      x1: dimensions.padding,
      x2: dimensions.padding + dimensions.plotWidth,
      y1: y,
      y2: y,
      class: className,
    });
    const title = svgElement("title");
    title.textContent = titleText;
    line.append(title);
    svg.append(line);
  }

  function drawQuotaChart(snapshots, report) {
    const svg = byId("quotaChart");
    const empty = byId("quotaChartEmpty");
    clearSvg(svg);
    const points = (Array.isArray(snapshots) ? snapshots : [])
      .filter((sample) => Number.isFinite(Number(sample.impliedQuotaCredits)) && Number(sample.impliedQuotaCredits) > 0 && sample.capturedAt)
      .map((sample) => ({ x: new Date(sample.capturedAt).getTime(), y: Number(sample.impliedQuotaCredits), label: sample.capturedAt, confidence: sample.confidence }))
      .filter((point) => Number.isFinite(point.x))
      .sort((left, right) => left.x - right.x);
    if (points.length === 0) {
      empty.hidden = false;
      svg.hidden = true;
      return;
    }
    empty.hidden = true;
    svg.hidden = false;
    const width = 1000;
    const height = 320;
    const rawMin = Math.min(...points.map((point) => point.x));
    const rawMax = Math.max(...points.map((point) => point.x));
    const xMin = rawMin === rawMax ? rawMin - 12 * 60 * 60 * 1000 : rawMin;
    const xMax = rawMin === rawMax ? rawMax + 12 * 60 * 60 * 1000 : rawMax;
    const reference = report?.reference || {};
    const estimate = report?.estimate || {};
    const yCandidates = [
      ...points.map((point) => point.y),
      Number(reference.rangeMaxCredits),
      Number(reference.referenceCredits),
      Number(estimate.baselineQuotaCredits),
    ].filter((value) => Number.isFinite(value) && value > 0);
    const yMax = Math.max(1, ...yCandidates) * 1.12;
    const dimensions = drawAxes(svg, { width, height, yMin: 0, yMax, yLabel: "Credits" });

    const rangeMin = Number(reference.rangeMinCredits);
    const rangeMax = Number(reference.rangeMaxCredits);
    if (Number.isFinite(rangeMin) && Number.isFinite(rangeMax) && rangeMin > 0 && rangeMax >= rangeMin) {
      const top = dimensions.padding + dimensions.plotHeight - (Math.min(rangeMax, yMax) / yMax) * dimensions.plotHeight;
      const bottom = dimensions.padding + dimensions.plotHeight - (Math.min(rangeMin, yMax) / yMax) * dimensions.plotHeight;
      svg.append(svgElement("rect", {
        x: dimensions.padding,
        y: top,
        width: dimensions.plotWidth,
        height: Math.max(1, bottom - top),
        class: "reference-band",
      }));
    }
    horizontalLine(svg, Number(reference.referenceCredits), yMax, dimensions, "reference", `${reference.referenceLabel || "套餐参考"}: ${formatCredits(reference.referenceCredits)}`);
    horizontalLine(svg, Number(estimate.baselineQuotaCredits), yMax, dimensions, "baseline", `个人历史基线: ${formatCredits(estimate.baselineQuotaCredits)}`);

    const mapped = points.map((point) => ({
      ...point,
      sx: dimensions.padding + ((point.x - xMin) / (xMax - xMin)) * dimensions.plotWidth,
      sy: dimensions.padding + dimensions.plotHeight - (point.y / yMax) * dimensions.plotHeight,
    }));
    if (mapped.length >= 2) {
      const areaPath = [
        `M ${mapped[0].sx} ${dimensions.padding + dimensions.plotHeight}`,
        ...mapped.map((point) => `L ${point.sx} ${point.sy}`),
        `L ${mapped.at(-1).sx} ${dimensions.padding + dimensions.plotHeight}`,
        "Z",
      ].join(" ");
      svg.append(svgElement("path", { d: areaPath, class: "area" }));
      svg.append(svgElement("path", { d: mapped.map((point, index) => `${index === 0 ? "M" : "L"} ${point.sx} ${point.sy}`).join(" "), class: "line" }));
    }
    for (const point of mapped) {
      const circle = svgElement("circle", { cx: point.sx, cy: point.sy, r: mapped.length === 1 ? 6 : 4.5, class: "point" });
      const title = svgElement("title");
      title.textContent = `${formatDate(point.label)}: ${formatCredits(point.y)} Credits · ${point.confidence || "unknown"}`;
      circle.append(title);
      svg.append(circle);
    }
    const startLabel = svgElement("text", { x: dimensions.padding, y: height - 12, class: "axis-label" });
    startLabel.textContent = new Date(rawMin).toLocaleDateString();
    const endLabel = svgElement("text", { x: width - dimensions.padding, y: height - 12, "text-anchor": "end", class: "axis-label" });
    endLabel.textContent = new Date(rawMax).toLocaleDateString();
    svg.append(startLabel, endLabel);
  }

  function drawCycleChart(snapshots, report) {
    const svg = byId("cycleChart");
    const empty = byId("cycleChartEmpty");
    clearSvg(svg);
    const cycleStart = report?.weeklyWindow?.cycleStart || snapshots.at(-1)?.cycleStart;
    const points = (Array.isArray(snapshots) ? snapshots : [])
      .filter((sample) => cycleStart && sample.cycleStart === cycleStart && Number.isFinite(Number(sample.usedPercent)) && Number.isFinite(Number(sample.cycleCredits)))
      .map((sample) => ({ x: Number(sample.usedPercent), y: Number(sample.cycleCredits), capturedAt: sample.capturedAt }))
      .filter((point, index, values) => values.findIndex((candidate) => candidate.x === point.x && candidate.y === point.y) === index)
      .sort((left, right) => left.x - right.x);
    if (points.length === 0) {
      empty.hidden = false;
      svg.hidden = true;
      return;
    }
    empty.hidden = true;
    svg.hidden = false;
    const width = 1000;
    const height = 320;
    const reference = report?.reference || {};
    const estimate = report?.estimate || {};
    const lineCapacities = [Number(reference.rangeMaxCredits), Number(reference.referenceCredits), Number(estimate.impliedQuotaCredits)]
      .filter((value) => Number.isFinite(value) && value > 0);
    const yMax = Math.max(1, ...points.map((point) => point.y), ...lineCapacities) * 1.08;
    const dimensions = drawAxes(svg, { width, height, yMin: 0, yMax, yLabel: "累计 Credits" });
    for (let index = 0; index <= 4; index += 1) {
      const x = dimensions.padding + (dimensions.plotWidth * index) / 4;
      const label = svgElement("text", { x, y: height - 12, "text-anchor": index === 0 ? "start" : index === 4 ? "end" : "middle", class: "axis-label" });
      label.textContent = `${index * 25}%`;
      svg.append(label);
    }

    const rangeMin = Number(reference.rangeMinCredits);
    const rangeMax = Number(reference.rangeMaxCredits);
    if (Number.isFinite(rangeMin) && Number.isFinite(rangeMax) && rangeMin > 0 && rangeMax >= rangeMin) {
      const yHighAt100 = dimensions.padding + dimensions.plotHeight - (Math.min(rangeMax, yMax) / yMax) * dimensions.plotHeight;
      const yLowAt100 = dimensions.padding + dimensions.plotHeight - (Math.min(rangeMin, yMax) / yMax) * dimensions.plotHeight;
      const path = `M ${dimensions.padding} ${dimensions.padding + dimensions.plotHeight} L ${dimensions.padding + dimensions.plotWidth} ${yHighAt100} L ${dimensions.padding + dimensions.plotWidth} ${yLowAt100} Z`;
      svg.append(svgElement("path", { d: path, class: "reference-band" }));
    }

    function capacityLine(capacity, className, titleText) {
      if (!Number.isFinite(capacity) || capacity <= 0) return;
      const yAt100 = dimensions.padding + dimensions.plotHeight - (Math.min(capacity, yMax) / yMax) * dimensions.plotHeight;
      const line = svgElement("line", {
        x1: dimensions.padding,
        y1: dimensions.padding + dimensions.plotHeight,
        x2: dimensions.padding + dimensions.plotWidth,
        y2: yAt100,
        class: className,
      });
      const title = svgElement("title");
      title.textContent = titleText;
      line.append(title);
      svg.append(line);
    }
    capacityLine(Number(reference.referenceCredits), "reference", `${reference.referenceLabel || "套餐参考"}: ${formatCredits(reference.referenceCredits)}`);
    capacityLine(Number(estimate.impliedQuotaCredits), "line", `当前推算: ${formatCredits(estimate.impliedQuotaCredits)}`);

    for (const point of points) {
      const sx = dimensions.padding + (point.x / 100) * dimensions.plotWidth;
      const sy = dimensions.padding + dimensions.plotHeight - (point.y / yMax) * dimensions.plotHeight;
      const circle = svgElement("circle", { cx: sx, cy: sy, r: points.length === 1 ? 6 : 5, class: "scatter" });
      const title = svgElement("title");
      title.textContent = `${formatDate(point.capturedAt)}: ${formatPercent(point.x)} / ${formatCredits(point.y)} Credits`;
      circle.append(title);
      svg.append(circle);
    }
  }

  function drawDailyChart(report) {
    const svg = byId("dailyChart");
    const empty = byId("dailyChartEmpty");
    clearSvg(svg);
    const rows = Array.isArray(report?.dailyRows) ? report.dailyRows.slice(-90) : [];
    byId("dailyCount").textContent = `${rows.length} 天`;
    if (rows.length === 0) {
      empty.hidden = false;
      svg.hidden = true;
      return;
    }
    empty.hidden = true;
    svg.hidden = false;
    const width = 1000;
    const height = 320;
    const yMax = Math.max(1, ...rows.map((row) => Number(row.credits) || 0)) * 1.12;
    const dimensions = drawAxes(svg, { width, height, yMin: 0, yMax, yLabel: "每日 Credits" });
    const slot = dimensions.plotWidth / rows.length;
    const barWidth = Math.max(2, Math.min(30, slot * 0.72));
    rows.forEach((row, index) => {
      const value = Number(row.credits) || 0;
      const heightValue = (value / yMax) * dimensions.plotHeight;
      const x = dimensions.padding + slot * index + (slot - barWidth) / 2;
      const y = dimensions.padding + dimensions.plotHeight - heightValue;
      const rect = svgElement("rect", { x, y, width: barWidth, height: Math.max(1, heightValue), rx: 2, class: "bar" });
      const title = svgElement("title");
      title.textContent = `${row.date}: ${formatCredits(value)} Credits · ${formatNumber(row.turns, 0)} turns`;
      rect.append(title);
      svg.append(rect);
    });
    const labelIndexes = [...new Set([0, Math.floor((rows.length - 1) / 2), rows.length - 1])];
    for (const index of labelIndexes) {
      const x = dimensions.padding + slot * index + slot / 2;
      const label = svgElement("text", {
        x,
        y: height - 12,
        "text-anchor": index === 0 ? "start" : index === rows.length - 1 ? "end" : "middle",
        class: "axis-label",
      });
      label.textContent = rows[index].date;
      svg.append(label);
    }
  }

  function appendCell(row, value, className = "") {
    const cell = document.createElement("td");
    cell.textContent = value;
    if (className) cell.className = className;
    row.append(cell);
  }

  function statusPill(status) {
    const mapping = {
      restriction_suspected: ["疑似受限", "bad"],
      route_anomaly: ["路由异常", "warn"],
      fast_path_observed: ["Fast path", "warn"],
      consistent: ["证据一致", "good"],
      insufficient: ["证据不足", "neutral"],
    };
    const [label, tone] = mapping[status] || mapping.insufficient;
    const span = document.createElement("span");
    span.className = `status-pill ${tone}`;
    span.textContent = label;
    return span;
  }

  function modelFieldStatusLabel(status) {
    return {
      matched: "字段一致",
      different: "字段不同",
      field_conflict: "字段冲突",
      insufficient: "字段不足",
    }[status] || "字段不足";
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

  function transitionTypeLabel(type) {
    return {
      scheduled_reset: "计划 / 自然重置",
      early_reset: "提前重置 / 窗口重分配",
      window_rebased: "窗口重排",
      cycle_change: "周期变更",
      plan_change: "套餐上下文变化",
      user_manual_reset: "用户标记：主动重置",
      user_plan_change: "用户标记：套餐切换",
      user_boundary: "用户标记：分析边界",
    }[type] || type || "—";
  }

  function referenceSettingsPending(report, settings) {
    return Core.isRecord(report) && Core.isRecord(settings)
      ? !Core.creditReportMatchesSettings(report, settings)
      : false;
  }

  function renderSummary(report, captureStatus, settings, rawUsageLatest) {
    if (!Core.isRecord(report)) {
      const usageLatest = Core.isRecord(rawUsageLatest) ? rawUsageLatest : null;
      const weeklyWindow = Core.selectWeeklyWindow(Array.isArray(usageLatest?.windows) ? usageLatest.windows : []);
      byId("summaryCredits").textContent = "—";
      byId("summaryCaptured").textContent = usageLatest?.observedAt ? formatDate(usageLatest.observedAt) : "尚无快照";
      byId("summaryUsed").textContent = formatPercent(weeklyWindow?.usedPercent);
      byId("summaryReset").textContent = `重置：${formatDate(weeklyWindow?.resetAt)}`;
      byId("summaryQuota").textContent = "—";
      byId("summaryConfidence").textContent = weeklyWindow ? "直接限额 · 未进行 Credits 推算" : "置信度：—";
      byId("summaryReference").textContent = "—";
      byId("summaryReferenceDiff").textContent = "等待按日 Credits";
      byId("summaryBaselineValue").textContent = "—";
      byId("summaryHistoryDiff").textContent = "历史容量推算未生成";
      byId("summaryCapture").textContent = captureStatus?.state === "error" ? "解析失败" : weeklyWindow ? "主限额已捕获" : "等待中";
      byId("summaryCaptureRange").textContent = weeklyWindow ? "按日 Credits 未加载" : captureStatus?.waitingFor || "等待 Usage";
      byId("summaryCycleState").textContent = weeklyWindow ? "直接观察" : "—";
      byId("summaryCycleDetail").textContent = weeklyWindow ? "additional_rate_limits / ChatPass 不混入主额度" : "等待周期证据";
      return;
    }
    const estimate = Core.isRecord(report.estimate) ? report.estimate : {};
    const reference = Core.isRecord(report.reference) ? report.reference : {};
    const comparison = Core.isRecord(report.referenceComparison) ? report.referenceComparison : {};
    byId("summaryCredits").textContent = formatCredits(report.currentCycleStats?.credits);
    byId("summaryCaptured").textContent = formatDate(report.capturedAt);
    byId("summaryUsed").textContent = formatPercent(report.weeklyWindow?.usedPercent);
    byId("summaryReset").textContent = `重置：${formatDate(report.weeklyWindow?.resetAt)}`;
    byId("summaryQuota").textContent = formatCredits(estimate.impliedQuotaCredits);
    byId("summaryConfidence").textContent = `置信度：${text(estimate.confidence)}`;
    byId("summaryReference").textContent = formatCredits(reference.referenceCredits);
    byId("summaryReferenceDiff").textContent = comparison.differenceFraction == null
      ? reference.referenceLabel || "尚未设置"
      : `${comparison.status === "provisional" ? "暂定 · " : ""}${comparison.differenceFraction >= 0 ? "+" : "−"}${formatPercent(Math.abs(comparison.differenceFraction) * 100)} · ${reference.referenceLabel}`;
    if (referenceSettingsPending(report, settings)) {
      byId("summaryReferenceDiff").textContent = "设置已变化 · 等待重载 Usage 后重新捕获";
    }
    byId("summaryBaselineValue").textContent = formatCredits(estimate.baselineQuotaCredits);
    const baselineMethod = estimate.baselineCycles
      ? ` · ${estimate.baselineDeltaCycles || 0} 增量/${estimate.baselinePointCycles || 0} 单点`
      : "";
    byId("summaryHistoryDiff").textContent = estimate.changeFraction == null
      ? `历史样本：${estimate.baselineCycles || 0} 周${baselineMethod}`
      : `${estimate.changeFraction >= 0 ? "+" : "−"}${formatPercent(Math.abs(estimate.changeFraction) * 100)} · ${estimate.baselineCycles || 0} 周${baselineMethod}`;
    byId("summaryCapture").textContent = captureStatus?.state === "captured" ? "已捕获" : "已有报告";
    byId("summaryCaptureRange").textContent = report.lookbackStart && report.lookbackEnd
      ? `${report.lookbackStart} → ${report.lookbackEnd}`
      : `${report.dailyRows?.length || 0} 天`;
    const awareness = Core.isRecord(report.resetAwareness) ? report.resetAwareness : {};
    const transition = Core.isRecord(awareness.transition) ? awareness.transition : null;
    byId("summaryCycleState").textContent = awareness.graceActive
      ? "新周期保护"
      : transition
        ? transitionTypeLabel(transition.type)
        : "稳定观测";
    byId("summaryCycleDetail").textContent = awareness.graceActive
      ? "等待同周期第二个快照后再进行额度升降判断"
      : awareness.boundaryDayAmbiguous
        ? "边界日按日汇总存在偏移风险，增量估计会优先使用"
        : `兼容历史基线 ${estimate.baselineCycles || 0} 周`;
  }

  function renderResetCredits(rawState) {
    const state = Core.isRecord(rawState) ? rawState : {};
    const classification = Core.classifyResetCreditsState(state);
    const count = classification.availableCount;
    const nonExpiringCount = classification.nonExpiringObservedCount;
    const expiry = classification.nearestExpiresAt ? new Date(classification.nearestExpiresAt) : null;
    const expiryTime = expiry?.getTime() ?? null;
    const health = byId("resetCreditHealth");
    let label = "尚未观察到服务端摘要";
    let tone = "neutral";

    byId("resetCreditCount").textContent = count == null ? "尚未观察" : `${count} 个`;
    byId("resetCreditExpiry").textContent = expiryTime == null ? "—" : expiry.toLocaleString();
    byId("resetCreditSummaryObserved").textContent = formatDate(state.summaryObservedAt);
    byId("resetCreditDetailsObserved").textContent = formatDate(state.detailsObservedAt);
    byId("summaryResetCredits").textContent = count == null
      ? classification.status === "unknown" ? "—" : "数量未知"
      : `${count} 个`;

    if (classification.status === "unknown") {
      byId("summaryResetCreditExpiry").textContent = "尚未观察";
    } else if (classification.status === "none") {
      label = "服务端最近摘要：没有可用重置机会";
      byId("summaryResetCreditExpiry").textContent = "无可用项";
    } else if (classification.status === "count_only") {
      label = "到期详情尚未被页面加载；扩展不会主动请求";
      tone = "warn";
      byId("summaryResetCreditExpiry").textContent = "到期详情未加载";
    } else if (classification.status === "stale") {
      label = "最近到期时间已过；缓存可能过期，请重载 Usage";
      tone = "bad";
      byId("summaryResetCreditExpiry").textContent = "缓存可能过期";
    } else if (classification.status === "danger") {
      label = `紧急：有重置机会将在 ${expiry.toLocaleString()} 到期`;
      tone = "bad";
      byId("summaryResetCreditExpiry").textContent = `72 小时内 · ${expiry.toLocaleString()}`;
    } else if (classification.status === "warning") {
      label = `临期：最近已观测到期为 ${expiry.toLocaleString()}`;
      tone = "warn";
      byId("summaryResetCreditExpiry").textContent = `7 天内 · ${expiry.toLocaleString()}`;
    } else if (classification.status === "available") {
      label = `最近已观测到期为 ${expiry.toLocaleString()}`;
      tone = "good";
      byId("summaryResetCreditExpiry").textContent = expiry.toLocaleString();
    } else if (classification.status === "non_expiring") {
      label = `详情中观察到 ${nonExpiringCount} 个不设到期时间的可用项`;
      tone = "good";
      byId("summaryResetCreditExpiry").textContent = `${nonExpiringCount} 个不设到期`;
    } else {
      label = "详情已加载，但没有观察到有效到期时间";
      byId("summaryResetCreditExpiry").textContent = "未观察到到期时间";
    }

    health.textContent = label;
    health.className = `health ${tone}`;
  }


  function formatBoolean(value) {
    return typeof value === "boolean" ? String(value) : "—";
  }

  function accountDescriptorSummary(items, observed, mode = "generic") {
    if (!observed) return "—";
    const list = Array.isArray(items) ? items : [];
    if (list.length === 0) return "无";
    return list.map((item) => {
      const name = item?.name || "未命名";
      if (mode === "progress") {
        const remaining = item?.remaining == null ? "" : `剩余 ${formatNumber(item.remaining, 0)}`;
        const reset = item?.resetAt ? `重置 ${formatDate(item.resetAt)}` : "";
        return [name, remaining, reset].filter(Boolean).join(" · ");
      }
      const flags = [];
      if (item?.blocked === true) flags.push("blocked");
      if (item?.limitReached === true) flags.push("limit_reached");
      if (item?.available === false) flags.push("unavailable");
      return flags.length > 0 ? `${name} (${flags.join("/")})` : name;
    }).join("; ");
  }

  function accountModelUsageSummary(items, observed) {
    if (!observed) return "—";
    const list = Array.isArray(items) ? items : [];
    if (list.length === 0) return "无";
    return list.map((item) => {
      const state = item?.available === true ? "可用" : item?.available === false ? "不可用" : "状态未知";
      const availableAt = item?.availableAt ? ` · ${formatDate(item.availableAt)}` : "";
      return `${item?.modelSlug || "未命名"}: ${state}${availableAt}`;
    }).join("; ");
  }

  function renderAccountLimits(rawState) {
    const classification = Core.classifyAccountLimitState(rawState);
    const usageObserved = Boolean(classification.usageObservedAt);
    const conversationObserved = Boolean(classification.conversationObservedAt);
    const health = byId("accountLimitHealth");

    byId("accountAllowed").textContent = formatBoolean(classification.allowed);
    byId("accountLimitReached").textContent = formatBoolean(classification.limitReached);
    byId("accountUsedPercent").textContent = formatPercent(classification.primaryUsedPercent);
    byId("accountResetAt").textContent = formatDate(classification.primaryResetAt);
    byId("accountRateLimitType").textContent = text(classification.rateLimitReachedType);
    byId("accountOverage").textContent = formatBoolean(classification.overageLimitReached);
    byId("accountSpendControl").textContent = formatBoolean(classification.spendControlReached);
    byId("blockedFeatures").textContent = accountDescriptorSummary(classification.blockedFeatures, conversationObserved);
    byId("modelLimits").textContent = accountDescriptorSummary(classification.modelLimits, conversationObserved);
    byId("modelUsage").textContent = accountModelUsageSummary(classification.modelUsage, usageObserved);
    byId("limitsProgress").textContent = accountDescriptorSummary(classification.limitsProgress, conversationObserved, "progress");
    byId("accountDefaultModel").textContent = text(classification.defaultModelSlug);
    byId("accountIntendedDefaultModel").textContent = text(classification.intendedDefaultModelSlug);
    byId("accountUsageObservedAt").textContent = formatDate(classification.usageObservedAt);
    byId("accountConversationObservedAt").textContent = formatDate(classification.conversationObservedAt);
    byId("accountLimitObserved").textContent = usageObserved || conversationObserved
      ? [usageObserved ? "Usage" : null, conversationObserved ? "conversation/init" : null].filter(Boolean).join(" + ")
      : "尚未观察";

    let summary = "未知";
    let detail = "尚未观察";
    let label = "尚未观察到限制状态";
    let tone = "neutral";
    if (classification.status === "hard_limit") {
      summary = "硬限制";
      detail = classification.allowed === false ? "allowed=false" : "limit_reached=true";
      label = "已观测到账户主限额的硬限制信号";
      tone = "bad";
    } else if (classification.status === "rate_limit_state") {
      summary = "限额状态";
      detail = classification.rateLimitReachedType || "rate_limit_reached_type";
      label = "服务端已返回 rate-limit reached 状态";
      tone = "bad";
    } else if (classification.status === "spend_limit") {
      summary = "Spend 限制";
      detail = "spend_control.reached=true";
      label = "服务端 spend control 已达到限制";
      tone = "bad";
    } else if (classification.status === "overage_limit") {
      summary = "超额限制";
      detail = "overage_limit_reached=true";
      label = "服务端已返回超额限制信号";
      tone = "bad";
    } else if (classification.status === "capability_limited") {
      summary = "能力受限";
      const names = [
        ...classification.blockedFeatures.map((item) => item?.name),
        ...classification.modelLimits.map((item) => item?.name),
        ...classification.exhaustedFeatures.map((item) => item?.name),
      ].filter(Boolean);
      detail = names.join(", ") || "存在功能/模型限制项";
      label = "已观测到功能、模型或功能余量限制";
      tone = "warn";
    } else if (classification.status === "clear") {
      summary = "未见限制";
      detail = classification.primaryUsedPercent == null
        ? "已观测限制状态"
        : `主额度已用 ${formatPercent(classification.primaryUsedPercent)}`;
      label = "当前已观测字段未显示账户或能力限制";
      tone = "good";
    }
    byId("summaryAccountLimit").textContent = summary;
    byId("summaryAccountLimitDetail").textContent = detail;
    health.textContent = label;
    health.className = `health ${tone}`;
    return classification;
  }

  function renderSettings(settings, report) {
    byId("planSelection").value = settings.planSelection;
    byId("referenceMode").value = settings.referenceMode;
    byId("customReferenceCredits").value = settings.customReferenceCredits ?? "";
    byId("customReferenceLabel").value = settings.customReferenceLabel || "";
    byId("alertThresholdPercent").value = settings.alertThresholdPercent;
    byId("captureCredits").checked = settings.captureCredits;
    byId("routeInspection").checked = settings.routeInspection;
    byId("showOverlay").checked = settings.showOverlay;
    byId("referenceVersion").textContent = Core.COMMUNITY_REFERENCE_VERSION;
    const reference = report?.reference || Core.resolveCreditReference(settings, [], null);
    byId("resolvedPlan").textContent = reference.planLabel || "未识别";
    byId("resolvedPlanSource").textContent = planSourceLabel(reference.planSource);
    byId("resolvedReferenceLabel").textContent = reference.referenceLabel || "—";
    byId("resolvedReferenceRange").textContent = reference.rangeMinCredits && reference.rangeMaxCredits
      ? `${formatCredits(reference.rangeMinCredits)}–${formatCredits(reference.rangeMaxCredits)} Credits`
      : reference.referenceCredits
        ? `${formatCredits(reference.referenceCredits)} Credits`
        : "—";
    byId("resolvedMultiplier").textContent = reference.officialMultiplier ? `${reference.officialMultiplier}× Plus` : "—";
    byId("referenceBasis").textContent = reference.basis || "该套餐没有内置绝对 Credits 参考，可切换为用户自定义。";
  }

  function renderCommunityRows() {
    const body = byId("communityRows");
    body.replaceChildren();
    for (const item of Object.values(Core.COMMUNITY_PLAN_REFERENCES)) {
      const row = document.createElement("tr");
      appendCell(row, item.label);
      appendCell(row, formatCredits(item.credits));
      appendCell(row, `${formatCredits(item.minCredits)}–${formatCredits(item.maxCredits)}`);
      body.append(row);
    }
  }

  function renderCaptureStatus(status, settings) {
    const health = byId("captureHealth");
    let label = "等待 Usage 页面自身请求";
    let tone = "neutral";
    if (!settings.captureCredits) {
      label = "被动 Credits 观察已关闭";
      tone = "neutral";
    } else if (status?.state === "captured") {
      label = "已同时捕获限额与按日用量响应";
      tone = "good";
    } else if (status?.state === "limits_captured") {
      label = "主限额已捕获；按日 Credits 未由当前页面加载";
      tone = "good";
    } else if (status?.state === "error") {
      label = `响应解析失败：${status.errorCode || "未知错误"}`;
      tone = "bad";
    } else if (status?.waitingFor === "daily") {
      label = "已见限额响应，等待按日用量响应";
      tone = "warn";
    } else if (status?.waitingFor === "usage") {
      label = "已见按日用量响应，等待限额响应";
      tone = "warn";
    } else if (status?.state === "ready" || status?.state === "waiting" || status?.state === "building") {
      label = "页面钩子已就绪，等待或组合响应";
      tone = "neutral";
    }
    health.textContent = label;
    health.className = `health ${tone}`;
    byId("usageObservedAt").textContent = formatDate(status?.usageObservedAt);
    byId("dailyObservedAt").textContent = formatDate(status?.dailyObservedAt);
    byId("capturedDateRange").textContent = status?.dailyStartDate && status?.dailyEndDate
      ? `${status.dailyStartDate} 至 ${status.dailyEndDate}`
      : "—";
    byId("capturedRowCount").textContent = status?.dailyRowCount == null ? "—" : `${status.dailyRowCount} 天`;
  }

  function renderCycleTransitions(snapshots, cycleEvents, report) {
    const body = byId("transitionRows");
    body.replaceChildren();
    const transitions = Array.isArray(report?.cycleTransitions)
      ? report.cycleTransitions
      : Core.detectCycleTransitions(snapshots, cycleEvents);
    byId("transitionCount").textContent = `${transitions.length} 个边界`;
    for (const item of [...transitions].reverse()) {
      const row = document.createElement("tr");
      appendCell(row, formatDate(item.observedAt));
      appendCell(row, transitionTypeLabel(item.type));
      appendCell(row, item.source === "user" ? "用户本地标记" : "快照推断");
      appendCell(row, item.summary || "—");
      body.append(row);
    }
    if (transitions.length === 0) {
      const row = document.createElement("tr");
      const cell = document.createElement("td");
      cell.colSpan = 4;
      cell.textContent = "尚未观察到周期边界。自然周重置后会自动出现；主动重置或套餐切换也可手动标记。";
      row.append(cell);
      body.append(row);
    }
  }

  function renderSnapshotRows(snapshots) {
    const body = byId("snapshotRows");
    body.replaceChildren();
    for (const sample of [...snapshots].reverse()) {
      const row = document.createElement("tr");
      appendCell(row, formatDate(sample.capturedAt));
      appendCell(row, sample.cycleStart ? new Date(sample.cycleStart).toLocaleDateString() : "—");
      appendCell(row, formatPercent(sample.usedPercent));
      appendCell(row, formatCredits(sample.cycleCredits));
      appendCell(row, formatCredits(sample.impliedQuotaCredits));
      appendCell(row, sample.referenceCredits == null ? "—" : `${formatCredits(sample.referenceCredits)} · ${sample.referenceMode || "—"}`);
      appendCell(row, text(sample.confidence));
      body.append(row);
    }
    if (snapshots.length === 0) {
      const row = document.createElement("tr");
      const cell = document.createElement("td");
      cell.colSpan = 7;
      cell.textContent = "尚无额度快照。";
      row.append(cell);
      body.append(row);
    }
  }

  function renderDailyRows(report) {
    const body = byId("dailyRows");
    body.replaceChildren();
    const rows = Array.isArray(report?.dailyRows) ? [...report.dailyRows].reverse() : [];
    for (const item of rows) {
      const row = document.createElement("tr");
      appendCell(row, item.date || "—");
      appendCell(row, formatCredits(item.credits));
      appendCell(row, formatNumber(item.turns, 0));
      appendCell(row, formatNumber(item.totalTokens, 0));
      appendCell(row, formatNumber(item.cachedInputTokens, 0));
      appendCell(row, formatNumber(item.uncachedInputTokens, 0));
      appendCell(row, formatNumber(item.outputTokens, 0));
      body.append(row);
    }
    if (rows.length === 0) {
      const row = document.createElement("tr");
      const cell = document.createElement("td");
      cell.colSpan = 7;
      cell.textContent = "最新报告中没有按日数据。";
      row.append(cell);
      body.append(row);
    }
  }

  function renderRouteRows(routes) {
    const body = byId("routeRows");
    body.replaceChildren();
    for (const item of [...routes].reverse()) {
      const assessment = Core.routeAssessment(item);
      const row = document.createElement("tr");
      appendCell(row, formatDate(item.observedAt));
      appendCell(row, text(assessment.requestedModel));
      appendCell(row, text(assessment.effectiveModel));
      const statusCell = document.createElement("td");
      statusCell.append(statusPill(assessment.diagnosticStatus));
      row.append(statusCell);
      appendCell(row, modelFieldStatusLabel(assessment.status));
      appendCell(row, typeof item.fastConvo === "boolean" ? String(item.fastConvo) : "—");
      appendCell(row, text(item.thinkingEffort));
      appendCell(row, assessment.reasoningDurationSec == null ? "—" : `${formatNumber(assessment.reasoningDurationSec, 1)} 秒`);
      appendCell(row, text(item.requestedModelExperience));
      appendCell(row, text(item.turnUseCase));
      appendCell(row, text(item.resolvedModel));
      appendCell(row, text(item.serverModel));
      appendCell(row, text(item.assistantModel));
      appendCell(row, text(item.planType));
      appendCell(row, (Array.isArray(item.sources) ? item.sources : [item.source]).filter(Boolean).join(" + ") || "—");
      body.append(row);
    }
    if (routes.length === 0) {
      const row = document.createElement("tr");
      const cell = document.createElement("td");
      cell.colSpan = 15;
      cell.textContent = "尚无路由与执行观察。";
      row.append(cell);
      body.append(row);
    }
  }

  function anomalyTitle(code) {
    return {
      usage_percent_reversal: "同周期已用百分比回退",
      credit_total_reversal: "同周期累计 Credits 回退",
      usage_increase_without_daily_delta: "限额百分比与按日汇总暂未对齐",
      abrupt_usage_jump: "短时间内已用比例较大跃升",
    }[code] || code;
  }

  function renderAnomalies(snapshots, report, cycleEvents = []) {
    const list = byId("anomalyList");
    list.replaceChildren();
    const anomalies = Array.isArray(report?.anomalies)
      ? report.anomalies
      : Core.detectCreditAnomalies(snapshots, { analysisEvents: cycleEvents });
    byId("anomalyCount").textContent = `${anomalies.length} 条`;
    if (anomalies.length === 0) {
      const empty = document.createElement("div");
      empty.className = "anomaly-empty";
      empty.textContent = snapshots.length < 2 ? "至少需要两个快照才能检查数值一致性。" : "当前本地快照中没有触发规则的异常事件。";
      list.append(empty);
      return;
    }
    for (const item of [...anomalies].reverse()) {
      const article = document.createElement("article");
      article.className = `anomaly ${item.severity === "warning" ? "warning" : "notice"}`;
      const marker = document.createElement("span");
      marker.className = "marker";
      const content = document.createElement("div");
      const title = document.createElement("strong");
      title.textContent = anomalyTitle(item.code);
      const description = document.createElement("p");
      description.textContent = `${item.summary} 变化：已用 ${item.usedDelta >= 0 ? "+" : ""}${formatPercent(item.usedDelta)}，Credits ${item.creditsDelta >= 0 ? "+" : ""}${formatCredits(item.creditsDelta)}，Tokens ${item.tokensDelta >= 0 ? "+" : ""}${formatNumber(item.tokensDelta, 0)}。`;
      content.append(title, description);
      const time = document.createElement("time");
      time.dateTime = item.observedAt || "";
      time.textContent = formatDate(item.observedAt);
      article.append(marker, content, time);
      list.append(article);
    }
  }

  async function readState() {
    const state = await api.storage.local.get(Object.values(KEYS));
    const snapshots = Array.isArray(state[KEYS.creditSnapshots]) ? state[KEYS.creditSnapshots] : [];
    const routes = Array.isArray(state[KEYS.routeObservations]) ? state[KEYS.routeObservations] : [];
    const cycleEvents = Core.normalizeCycleEvents(state[KEYS.cycleEvents]);
    const settings = Core.normalizeSettings({
      ...Core.DEFAULT_SETTINGS,
      ...(Core.isRecord(state[KEYS.settings]) ? state[KEYS.settings] : {}),
    });
    const report = Core.isRecord(state[KEYS.creditLatest])
      ? state[KEYS.creditLatest]
      : null;
    const usageLatest = Core.isRecord(state[KEYS.usageLatest]) ? state[KEYS.usageLatest] : null;
    const captureStatus = Core.isRecord(state[KEYS.captureStatus]) ? state[KEYS.captureStatus] : null;
    renderSummary(report, captureStatus, settings, usageLatest);
    renderResetCredits(state[KEYS.resetCreditsLatest]);
    const accountLimits = renderAccountLimits(state[KEYS.accountLimitsLatest]);
    renderSettings(settings, report);
    renderCaptureStatus(captureStatus, settings);
    renderCycleTransitions(snapshots, cycleEvents, report);
    renderSnapshotRows(snapshots);
    renderDailyRows(report);
    renderRouteRows(routes);
    renderAnomalies(snapshots, report, cycleEvents);
    byId("snapshotCount").textContent = `${snapshots.length} 个快照`;
    byId("routeCount").textContent = `${routes.length} 条记录`;
    drawQuotaChart(snapshots, report);
    drawCycleChart(snapshots, report);
    drawDailyChart(report);
    currentView = { state, report, usageLatest, accountLimits, snapshots, routes, cycleEvents, settings, captureStatus };
    return currentView;
  }

  async function saveSettings(event) {
    event?.preventDefault();
    const current = (await api.storage.local.get(KEYS.settings))[KEYS.settings];
    const settings = Core.normalizeSettings({
      ...Core.DEFAULT_SETTINGS,
      ...(Core.isRecord(current) ? current : {}),
      planSelection: byId("planSelection").value,
      referenceMode: byId("referenceMode").value,
      customReferenceCredits: byId("customReferenceCredits").value,
      customReferenceLabel: byId("customReferenceLabel").value,
      alertThresholdPercent: byId("alertThresholdPercent").value,
      captureCredits: byId("captureCredits").checked,
      routeInspection: byId("routeInspection").checked,
      showOverlay: byId("showOverlay").checked,
    });
    await api.storage.local.set({ [KEYS.settings]: settings });
    byId("settingsStatus").textContent = "设置已保存到本机；套餐参考将在下次 Usage 捕获时生效。";
    byId("settingsStatus").className = "form-status";
    await readState();
  }

  async function calibrateCurrent() {
    const estimate = Number(currentView?.report?.estimate?.impliedQuotaCredits);
    if (!Number.isFinite(estimate) || estimate <= 0) {
      byId("settingsStatus").textContent = "当前尚无可用的 100% Credits 推算值。";
      byId("settingsStatus").className = "form-status error";
      return;
    }
    byId("referenceMode").value = "custom";
    byId("customReferenceCredits").value = String(Core.round(estimate, 3));
    if (!byId("customReferenceLabel").value) {
      byId("customReferenceLabel").value = `${currentView.report.reference?.planLabel || "本机"} ${new Date().toLocaleDateString()} 校准`;
    }
    await saveSettings();
    byId("settingsStatus").textContent = `已将 ${formatCredits(estimate)} Credits 设为自定义参考；下次捕获生效。`;
  }

  async function restoreCommunity() {
    byId("referenceMode").value = "community";
    byId("customReferenceCredits").value = "";
    byId("customReferenceLabel").value = "";
    await saveSettings();
    byId("settingsStatus").textContent = "已恢复内置社区参考模式；下次捕获生效。";
  }

  async function markCycleEvent() {
    const type = byId("cycleEventType").value;
    if (!Core.CYCLE_EVENT_TYPES.includes(type)) return;
    const stored = await api.storage.local.get(KEYS.cycleEvents);
    const existing = Core.normalizeCycleEvents(stored[KEYS.cycleEvents]);
    const selectedPlan = currentView?.settings?.planSelection;
    const event = Core.sanitizeCycleEvent({
      id: `manual-${crypto.randomUUID()}`,
      type,
      observedAt: new Date().toISOString(),
      planId: selectedPlan && selectedPlan !== "auto" ? selectedPlan : currentView?.report?.reference?.planId,
    });
    if (!event) return;
    await api.storage.local.set({ [KEYS.cycleEvents]: Core.normalizeCycleEvents([...existing, event]) });
    byId("cycleEventStatus").textContent = `${transitionTypeLabel(type === "manual_reset" ? "user_manual_reset" : type === "plan_change" ? "user_plan_change" : "user_boundary")}已记录；将重载 Usage 获取新边界后的第一个快照。`;
    await openOrReloadUsage();
  }

  async function removeLastCycleEvent() {
    const stored = await api.storage.local.get(KEYS.cycleEvents);
    const existing = Core.normalizeCycleEvents(stored[KEYS.cycleEvents]);
    if (existing.length === 0) {
      byId("cycleEventStatus").textContent = "没有可撤销的手动边界标记。";
      return;
    }
    const removed = existing.pop();
    await api.storage.local.set({ [KEYS.cycleEvents]: existing });
    byId("cycleEventStatus").textContent = `已撤销 ${formatDate(removed.observedAt)} 的手动标记。建议重载 Usage 重新生成报告。`;
    await readState();
  }

  async function openOrReloadUsage() {
    await api.storage.local.set({
      [KEYS.captureStatus]: {
        schemaVersion: 2,
        mode: "passive",
        state: "waiting",
        waitingFor: "usage",
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
  }

  async function exportJson() {
    const { state } = await readState();
    download(
      `muofu-ai-quota-lens-${new Date().toISOString().replaceAll(":", "-")}.json`,
      "application/json",
      JSON.stringify({ exportedAt: new Date().toISOString(), version: api.runtime.getManifest().version, ...state }, null, 2),
    );
  }

  async function exportCsv() {
    const { snapshots } = await readState();
    const csv = Core.rowsToCsv(
      ["captured_at", "cycle_start", "reset_at", "used_percent", "cycle_credits", "cycle_tokens", "implied_quota_credits", "reference_plan", "reference_mode", "reference_credits", "confidence", "comparison_eligible", "boundary_day_ambiguous", "transition_type"],
      snapshots.map((sample) => [
        sample.capturedAt,
        sample.cycleStart,
        sample.resetAt,
        sample.usedPercent,
        sample.cycleCredits,
        sample.cycleTokens,
        sample.impliedQuotaCredits,
        sample.referencePlanId,
        sample.referenceMode,
        sample.referenceCredits,
        sample.confidence,
        sample.comparisonEligible,
        sample.boundaryDayAmbiguous,
        sample.transitionType,
      ]),
    );
    download(`muofu-ai-quota-lens-snapshots-${new Date().toISOString().slice(0, 10)}.csv`, "text/csv;charset=utf-8", csv);
  }

  async function clearAll() {
    const accepted = confirm("确定清空全部 Credits 快照、最新报告、捕获状态、手动周期边界和路由/执行观察吗？扩展设置将保留。");
    if (!accepted) return;
    await api.storage.local.remove([KEYS.creditLatest, KEYS.usageLatest, KEYS.accountLimitsLatest, KEYS.creditSnapshots, KEYS.captureStatus, KEYS.resetCreditsLatest, KEYS.routeObservations, KEYS.cycleEvents]);
    await readState();
  }

  renderCommunityRows();
  byId("footerVersion").textContent = `v${api.runtime.getManifest().version}`;
  byId("settingsForm").addEventListener("submit", (event) => void saveSettings(event));
  byId("calibrateCurrent").addEventListener("click", () => void calibrateCurrent());
  byId("restoreCommunity").addEventListener("click", () => void restoreCommunity());
  byId("markCycleEvent").addEventListener("click", () => void markCycleEvent());
  byId("removeLastCycleEvent").addEventListener("click", () => void removeLastCycleEvent());
  byId("openAnalytics").addEventListener("click", () => void openOrReloadUsage());
  byId("exportJson").addEventListener("click", () => void exportJson());
  byId("exportCsv").addEventListener("click", () => void exportCsv());
  byId("clearAll").addEventListener("click", () => void clearAll());
  void readState();
  api.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === "local" && Object.keys(changes).some((key) => Object.values(KEYS).includes(key))) void readState();
  });
})();