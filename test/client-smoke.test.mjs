/**
 * Panel smoke test.
 *
 * `client.js` is not a normal ES module: it calls `window.__ModuleLoader__.load`
 * with a factory that needs `react` and the panel context (`slots`). This test
 * evaluates the file in a VM with that loader stubbed, then runs the factory and
 * `apply()` against a fake context, so a broken import, a throwing top-level
 * statement or a missing slot registration fails in CI instead of only in a
 * browser.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import * as React from 'react';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PANEL_ID = 'ai-for-memory';

function loadClientModule() {
  const source = fs.readFileSync(path.join(ROOT, 'client.js'), 'utf8');
  let captured = null;
  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    URL,
    URLSearchParams,
    navigator: { language: 'zh-CN' },
    window: {},
  };
  sandbox.globalThis = sandbox;
  sandbox.window.__ModuleLoader__ = { load(module) { captured = module; } };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: 'client.js' });
  return captured;
}

test('the panel module registers a sidebar entry and the main panel', () => {
  const module = loadClientModule();
  assert.ok(module, 'window.__ModuleLoader__.load must receive a module');
  assert.equal(module.id, 'dsh-ai-for-memory');
  assert.equal(typeof module.factory, 'function');

  const clientModule = module.factory((name) => {
    if (name === 'react') return React;
    throw new Error(`unexpected require: ${name}`);
  });
  assert.equal(clientModule.inject.length, 1);
  assert.equal(clientModule.inject[0], 'slots');
  assert.equal(typeof clientModule.apply, 'function');

  const registered = [];
  const injected = [];
  const clientCtx = {
    effect(fn) { return fn(); },
    slots: {
      inject(name, fn) {
        injected.push(name);
        return fn();
      },
      register(spec, component) {
        registered.push({ spec, component });
        return () => {};
      },
    },
  };
  clientModule.apply(clientCtx);

  assert.deepEqual(injected, ['sidebar.panellist', 'main']);
  assert.equal(registered.length, 2);

  const [sidebar, main] = registered;
  assert.equal(sidebar.spec.name, 'sidebar.panellist');
  assert.equal(sidebar.spec.id, PANEL_ID);
  assert.equal(typeof sidebar.spec.label, 'function');
  assert.equal(sidebar.spec.label(), 'AI 记忆');
  assert.equal(typeof sidebar.component, 'function');

  assert.equal(main.spec.name, 'main');
  assert.equal(main.spec.key, PANEL_ID);
  assert.equal(typeof main.component, 'function');
});

test('the English locale labels the panel "AI Memory"', () => {
  const sandboxNavigator = { language: 'en-US' };
  // The locale is baked in at factory time from navigator.language; reload with
  // an English navigator to cover the other dictionary.
  const source = fs.readFileSync(path.join(ROOT, 'client.js'), 'utf8');
  let captured = null;
  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    URL,
    URLSearchParams,
    navigator: sandboxNavigator,
    window: {},
  };
  sandbox.globalThis = sandbox;
  sandbox.window.__ModuleLoader__ = { load(m) { captured = m; } };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: 'client.js' });

  const registered = [];
  const clientModule = captured.factory((name) => (name === 'react' ? React : null));
  clientModule.apply({
    effect(fn) { return fn(); },
    slots: {
      inject(_name, fn) { return fn(); },
      register(spec, component) { registered.push({ spec, component }); return () => {}; },
    },
  });
  assert.equal(registered[0].spec.label(), 'AI for Memory');
});
