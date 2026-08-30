import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const coreSource = await readFile(new URL('../src/core.js', import.meta.url), 'utf8');
const popupSource = await readFile(new URL('../popup/popup.js', import.meta.url), 'utf8');

class FakeElement {
  constructor() {
    this.textContent = '';
    this.className = '';
    this.value = '';
    this.checked = false;
    this.disabled = false;
  }

  addEventListener() {}
  click() {}
}

function selectStorage(state, keys) {
  if (keys == null) return { ...state };
  const requested = Array.isArray(keys) ? keys : [keys];
  return Object.fromEntries(requested.filter((key) => key in state).map((key) => [key, state[key]]));
}

async function renderPopup(resetCredits) {
  const elements = new Map();
  const element = (id) => {
    if (!elements.has(id)) elements.set(id, new FakeElement());
    return elements.get(id);
  };
  const state = resetCredits == null ? {} : { ccwResetCreditsLatestV1: resetCredits };
  const browser = {
    runtime: {
      getManifest: () => ({ version: '0.3.0' }),
      openOptionsPage: async () => undefined,
    },
    storage: {
      local: {
        get: async (keys) => selectStorage(state, keys),
        set: async (patch) => Object.assign(state, patch),
        remove: async () => undefined,
      },
      onChanged: { addListener: () => undefined },
    },
    tabs: {
      query: async () => [],
      create: async () => undefined,
      reload: async () => undefined,
    },
  };
  const context = vm.createContext({
    browser,
    document: {
      getElementById: element,
      createElement: () => new FakeElement(),
    },
    window: { close: () => undefined },
    Blob,
    URL,
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
    crypto: globalThis.crypto,
    setTimeout,
    clearTimeout,
  });
  vm.runInContext(coreSource, context, { filename: 'core.js' });
  vm.runInContext(popupSource, context, { filename: 'popup.js' });
  await new Promise((resolve) => setTimeout(resolve, 10));
  return elements;
}

function resetState({ count = 2, expiry = null, detailsLoaded = true, nonExpiring = 0 } = {}) {
  const observedAt = new Date().toISOString();
  return {
    schemaVersion: 1,
    availableCount: count,
    nearestExpiresAt: expiry,
    nonExpiringObservedCount: nonExpiring,
    summaryObservedAt: count == null ? null : observedAt,
    detailsObservedAt: detailsLoaded ? observedAt : null,
    detailsLoaded,
  };
}

test('popup renders unknown, count-only, and detail-only reset states without active requests', async () => {
  let elements = await renderPopup(null);
  assert.equal(elements.get('resetCreditBadge').textContent, '未知');
  assert.match(elements.get('resetCreditNotice').textContent, /纯被动观察/);

  elements = await renderPopup(resetState({ detailsLoaded: false }));
  assert.equal(elements.get('resetCreditBadge').textContent, '2 个可用');
  assert.match(elements.get('resetCreditNotice').textContent, /不会为此主动请求接口/);

  elements = await renderPopup(resetState({
    count: null,
    expiry: new Date(Date.now() + 10 * 86400_000).toISOString(),
  }));
  assert.equal(elements.get('resetCreditCount').textContent, '尚未观察');
  assert.equal(elements.get('resetCreditBadge').textContent, '数量未知');
  assert.match(elements.get('resetCreditNotice').textContent, /最近已观测到期时间/);
});

test('popup renders warning, danger, and stale expiry with text as well as tone', async () => {
  let elements = await renderPopup(resetState({
    expiry: new Date(Date.now() + 5 * 86400_000).toISOString(),
  }));
  assert.equal(elements.get('resetCreditBadge').textContent, '7 天内到期');
  assert.match(elements.get('resetCreditBadge').className, /warn/);

  elements = await renderPopup(resetState({
    expiry: new Date(Date.now() + 24 * 60 * 60_000).toISOString(),
  }));
  assert.equal(elements.get('resetCreditBadge').textContent, '72 小时内到期');
  assert.match(elements.get('resetCreditBadge').className, /bad/);

  elements = await renderPopup(resetState({
    expiry: new Date(Date.now() - 60_000).toISOString(),
  }));
  assert.equal(elements.get('resetCreditCount').textContent, '2 个');
  assert.equal(elements.get('resetCreditBadge').textContent, '缓存已过期');
  assert.match(elements.get('resetCreditNotice').textContent, /数量不会由本地时钟扣减/);
});

test('popup distinguishes available entries without an observed expiry', async () => {
  const elements = await renderPopup(resetState({ expiry: null, nonExpiring: 1 }));
  assert.equal(elements.get('resetCreditBadge').textContent, '2 个可用');
  assert.match(elements.get('resetCreditNotice').textContent, /1 个不设到期时间/);
});
