import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const appDirectory = path.resolve(testDirectory, '../..');
const productionTauriDirectory = path.join(appDirectory, 'applications', 'tauri');
const require = createRequire(import.meta.url);
const { rewriteDesktopHtml } = require(path.join(productionTauriDirectory, 'copy-build-tree.js'));

function createGeneratedFrontend() {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'ride-startup-gateway-'));
  const tauriDirectory = path.join(fixture, 'applications', 'tauri');
  const sourceDirectory = path.join(fixture, 'applications', 'browser', 'lib', 'frontend');
  const gatewayDirectory = path.join(tauriDirectory, 'browser-frontend');
  const legacyDirectory = path.join(tauriDirectory, 'tauri-frontend');
  fs.mkdirSync(sourceDirectory, { recursive: true });
  fs.mkdirSync(tauriDirectory, { recursive: true });
  fs.copyFileSync(
    path.join(productionTauriDirectory, 'copy-frontend.js'),
    path.join(tauriDirectory, 'copy-frontend.js'),
  );
  fs.copyFileSync(
    path.join(productionTauriDirectory, 'copy-build-tree.js'),
    path.join(tauriDirectory, 'copy-build-tree.js'),
  );
  fs.writeFileSync(path.join(sourceDirectory, 'index.html'), `<!doctype html>
<html lang="en"><head><meta charset="UTF-8">
  <script>if (document.head) { document.head.dataset.favicon = 'unused'; }</script>
</head><body><script type="module" src="./bundle.js" charset="utf-8"></script></body></html>`);
  fs.writeFileSync(path.join(sourceDirectory, 'bundle.js'), 'window.__rideBundleEvaluations = 1;');
  fs.writeFileSync(path.join(sourceDirectory, 'bundle.css'), 'body { color: inherit; }');

  const generator = require(path.join(tauriDirectory, 'copy-frontend.js'));
  assert.equal(
    typeof generator.copyFrontendResources,
    'function',
    'copy-frontend.js must expose a side-effect-free helper for build tests',
  );
  generator.copyFrontendResources({
    sourceDir: sourceDirectory,
    targetDir: gatewayDirectory,
    tauriFrontendDir: legacyDirectory,
    includeSourceMaps: false,
  });
  return { fixture, gatewayDirectory, legacyDirectory };
}

class FakeElement {
  constructor(tagName) {
    this.tagName = tagName.toUpperCase();
    this.attributes = new Map();
    this.children = [];
    this.listeners = new Map();
    this.parentNode = undefined;
    this.disabled = false;
    this.type = '';
    this._textContent = '';
  }

  set textContent(value) {
    this._textContent = String(value);
    this.children = [];
  }

  get textContent() {
    return this._textContent + this.children.map(child => child.textContent).join('');
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }

  append(...children) {
    for (const child of children) {
      child.parentNode = this;
      this.children.push(child);
    }
  }

  appendChild(child) {
    this.append(child);
    return child;
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  click() {
    for (const listener of this.listeners.get('click') ?? []) {
      listener({ currentTarget: this, preventDefault() {} });
    }
  }

  remove() {
    if (!this.parentNode) {
      return;
    }
    this.parentNode.children = this.parentNode.children.filter(child => child !== this);
    this.parentNode = undefined;
  }
}

class FakeDocument {
  constructor() {
    this.body = new FakeElement('body');
  }

  createElement(tagName) {
    return new FakeElement(tagName);
  }

  findAll(predicate) {
    const matches = [];
    const visit = element => {
      if (predicate(element)) {
        matches.push(element);
      }
      element.children.forEach(visit);
    };
    visit(this.body);
    return matches;
  }
}

function createStorage() {
  const values = new Map();
  return {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(String(key), String(value)),
    entries: () => [...values.entries()],
  };
}

function executeBridge(script) {
  const document = new FakeDocument();
  const requests = [];
  const fetchResponses = [];
  const eventSources = [];
  const navigation = { reloads: 0, replacements: [] };
  const logs = [];
  const localStorage = createStorage();
  const sessionStorage = createStorage();

  class FakeEventSource {
    constructor(url, options) {
      this.url = url;
      this.options = options;
      this.listeners = new Map();
      eventSources.push(this);
    }

    addEventListener(type, listener) {
      const listeners = this.listeners.get(type) ?? [];
      listeners.push(listener);
      this.listeners.set(type, listeners);
    }

    emitState(state) {
      for (const listener of this.listeners.get('state') ?? []) {
        listener({ data: JSON.stringify(state) });
      }
    }
  }

  const window = {
    document,
    EventSource: FakeEventSource,
    fetch: async (url, options) => {
      requests.push({ url, options });
      return fetchResponses.shift() ?? { ok: true, status: 202 };
    },
    localStorage,
    sessionStorage,
    navigator: {
      languages: ['zh-CN', 'en-US'],
      language: 'zh-CN',
    },
    location: {
      search: '?ride_locale=zh-CN',
      reload: () => { navigation.reloads++; },
      replace: value => { navigation.replacements.push(value); },
    },
  };
  const console = {
    log: (...values) => logs.push(['log', ...values]),
    warn: (...values) => logs.push(['warn', ...values]),
    error: (...values) => logs.push(['error', ...values]),
  };
  vm.runInNewContext(script, {
    window,
    document,
    console,
    EventSource: FakeEventSource,
    fetch: window.fetch,
    URLSearchParams,
  });
  return {
    document,
    eventSources,
    fetchResponses,
    localStorage,
    logs,
    navigation,
    requests,
    sessionStorage,
    window,
  };
}

test('generates one gateway document while retaining the explicit legacy frontend', t => {
  const generated = createGeneratedFrontend();
  t.after(() => fs.rmSync(generated.fixture, { recursive: true, force: true }));

  const html = fs.readFileSync(path.join(generated.gatewayDirectory, 'index.html'), 'utf8');
  const bridge = fs.readFileSync(path.join(generated.gatewayDirectory, 'ride-bootstrap.js'), 'utf8');
  const afterBundle = fs.readFileSync(path.join(generated.gatewayDirectory, 'ride-after-bundle.js'), 'utf8');
  const scripts = [...html.matchAll(/<script\b([^>]*)><\/script>/gi)].map(match => ({
    attributes: match[1],
    fullTag: match[0],
    index: match.index,
    source: /(?:^|\s)src=["']([^"']+)["']/i.exec(match[1])?.[1],
  }));
  const externalScripts = scripts.filter(script => script.source);
  const scriptSources = externalScripts.map(script => script.source);

  assert.equal(scriptSources.filter(source => source === './bundle.js').length, 1);
  assert.deepEqual(scriptSources, ['./ride-bootstrap.js', './bundle.js', './ride-after-bundle.js']);
  const [bootstrapScript, bundleScript, afterBundleScript] = externalScripts;
  assert.ok(bootstrapScript.index < bundleScript.index);
  assert.match(bundleScript.attributes, /(?:^|\s)type=["']module["']/i);
  assert.doesNotMatch(bundleScript.attributes, /(?:^|\s)async(?:\s|=|$)/i);
  assert.match(afterBundleScript.attributes, /(?:^|\s)type=["']module["']/i);
  assert.doesNotMatch(afterBundleScript.attributes, /(?:^|\s)async(?:\s|=|$)/i);
  assert.match(
    html.slice(bundleScript.index + bundleScript.fullTag.length, afterBundleScript.index),
    /^\s*$/,
  );
  assert.match(html, /Content-Security-Policy/);
  assert.match(html, /connect-src 'self' data: http: https: ws: wss:/);
  assert.match(bridge, /localeId/);
  assert.match(bridge, /ride_locale/);
  assert.equal(afterBundle.trim(), 'window.__rideStartup?.markBundleLoaded();');

  const gatewayOutput = [html, bridge, afterBundle].join('\n');
  assert.doesNotMatch(gatewayOutput, /127\.0\.0\.1:3000/);
  assert.doesNotMatch(gatewayOutput, /setTimeout\s*\(/);
  assert.doesNotMatch(gatewayOutput, /location\.(?:replace|reload)\s*\(/);
  assert.doesNotMatch(gatewayOutput, /rpc_connected/);
  assert.doesNotMatch(bridge, /(?:import\s*\(|createElement\s*\()[\s\S]{0,80}bundle\.js/i);

  const legacyHtml = fs.readFileSync(path.join(generated.legacyDirectory, 'index.html'), 'utf8');
  const legacyBootstrap = fs.readFileSync(path.join(generated.legacyDirectory, 'bootstrap.js'), 'utf8');
  assert.match(legacyHtml, /bootstrap\.js/);
  assert.match(legacyBootstrap, /127\.0\.0\.1:3000/);
  assert.match(legacyBootstrap, /setTimeout\s*\(/);
  assert.match(legacyBootstrap, /location\.replace\s*\(/);
});

test('bridge uses one state stream and reports bundle completion once with same-origin credentials', async t => {
  const generated = createGeneratedFrontend();
  t.after(() => fs.rmSync(generated.fixture, { recursive: true, force: true }));
  const bridge = fs.readFileSync(path.join(generated.gatewayDirectory, 'ride-bootstrap.js'), 'utf8');
  const afterBundle = fs.readFileSync(path.join(generated.gatewayDirectory, 'ride-after-bundle.js'), 'utf8');
  const harness = executeBridge(bridge);

  assert.equal(Object.isFrozen(harness.window.__rideStartup), true);
  assert.equal(harness.eventSources.length, 1);
  assert.equal(harness.eventSources[0].url, '/_ride/startup/events');
  assert.equal(harness.eventSources[0].options.withCredentials, true);
  assert.deepEqual(Object.keys(harness.eventSources[0].options), ['withCredentials']);

  vm.runInNewContext(afterBundle, { window: harness.window });
  await harness.window.__rideStartup.markBundleLoaded();
  const milestones = harness.requests.filter(request => request.url === '/_ride/startup/milestones');
  assert.equal(milestones.length, 1);
  assert.equal(milestones[0].options.method, 'POST');
  assert.equal(milestones[0].options.credentials, 'same-origin');
  assert.equal(milestones[0].options.headers['content-type'], 'application/json');
  assert.deepEqual(JSON.parse(milestones[0].options.body), { milestone: 'frontend_bundle_loaded' });
});

test('bridge rejects malformed, stale, and non-monotonic startup state updates', t => {
  const generated = createGeneratedFrontend();
  t.after(() => fs.rmSync(generated.fixture, { recursive: true, force: true }));
  const bridge = fs.readFileSync(path.join(generated.gatewayDirectory, 'ride-bootstrap.js'), 'utf8');
  const harness = executeBridge(bridge);
  const states = harness.eventSources[0];
  const alertCount = () => harness.document.findAll(
    element => element.getAttribute('role') === 'alert',
  ).length;

  for (const generation of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '7', null]) {
    states.emitState({ state: 'failed', generation, diagnostic: 'invalid generation' });
    assert.equal(alertCount(), 0);
  }

  states.emitState({ state: 'ready', generation: 7 });
  states.emitState({ state: 'future-protocol-state', generation: 8 });
  states.emitState({ state: 'failed', generation: 7, diagnostic: 'same-generation crash' });
  assert.equal(alertCount(), 1, 'unknown state must not advance the accepted generation');

  states.emitState({ state: 'ready', generation: 7 });
  states.emitState({ state: 'starting', generation: 7 });
  assert.equal(alertCount(), 1, 'failed is terminal within one generation');

  states.emitState({ state: 'ready', generation: 8 });
  assert.equal(alertCount(), 0, 'a newer generation may recover');
  states.emitState({ state: 'failed', generation: 7, diagnostic: 'stale lower generation' });
  assert.equal(alertCount(), 0);

  states.emitState({ state: 'failed', generation: 8, diagnostic: 'ready backend crashed' });
  assert.equal(alertCount(), 1, 'ready to failed is a valid same-generation crash transition');
  states.emitState({ state: 'ready', generation: 7 });
  assert.equal(alertCount(), 1, 'a lower ready event cannot clear the current failure');
});

test('desktop rewrite rejects duplicate bundle script entries before mutation', () => {
  const duplicate = `<!doctype html><html><head></head><body>
    <script type="module" src="./bundle.js"></script>
    <script type="module" src="./bundle.js"></script>
  </body></html>`;
  assert.throws(() => rewriteDesktopHtml(duplicate), /exactly one bundle\.js script/i);
});

test('failed state renders one bounded alert and retry remains idempotent per generation', async t => {
  const generated = createGeneratedFrontend();
  t.after(() => fs.rmSync(generated.fixture, { recursive: true, force: true }));
  const bridge = fs.readFileSync(path.join(generated.gatewayDirectory, 'ride-bootstrap.js'), 'utf8');
  const harness = executeBridge(bridge);
  const maliciousDiagnostic = `<img src=x onerror=alert(1)>${'x'.repeat(8_192)}`;

  harness.eventSources[0].emitState({ state: 'failed', generation: 7, diagnostic: maliciousDiagnostic });
  harness.eventSources[0].emitState({ state: 'failed', generation: 7, diagnostic: maliciousDiagnostic });
  const alerts = harness.document.findAll(element => element.getAttribute('role') === 'alert');
  assert.equal(alerts.length, 1);
  const diagnostics = harness.document.findAll(
    element => element.getAttribute('data-ride-startup-diagnostic') === 'true',
  );
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].textContent, maliciousDiagnostic.slice(0, 4_096));
  assert.equal(harness.document.findAll(element => element.tagName === 'IMG').length, 0);

  const retry = harness.document.findAll(
    element => element.tagName === 'BUTTON' && element.textContent === 'Retry',
  )[0];
  assert.ok(retry);
  assert.equal(retry.getAttribute('data-ride-startup-retry'), 'true');
  retry.click();
  retry.click();
  await Promise.resolve();
  let retries = harness.requests.filter(request => request.url === '/_ride/startup/retry');
  assert.equal(retries.length, 1);
  assert.equal(retry.disabled, true);
  assert.equal(retries[0].options.credentials, 'same-origin');
  assert.deepEqual(JSON.parse(retries[0].options.body), { generation: 7 });
  harness.eventSources[0].emitState({ state: 'failed', generation: 7, diagnostic: 'same failure' });
  assert.equal(retry.disabled, true);
  retry.click();
  await Promise.resolve();
  assert.equal(harness.requests.filter(request => request.url === '/_ride/startup/retry').length, 1);

  harness.eventSources[0].emitState({ state: 'starting', generation: 8 });
  assert.equal(retry.disabled, true);
  retry.click();
  await Promise.resolve();
  assert.equal(harness.requests.filter(request => request.url === '/_ride/startup/retry').length, 1);
  harness.eventSources[0].emitState({ state: 'stopping', generation: 8 });
  assert.equal(retry.disabled, true);
  harness.eventSources[0].emitState({ state: 'failed', generation: 8, diagnostic: 'stale stopping failure' });
  assert.equal(retry.disabled, true);
  retry.click();
  await Promise.resolve();
  assert.equal(harness.requests.filter(request => request.url === '/_ride/startup/retry').length, 1);

  harness.eventSources[0].emitState({ state: 'failed', generation: 9, diagnostic: 'new generation failure' });
  assert.equal(retry.disabled, false);
  retry.click();
  await Promise.resolve();
  retries = harness.requests.filter(request => request.url === '/_ride/startup/retry');
  assert.equal(retries.length, 2);
  assert.deepEqual(JSON.parse(retries[1].options.body), { generation: 9 });

  harness.eventSources[0].emitState({ state: 'ready', generation: 9 });
  assert.equal(harness.document.findAll(element => element.getAttribute('role') === 'alert').length, 1);
  harness.eventSources[0].emitState({ state: 'ready', generation: 10 });
  assert.equal(harness.document.findAll(element => element.getAttribute('role') === 'alert').length, 0);
  assert.deepEqual(harness.navigation, { reloads: 0, replacements: [] });
  assert.deepEqual(harness.sessionStorage.entries(), []);
  assert.deepEqual(harness.localStorage.entries(), [['localeId', 'zh-cn']]);
  assert.deepEqual(harness.logs, []);
  assert.equal(harness.eventSources.length, 1);
});

test('a rejected retry response re-enables the same failed generation without reloading', async t => {
  const generated = createGeneratedFrontend();
  t.after(() => fs.rmSync(generated.fixture, { recursive: true, force: true }));
  const bridge = fs.readFileSync(path.join(generated.gatewayDirectory, 'ride-bootstrap.js'), 'utf8');
  const harness = executeBridge(bridge);

  harness.eventSources[0].emitState({ state: 'failed', generation: 7, diagnostic: 'failed' });
  const retry = harness.document.findAll(element => element.tagName === 'BUTTON')[0];
  harness.fetchResponses.push({ ok: false, status: 503 });
  retry.click();
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(retry.disabled, false);
  retry.click();
  await Promise.resolve();
  assert.equal(
    harness.requests.filter(request => request.url === '/_ride/startup/retry').length,
    2,
  );
  assert.deepEqual(harness.navigation, { reloads: 0, replacements: [] });
});
