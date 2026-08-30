import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import { webcrypto, randomUUID } from 'node:crypto';

const coreSource = await readFile(new URL('../src/core.js', import.meta.url), 'utf8');
const hookSource = await readFile(new URL('../src/page-hook.js', import.meta.url), 'utf8');
const bridgeSource = await readFile(new URL('../src/bridge.js', import.meta.url), 'utf8');

class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  constructor(url) {
    this.url = String(url);
    this.listeners = new Map();
  }
  addEventListener(type, listener) {
    const list = this.listeners.get(type) || [];
    list.push(listener);
    this.listeners.set(type, list);
  }
  emit(type, data) {
    for (const listener of this.listeners.get(type) || []) listener({ type, data, target: this });
  }
}

function makeContext(nativeFetch) {
  const messages = [];
  const eventListeners = new Map();
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
    WeakSet,
    RegExp,
    String,
    Boolean,
    URL,
    Request,
    Response,
    Headers,
    ReadableStream,
    TextDecoder,
    Uint8Array,
    Reflect,
    TypeError,
    Error,
    queueMicrotask,
    setTimeout,
    clearTimeout,
    setInterval: () => 1,
    clearInterval: () => undefined,
    location: { origin: 'https://chatgpt.com', pathname: '/c/test', href: 'https://chatgpt.com/c/test' },
    crypto: { ...webcrypto, randomUUID },
    fetch: nativeFetch,
    WebSocket: FakeWebSocket,
    postMessage: (message, targetOrigin) => messages.push({ message, targetOrigin }),
    addEventListener: (type, listener) => eventListeners.set(type, listener),
  });
  vm.runInContext(coreSource, context, { filename: 'core.js' });
  vm.runInContext(hookSource, context, { filename: 'page-hook.js' });
  return { context, messages, eventListeners };
}

async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 30));
}

test('fetch hook captures only route metadata from an SSE response', async () => {
  const sse = [
    'data: {"type":"server_ste_metadata","metadata":{"model_slug":"gpt-5-5-mini","resolved_model_slug":"gpt-5-5-mini","request_id":"req-live"}}',
    'data: {"message":{"author":{"role":"assistant"},"metadata":{"model_slug":"gpt-5-6-pro"},"content":{"parts":["SECRET_ANSWER"]}}}',
    'data: [DONE]',
    '',
  ].join('\n');
  const nativeFetch = async () => new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  const { context, messages } = makeContext(nativeFetch);
  const body = JSON.stringify({ model: 'gpt-5-6-pro', thinking_effort: 'high', messages: [{ content: { parts: ['SECRET_PROMPT'] } }] });
  const response = await context.fetch('https://chatgpt.com/backend-api/f/conversation', { method: 'POST', body });
  assert.equal(await response.text(), sse);
  await settle();
  const payloads = messages.map((item) => item.message.payload);
  assert.ok(payloads.some((item) => item.phase === 'requested' && item.requestedModel === 'gpt-5-6-pro'));
  const completed = payloads.find((item) => item.phase === 'completed');
  assert.equal(completed.resolvedModel, 'gpt-5-5-mini');
  assert.equal(completed.serverModel, 'gpt-5-5-mini');
  assert.equal(completed.assistantModel, 'gpt-5-6-pro');
  const serialized = JSON.stringify(messages);
  assert.doesNotMatch(serialized, /SECRET_PROMPT|SECRET_ANSWER/);
  assert.ok(messages.every((item) => item.targetOrigin === 'https://chatgpt.com'));
});

test('fetch hook remains functional when a page installs a delegating wrapper later', async () => {
  const sse = 'data: {"metadata":{"resolved_model_slug":"gpt-5-5-mini"}}\ndata: [DONE]\n';
  const nativeFetch = async () => new Response(sse, { headers: { 'content-type': 'text/event-stream' } });
  const { context, messages } = makeContext(nativeFetch);
  const captured = context.fetch;
  context.fetch = async function pageFetchWrapper(...args) {
    return Reflect.apply(captured, this, args);
  };
  await context.fetch('https://chatgpt.com/backend-api/conversation', {
    method: 'POST',
    body: JSON.stringify({ model: 'gpt-5-6-pro' }),
  });
  await settle();
  assert.ok(messages.some((item) => item.message.payload.resolvedModel === 'gpt-5-5-mini'));
});

test('WebSocket hook associates route metadata with the pending live capture', async () => {
  const stream = new ReadableStream({
    start(controller) {
      setTimeout(() => {
        controller.enqueue(new TextEncoder().encode('data: [DONE]\n'));
        controller.close();
      }, 80);
    },
  });
  const nativeFetch = async () => new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
  const { context, messages } = makeContext(nativeFetch);
  await context.fetch('https://chatgpt.com/backend-api/f/conversation', {
    method: 'POST',
    body: JSON.stringify({ model: 'gpt-5-6-pro', conversation_id: 'conv-live' }),
  });
  const socket = new context.WebSocket('wss://chatgpt.com/backend-api/ws');
  socket.emit('message', JSON.stringify({
    conversation_id: 'conv-live',
    type: 'server_ste_metadata',
    metadata: { model_slug: 'gpt-5-5-mini', resolved_model_slug: 'gpt-5-5-mini' },
  }));
  await settle();
  const websocket = messages.find((item) => item.message.payload.source === 'page_websocket');
  assert.ok(websocket);
  assert.equal(websocket.message.payload.requestedModel, 'gpt-5-6-pro');
  assert.equal(websocket.message.payload.resolvedModel, 'gpt-5-5-mini');
});

test('non-ChatGPT endpoints are passed through without observations', async () => {
  let calls = 0;
  const nativeFetch = async () => {
    calls += 1;
    return new Response('ok');
  };
  const { context, messages } = makeContext(nativeFetch);
  const response = await context.fetch('https://chatgpt.com/backend-api/accounts/check', { method: 'GET' });
  assert.equal(await response.text(), 'ok');
  assert.equal(calls, 1);
  assert.equal(messages.filter((item) => item.message.type !== 'hook-status').length, 0);
});


test('passively sanitizes Codex usage and daily responses without creating extra requests', async () => {
  const calls = [];
  const nativeFetch = async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    calls.push({ url, init });
    if (url.includes('/backend-api/wham/usage')) {
      return new Response(JSON.stringify({
        rate_limit: {
          primary_window: {
            reset_at: 1e20,
            limit_window_seconds: 5 * 60 * 60,
            used_percent: 5,
          },
          additional_rate_limits: [{ rate_limit: {
            reset_at: 1_778_000_000,
            limit_window_seconds: 7 * 24 * 60 * 60,
            used_percent: 22,
          } }],
        },
        rate_limit_reset_credits: { available_count: 2, title: 'PRIVATE_TITLE' },
        plan_type: 'chatgpt_pro_5x',
        email: 'private@example.com',
        access_token: 'SECRET_TOKEN',
      }), { headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({
      data: [{
        date: '2026-08-30',
        totals: {
          credits: 41.5,
          turns: 3,
          cached_text_input_tokens: 100,
          uncached_text_input_tokens: 50,
          text_output_tokens: 25,
        },
        prompt: 'SECRET_PROMPT',
      }],
      account_name: 'PRIVATE_NAME',
    }), { headers: { 'content-type': 'application/json' } });
  };
  const { context, messages } = makeContext(nativeFetch);
  await context.fetch('https://chatgpt.com/backend-api/wham/usage', { method: 'GET', headers: { authorization: 'Bearer PAGE_TOKEN' } });
  await context.fetch('https://chatgpt.com/backend-api/wham/analytics/daily-workspace-usage-counts?start_date=2026-08-01&end_date=2026-08-31&group_by=day');
  await settle();
  assert.equal(calls.length, 2);
  const creditMessages = messages.filter((item) => item.message.type === 'credit-observation');
  assert.equal(creditMessages.length, 2);
  const usage = creditMessages.find((item) => item.message.payload.kind === 'usage').message.payload;
  const daily = creditMessages.find((item) => item.message.payload.kind === 'daily').message.payload;
  assert.equal(usage.windows.length, 2);
  assert.equal(usage.windows.find((window) => window.durationDays === 7).usedPercent, 22);
  assert.equal(usage.resetCredits.availableCount, 2);
  assert.equal(usage.planHints[0].planId, 'pro5x');
  assert.equal(daily.rows[0].credits, 41.5);
  assert.equal(daily.startDate, '2026-08-01');
  assert.equal(daily.endDate, '2026-08-31');
  const serialized = JSON.stringify(creditMessages);
  assert.doesNotMatch(serialized, /SECRET_TOKEN|PAGE_TOKEN|private@example\.com|SECRET_PROMPT|PRIVATE_NAME|access_token|authorization/i);
  assert.ok(creditMessages.every((item) => item.targetOrigin === 'https://chatgpt.com'));
});

test('passively observes only minimal reset credit expiry details from the exact GET endpoint', async () => {
  let calls = 0;
  const nativeFetch = async () => {
    calls += 1;
    return new Response(JSON.stringify({
      available_count: 3,
      credits: [
        { id: 'PRIVATE_CREDIT_ID', status: 'available', expires_at: '2026-09-03T12:00:00.000Z', title: 'PRIVATE_TITLE' },
        { id: 'PRIVATE_CREDIT_ID_2', status: 'available', expires_at: null, description: 'PRIVATE_DESCRIPTION' },
        { id: 'PRIVATE_CREDIT_ID_3', status: 'consumed', expires_at: '2026-09-01T12:00:00.000Z' },
      ],
      user_id: 'PRIVATE_USER_ID',
      authenticationInfo: { token: 'SECRET_TOKEN' },
    }), { headers: { 'content-type': 'application/json', 'x-private': 'SECRET_HEADER' } });
  };
  const { context, messages } = makeContext(nativeFetch);
  await context.fetch('https://chatgpt.com/backend-api/wham/rate-limit-reset-credits', {
    method: 'GET',
    headers: { authorization: 'Bearer PAGE_TOKEN' },
  });
  await settle();
  assert.equal(calls, 1);
  const observations = messages.filter((item) => item.message.type === 'credit-observation');
  assert.equal(observations.length, 1);
  const details = observations[0].message.payload;
  assert.equal(details.kind, 'reset_credits');
  assert.equal(details.availableCount, null);
  assert.equal(details.nearestExpiresAt, '2026-09-03T12:00:00.000Z');
  assert.equal(details.nonExpiringObservedCount, 1);
  assert.equal(details.detailsLoaded, true);
  assert.doesNotMatch(JSON.stringify(details), /PRIVATE_|SECRET_|authentication|authorization|token|title|description|\bid\b/i);
});

test('does not observe or call the reset credit consume endpoint', async () => {
  let calls = 0;
  const nativeFetch = async () => {
    calls += 1;
    return new Response(JSON.stringify({ available_count: 0, credits: [] }), { headers: { 'content-type': 'application/json' } });
  };
  const { context, messages } = makeContext(nativeFetch);
  await context.fetch('https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume', { method: 'POST' });
  await settle();
  assert.equal(calls, 1);
  assert.equal(messages.filter((item) => item.message.type === 'credit-observation').length, 0);
});

test('does not observe trailing-slash variants of exact Credits endpoints', async () => {
  let calls = 0;
  const nativeFetch = async () => {
    calls += 1;
    return new Response(JSON.stringify({
      rate_limit_reset_credits: { available_count: 9 },
      credits: [{ status: 'available', expires_at: '2026-09-03T12:00:00.000Z' }],
    }), { headers: { 'content-type': 'application/json' } });
  };
  const { context, messages } = makeContext(nativeFetch);
  await context.fetch('https://chatgpt.com/backend-api/wham/usage/', { method: 'GET' });
  await context.fetch('https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/', { method: 'GET' });
  await settle();
  assert.equal(calls, 2);
  assert.equal(messages.filter((item) => item.message.type === 'credit-observation').length, 0);
});

test('does not inspect openai.com WebSockets even with a pending ChatGPT capture', async () => {
  const stream = new ReadableStream({
    start(controller) {
      setTimeout(() => {
        controller.enqueue(new TextEncoder().encode('data: [DONE]\n'));
        controller.close();
      }, 80);
    },
  });
  const nativeFetch = async () => new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
  const { context, messages } = makeContext(nativeFetch);
  await context.fetch('https://chatgpt.com/backend-api/f/conversation', {
    method: 'POST',
    body: JSON.stringify({ model: 'gpt-5-6-pro', conversation_id: 'conv-openai' }),
  });
  const socket = new context.WebSocket('wss://realtime.openai.com/ws');
  socket.emit('message', JSON.stringify({
    conversation_id: 'conv-openai',
    metadata: { resolved_model_slug: 'PRIVATE_OPENAI_ROUTE' },
  }));
  await settle();
  assert.equal(messages.some((item) => item.message.payload?.source === 'page_websocket'), false);
  assert.doesNotMatch(JSON.stringify(messages), /PRIVATE_OPENAI_ROUTE/);
});

test('does not associate a ChatGPT WebSocket message with a different pending conversation', async () => {
  const stream = new ReadableStream({
    start(controller) {
      setTimeout(() => {
        controller.enqueue(new TextEncoder().encode('data: [DONE]\n'));
        controller.close();
      }, 80);
    },
  });
  const nativeFetch = async () => new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
  const { context, messages } = makeContext(nativeFetch);
  await context.fetch('https://chatgpt.com/backend-api/f/conversation', {
    method: 'POST',
    body: JSON.stringify({ model: 'gpt-5-6-pro', conversation_id: 'conv-pending' }),
  });
  const socket = new context.WebSocket('wss://chatgpt.com/backend-api/ws');
  socket.emit('message', JSON.stringify({
    conversation_id: 'conv-different',
    metadata: { resolved_model_slug: 'PRIVATE_MISMATCHED_ROUTE' },
  }));
  await settle();
  assert.equal(messages.some((item) => item.message.payload?.source === 'page_websocket'), false);
  assert.doesNotMatch(JSON.stringify(messages), /PRIVATE_MISMATCHED_ROUTE/);
});

test('bridge persists reset credits separately and renders the accepted overlay summary', () => {
  assert.match(bridgeSource, /KEYS\.resetCreditsLatest/);
  assert.match(bridgeSource, /mergeResetCreditsState/);
  assert.match(bridgeSource, /classifyResetCreditsState/);
  assert.match(bridgeSource, /Muofu AI Quota Lens/);
  assert.doesNotMatch(bridgeSource, /applyCreditReference/);
  assert.match(bridgeSource, /无到期时间项/);
  assert.match(bridgeSource, /creditReportMatchesSettings/);
  assert.match(bridgeSource, /设置已变更，等待新的 Usage 捕获/);
  assert.doesNotMatch(bridgeSource, /(?:creditSection|resetSection|routeSection)\.innerHTML/);
  assert.match(bridgeSource, /\/codex\/settings\/usage/);
  assert.match(bridgeSource, /\/codex\/cloud\/settings\/analytics/);
  assert.doesNotMatch(bridgeSource, />[^<]*Analytics|Analytics[^<]*</);
});

test('does not inspect weekly grouped analytics as daily rows', async () => {
  const nativeFetch = async () => new Response(JSON.stringify({
    data: [{ date: '2026-08-25', totals: { credits: 100 } }],
  }), { headers: { 'content-type': 'application/json' } });
  const { context, messages } = makeContext(nativeFetch);
  await context.fetch('https://chatgpt.com/backend-api/wham/analytics/daily-workspace-usage-counts?start_date=2026-08-01&end_date=2026-08-31&group_by=week');
  await settle();
  assert.equal(messages.filter((item) => item.message.type === 'credit-observation').length, 0);
});
