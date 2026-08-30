(function () {
  "use strict";

  const Core = globalThis.CodexCreditsWatchCore;
  if (!Core || globalThis.__codexCreditsWatchPageHookInstalled) return;
  globalThis.__codexCreditsWatchPageHookInstalled = true;

  const ALLOWED_ORIGINS = new Set(["https://chatgpt.com"]);
  const PAGE_SOURCE = "codex-credits-watch-page";
  const BRIDGE_SOURCE = "codex-credits-watch-bridge";
  const MAX_STREAM_EVENT_BYTES = 1024 * 1024;
  const MAX_ROUTE_RECORD_BYTES = 8 * 1024 * 1024;
  const MAX_USAGE_BYTES = 1024 * 1024;
  const MAX_RESET_CREDITS_BYTES = 1024 * 1024;
  const MAX_DAILY_BYTES = 4 * 1024 * 1024;
  const MAX_PENDING = 32;
  const PENDING_TTL_MS = 10 * 60 * 1000;
  const nativeFetch = globalThis.fetch;
  const nativeWebSocket = globalThis.WebSocket;
  const sessionId = crypto.randomUUID();
  const pending = new Map();
  let preferences = {
    captureCredits: true,
    routeInspection: true,
  };

  function now() {
    return new Date().toISOString();
  }

  function safePageUrl() {
    return `${location.origin}${location.pathname}`.slice(0, 512);
  }

  function post(type, payload) {
    if (!ALLOWED_ORIGINS.has(location.origin)) return;
    globalThis.postMessage({
      source: PAGE_SOURCE,
      version: 2,
      type,
      payload,
    }, location.origin);
  }

  function emitRoute(observation) {
    if (!preferences.routeInspection) return;
    const sanitized = Core.sanitizeRouteObservation(observation);
    if (sanitized) post("route-observation", sanitized);
  }

  function emitCredit(observation) {
    if (!preferences.captureCredits) return;
    const sanitized = Core.sanitizeCreditObservation(observation);
    if (sanitized) post("credit-observation", sanitized);
  }

  function emitHookStatus(status, extra = {}) {
    post("hook-status", {
      schemaVersion: 2,
      sessionId,
      status,
      observedAt: now(),
      pageUrl: safePageUrl(),
      captureCredits: Boolean(preferences.captureCredits),
      routeInspection: Boolean(preferences.routeInspection),
      endpointKind: Core.safeIdentifier(extra.endpointKind, 64),
      errorCode: Core.safeIdentifier(extra.errorCode, 96),
    });
  }

  function onBridgeMessage(event) {
    if (event.source !== globalThis || event.origin !== location.origin || !ALLOWED_ORIGINS.has(event.origin)) return;
    const envelope = event.data;
    if (!Core.isRecord(envelope)
      || envelope.source !== BRIDGE_SOURCE
      || envelope.version !== 2
      || envelope.type !== "preferences"
      || !Core.isRecord(envelope.payload)) return;
    preferences = {
      captureCredits: Boolean(envelope.payload.captureCredits),
      routeInspection: Boolean(envelope.payload.routeInspection),
    };
    emitHookStatus("preferences-applied");
  }

  function requestUrl(input) {
    try {
      return input instanceof Request ? input.url : String(input);
    } catch {
      return "";
    }
  }

  function requestMethod(input, init) {
    const method = init?.method || (input instanceof Request ? input.method : "GET");
    return String(method || "GET").toUpperCase();
  }

  function classifyEndpoint(rawUrl, method) {
    try {
      const url = new URL(rawUrl, location.href);
      if (url.origin !== location.origin || !ALLOWED_ORIGINS.has(location.origin)) return { kind: "other" };
      const path = url.pathname || "/";
      if (method === "GET" && path === "/backend-api/wham/usage") {
        return { kind: "credits_usage", endpointPath: path };
      }
      if (method === "GET" && path === "/backend-api/wham/rate-limit-reset-credits") {
        return { kind: "reset_credits", endpointPath: path };
      }
      if (method === "GET" && path === "/backend-api/wham/analytics/daily-workspace-usage-counts") {
        return {
          kind: "credits_daily",
          endpointPath: path,
          startDate: url.searchParams.get("start_date"),
          endDate: url.searchParams.get("end_date"),
          groupBy: url.searchParams.get("group_by"),
        };
      }
      if (method === "POST" && /^\/backend-api\/(?:f\/)?conversations?$/.test(path)) {
        return { kind: "conversation_stream", conversationId: null };
      }
      if (method === "GET") {
        const match = path.match(/^\/backend-api\/(?:f\/)?conversations?\/([^/]+)$/);
        if (match) {
          return {
            kind: "conversation_record",
            conversationId: Core.safeIdentifier(decodeURIComponent(match[1]), 256),
          };
        }
      }
      return { kind: "other" };
    } catch {
      return { kind: "other" };
    }
  }

  async function readRequestBody(input, init) {
    if (typeof init?.body === "string") return init.body.slice(0, 2 * 1024 * 1024);
    if (input instanceof Request) {
      try {
        const text = await input.clone().text();
        return text.slice(0, 2 * 1024 * 1024);
      } catch {
        return null;
      }
    }
    return null;
  }

  async function readBoundedText(response, maximumBytes) {
    const declaredLength = Number(response.headers.get("content-length") || 0);
    if (declaredLength > maximumBytes) throw new Error("response_too_large");
    const raw = await response.text();
    if (raw.length > maximumBytes) throw new Error("response_too_large");
    return raw;
  }

  async function inspectCreditResponse(response, endpoint) {
    if (!preferences.captureCredits) return;
    try {
      const maximum = endpoint.kind === "credits_usage"
        ? MAX_USAGE_BYTES
        : endpoint.kind === "reset_credits"
          ? MAX_RESET_CREDITS_BYTES
          : MAX_DAILY_BYTES;
      const raw = await readBoundedText(response, maximum);
      const body = JSON.parse(raw);
      const observedAt = now();
      if (endpoint.kind === "credits_usage") {
        emitCredit({
          kind: "usage",
          sessionId,
          observedAt,
          pageUrl: safePageUrl(),
          endpointPath: endpoint.endpointPath,
          windows: Core.extractLimitWindows(Core.isRecord(body) ? body : {}),
          planHints: Core.extractPlanHints(body),
          resetCredits: Core.extractResetCreditSummary(body),
        });
      } else if (endpoint.kind === "reset_credits") {
        const details = Core.extractResetCreditDetails(body);
        if (details) emitCredit({
          kind: "reset_credits",
          sessionId,
          observedAt,
          pageUrl: safePageUrl(),
          endpointPath: endpoint.endpointPath,
          ...details,
        });
      } else if (!endpoint.groupBy || endpoint.groupBy === "day") {
        emitCredit({
          kind: "daily",
          sessionId,
          observedAt,
          pageUrl: safePageUrl(),
          endpointPath: endpoint.endpointPath,
          rows: Core.normalizeDailyRows(body),
          startDate: endpoint.startDate,
          endDate: endpoint.endDate,
          groupBy: endpoint.groupBy || "day",
        });
      }
    } catch (error) {
      emitHookStatus("credit-parse-failed", {
        endpointKind: endpoint.kind,
        errorCode: error instanceof Error ? error.message : "credit_parse_failed",
      });
    }
  }

  function prunePending(timestamp = Date.now()) {
    for (const [captureId, item] of pending) {
      if (item.expiresAt <= timestamp) pending.delete(captureId);
    }
  }

  function registerPending(captureId, fields, startedAt) {
    prunePending();
    while (pending.size >= MAX_PENDING) {
      const oldest = pending.keys().next().value;
      if (!oldest) break;
      pending.delete(oldest);
    }
    pending.set(captureId, {
      captureId,
      startedAt,
      fields: Core.mergeRouteFields(fields),
      conversationId: fields.conversationId || null,
      expiresAt: Date.now() + PENDING_TTL_MS,
      lastSignature: "",
    });
  }

  function fieldsSignature(fields) {
    return JSON.stringify([
      fields.requestedModel,
      fields.assistantModel,
      fields.serverModel,
      fields.resolvedModel,
      fields.defaultModel,
      fields.requestId,
      fields.conversationId,
      fields.planType,
    ]);
  }

  function hasResponseEvidence(fields) {
    return Boolean(
      fields.assistantModel
      || fields.serverModel
      || fields.resolvedModel
      || fields.defaultModel
      || fields.requestId,
    );
  }

  async function inspectSse(response, captureId, startedAt, requestFields) {
    const body = response.body;
    if (!body) throw new Error("stream_body_missing");
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let fields = Core.mergeRouteFields(requestFields);
    let lastSignature = fieldsSignature(fields);
    let totalBytes = 0;

    while (true) {
      const { value, done } = await reader.read();
      if (value) totalBytes += value.byteLength;
      if (totalBytes > MAX_ROUTE_RECORD_BYTES) {
        await reader.cancel("route stream exceeded safety limit");
        throw new Error("stream_too_large");
      }
      buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
      if (buffer.length > MAX_STREAM_EVENT_BYTES && !buffer.includes("\n")) {
        await reader.cancel("route event exceeded safety limit");
        throw new Error("stream_event_too_large");
      }
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || "";
      for (const line of lines) {
        if (line.length > MAX_STREAM_EVENT_BYTES || !line.startsWith("data:")) continue;
        fields = Core.mergeRouteFields(fields, Core.parseSseResponse(`${line}\n`));
        const signature = fieldsSignature(fields);
        if (hasResponseEvidence(fields) && signature !== lastSignature) {
          lastSignature = signature;
          emitRoute({
            captureId,
            source: "page_fetch",
            phase: "responding",
            observedAt: now(),
            startedAt,
            pageUrl: safePageUrl(),
            ...fields,
          });
        }
      }
      if (done) break;
    }

    if (buffer.startsWith("data:")) fields = Core.mergeRouteFields(fields, Core.parseSseResponse(`${buffer}\n`));
    emitRoute({
      captureId,
      source: "page_fetch",
      phase: "completed",
      observedAt: now(),
      startedAt,
      completedAt: now(),
      pageUrl: safePageUrl(),
      ...fields,
    });
    pending.delete(captureId);
  }

  async function inspectJsonResponse(response, captureId, startedAt, requestFields, source, conversationId) {
    const raw = await readBoundedText(response, MAX_ROUTE_RECORD_BYTES);
    const fields = Core.mergeRouteFields(
      requestFields,
      Core.parseResponseText(raw),
      conversationId ? { conversationId } : {},
    );
    emitRoute({
      captureId,
      source,
      phase: "completed",
      observedAt: now(),
      startedAt,
      completedAt: now(),
      pageUrl: safePageUrl(),
      ...fields,
    });
    pending.delete(captureId);
  }

  async function inspectFetch(downstream, receiver, input, init) {
    const rawUrl = requestUrl(input);
    const method = requestMethod(input, init);
    const endpoint = classifyEndpoint(rawUrl, method);
    const creditEndpoint = endpoint.kind === "credits_usage"
      || endpoint.kind === "credits_daily"
      || endpoint.kind === "reset_credits";
    const routeEndpoint = endpoint.kind === "conversation_stream" || endpoint.kind === "conversation_record";
    if (endpoint.kind === "other"
      || (creditEndpoint && !preferences.captureCredits)
      || (routeEndpoint && !preferences.routeInspection)) {
      return Reflect.apply(downstream, receiver ?? globalThis, [input, init]);
    }

    let captureId = null;
    let startedAt = null;
    let requestFields = Core.emptyRouteFields();
    if (endpoint.kind === "conversation_stream") {
      captureId = crypto.randomUUID();
      startedAt = now();
      const rawBody = await readRequestBody(input, init);
      if (rawBody) requestFields = Core.parseConversationRequest(rawBody);
      registerPending(captureId, requestFields, startedAt);
      emitRoute({
        captureId,
        source: "page_fetch",
        phase: "requested",
        observedAt: now(),
        startedAt,
        pageUrl: safePageUrl(),
        ...requestFields,
      });
    } else if (endpoint.kind === "conversation_record") {
      captureId = crypto.randomUUID();
      startedAt = now();
    }

    try {
      const response = await Reflect.apply(downstream, receiver ?? globalThis, [input, init]);
      const clone = response.clone();
      if (creditEndpoint) {
        void inspectCreditResponse(clone, endpoint);
      } else if (endpoint.kind === "conversation_stream") {
        const contentType = clone.headers.get("content-type") || "";
        const inspection = contentType.includes("text/event-stream")
          ? inspectSse(clone, captureId, startedAt, requestFields)
          : inspectJsonResponse(clone, captureId, startedAt, requestFields, "page_fetch", null);
        void inspection.catch((error) => {
          pending.delete(captureId);
          emitRoute({
            captureId,
            source: "page_fetch",
            phase: "failed",
            observedAt: now(),
            startedAt,
            completedAt: now(),
            pageUrl: safePageUrl(),
            errorCode: error instanceof Error ? error.message : "stream_parse_failed",
          });
        });
      } else {
        void inspectJsonResponse(
          clone,
          captureId,
          startedAt,
          requestFields,
          "conversation_record",
          endpoint.conversationId,
        ).catch((error) => emitRoute({
          captureId,
          source: "conversation_record",
          phase: "failed",
          observedAt: now(),
          startedAt,
          completedAt: now(),
          pageUrl: safePageUrl(),
          conversationId: endpoint.conversationId,
          errorCode: error instanceof Error ? error.message : "record_parse_failed",
        }));
      }
      return response;
    } catch (error) {
      if (captureId) {
        pending.delete(captureId);
        emitRoute({
          captureId,
          source: endpoint.kind === "conversation_record" ? "conversation_record" : "page_fetch",
          phase: "failed",
          observedAt: now(),
          startedAt,
          completedAt: now(),
          pageUrl: safePageUrl(),
          errorCode: error instanceof Error ? error.name : "fetch_failed",
        });
      }
      throw error;
    }
  }

  function createFetchGeneration(downstream, capturesRawResponse) {
    const generation = { downstream, capturesRawResponse, wrapper: nativeFetch };
    generation.wrapper = async function codexCreditsWatchFetch(input, init) {
      const receiver = this ?? globalThis;
      if (generation.capturesRawResponse) return inspectFetch(generation.downstream, receiver, input, init);
      return Reflect.apply(generation.downstream, receiver, [input, init]);
    };
    return generation;
  }

  let currentFetchGeneration = createFetchGeneration(nativeFetch, true);

  function adoptDownstreamFetch(candidate) {
    if (typeof candidate !== "function" || candidate === currentFetchGeneration.wrapper) return;
    currentFetchGeneration = createFetchGeneration(candidate, candidate === nativeFetch);
  }

  function fetchGetter() {
    return currentFetchGeneration.wrapper;
  }

  function fetchSetter(candidate) {
    adoptDownstreamFetch(candidate);
  }

  function installFetchHook() {
    try {
      const descriptor = Object.getOwnPropertyDescriptor(globalThis, "fetch");
      if (descriptor?.get === fetchGetter && descriptor.set === fetchSetter) return;
      adoptDownstreamFetch(globalThis.fetch);
      try {
        Object.defineProperty(globalThis, "fetch", {
          configurable: true,
          enumerable: descriptor?.enumerable ?? true,
          get: fetchGetter,
          set: fetchSetter,
        });
      } catch {
        globalThis.fetch = currentFetchGeneration.wrapper;
      }
    } catch {
      // A frozen page API must not break the host page.
    }
  }

  function pendingForFields(fields) {
    prunePending();
    const candidates = [...pending.values()];
    if (fields.conversationId) {
      const matches = candidates.filter((item) => item.conversationId === fields.conversationId);
      return matches.length === 1 ? matches[0] : null;
    }
    return candidates.length === 1 ? candidates[0] : null;
  }

  function handleWebSocketText(raw) {
    if (!preferences.routeInspection) return;
    const parsed = Core.parseWebSocketText(raw);
    if (!parsed.evidence?.length) return;
    const item = pendingForFields(parsed);
    if (!item) return;
    if (!item.conversationId && parsed.conversationId) item.conversationId = parsed.conversationId;
    item.fields = Core.mergeRouteFields(item.fields, parsed, { conversationId: item.conversationId });
    const signature = fieldsSignature(item.fields);
    if (!hasResponseEvidence(item.fields) || signature === item.lastSignature) return;
    item.lastSignature = signature;
    emitRoute({
      captureId: item.captureId,
      source: "page_websocket",
      phase: "responding",
      observedAt: now(),
      startedAt: item.startedAt,
      pageUrl: safePageUrl(),
      ...item.fields,
    });
  }

  function isAllowedWebSocket(rawUrl) {
    try {
      const url = new URL(rawUrl, location.href);
      if (url.protocol !== "ws:" && url.protocol !== "wss:") return false;
      const hostname = url.hostname.toLowerCase();
      return hostname === "chatgpt.com"
        || hostname.endsWith(".chatgpt.com");
    } catch {
      return false;
    }
  }

  const observedSockets = new WeakSet();
  function observeSocket(socket) {
    if (observedSockets.has(socket) || !isAllowedWebSocket(socket.url)) return;
    observedSockets.add(socket);
    socket.addEventListener("message", (event) => {
      if (typeof event.data === "string") queueMicrotask(() => handleWebSocketText(event.data));
    });
  }

  function copyWebSocketShape(wrapper, downstream) {
    try { Object.setPrototypeOf(wrapper, Object.getPrototypeOf(downstream)); } catch {}
    for (const key of ["CONNECTING", "OPEN", "CLOSING", "CLOSED"]) {
      const descriptor = Object.getOwnPropertyDescriptor(downstream, key)
        || Object.getOwnPropertyDescriptor(nativeWebSocket, key);
      if (descriptor) {
        try { Object.defineProperty(wrapper, key, descriptor); } catch {}
      }
    }
    try {
      Object.defineProperty(wrapper, "prototype", {
        value: downstream.prototype,
        writable: false,
        enumerable: false,
        configurable: false,
      });
    } catch {}
  }

  function createWebSocketGeneration(downstream, capturesRawMessages) {
    const generation = { downstream, capturesRawMessages, wrapper: nativeWebSocket };
    function CodexCreditsWatchWebSocket(...args) {
      if (!new.target) throw new TypeError("Failed to construct 'WebSocket': Please use the 'new' operator.");
      const socket = Reflect.construct(generation.downstream, args, generation.downstream);
      if (generation.capturesRawMessages) observeSocket(socket);
      return socket;
    }
    copyWebSocketShape(CodexCreditsWatchWebSocket, downstream);
    generation.wrapper = CodexCreditsWatchWebSocket;
    return generation;
  }

  let currentWebSocketGeneration = createWebSocketGeneration(nativeWebSocket, true);

  function adoptDownstreamWebSocket(candidate) {
    if (typeof candidate !== "function" || candidate === currentWebSocketGeneration.wrapper) return;
    currentWebSocketGeneration = createWebSocketGeneration(candidate, candidate === nativeWebSocket);
  }

  function websocketGetter() {
    return currentWebSocketGeneration.wrapper;
  }

  function websocketSetter(candidate) {
    adoptDownstreamWebSocket(candidate);
  }

  function installWebSocketHook() {
    try {
      const descriptor = Object.getOwnPropertyDescriptor(globalThis, "WebSocket");
      if (descriptor?.get === websocketGetter && descriptor.set === websocketSetter) return;
      adoptDownstreamWebSocket(globalThis.WebSocket);
      try {
        Object.defineProperty(globalThis, "WebSocket", {
          configurable: true,
          enumerable: descriptor?.enumerable ?? true,
          get: websocketGetter,
          set: websocketSetter,
        });
      } catch {
        globalThis.WebSocket = currentWebSocketGeneration.wrapper;
      }
    } catch {
      // A frozen page API must not break the host page.
    }
  }

  globalThis.addEventListener("message", onBridgeMessage, false);
  installFetchHook();
  installWebSocketHook();
  const recoveryTimer = globalThis.setInterval(() => {
    installFetchHook();
    installWebSocketHook();
    prunePending();
  }, 2000);
  globalThis.addEventListener("pagehide", () => globalThis.clearInterval(recoveryTimer), { once: true });
  emitHookStatus("ready");
})();
