/**
 * Test harness: load the MV3 background service worker (background.js) into a
 * sandboxed VM context with mocked chrome.* APIs, a fake clock, and a mock
 * WebSocket, so its internal functions can be driven and observed from Node's
 * built-in test runner — no browser, no dependencies.
 *
 * background.js declares its functions with `function` declarations, so they
 * attach to the VM global and are reachable as `ctx.<name>`. State held in
 * top-level `const` (e.g. activeMeetings) stays alive via those closures.
 */

import vm from "node:vm";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");

export function loadBackground({
  storage = {},
  wsBehavior = "open",
  offscreenOpen = false,
  now = 1_000_000_000,
} = {}) {
  let fakeNow = now;

  const calls = {
    downloads: [],
    blobs: [],
    tabsCreated: [],
    sentMessages: [],
    badges: [],
    offscreenCreated: 0,
    offscreenClosed: 0,
  };

  // In-memory chrome.storage.local, seeded with a deep clone of `storage`.
  const local = JSON.parse(JSON.stringify(storage));
  const session = {};

  const listeners = { onInstalled: [], onStartup: [], onMessage: [], onRemoved: [] };
  const makeEvent = (bucket) => ({ addListener: (fn) => listeners[bucket].push(fn) });

  class MockWebSocket {
    constructor(url) {
      this.url = url;
      this.readyState = 0; // CONNECTING
      this._l = {};
      queueMicrotask(() => {
        if (wsBehavior === "open") {
          this.readyState = 1;
          this._emit("open");
        } else {
          this._emit("error");
        }
      });
    }
    addEventListener(type, fn) { (this._l[type] ||= []).push(fn); }
    _emit(type) { (this._l[type] || []).forEach((fn) => fn({ type })); }
    send() {}
    close() { this.readyState = 3; this._emit("close"); }
  }
  MockWebSocket.CONNECTING = 0;
  MockWebSocket.OPEN = 1;
  MockWebSocket.CLOSING = 2;
  MockWebSocket.CLOSED = 3;

  class MockBlob {
    constructor(parts) { this.text = (parts || []).join(""); calls.blobs.push(this.text); }
  }

  const chrome = {
    runtime: {
      onInstalled: makeEvent("onInstalled"),
      onStartup: makeEvent("onStartup"),
      onMessage: makeEvent("onMessage"),
      getURL: (p) => `chrome-extension://test/${p}`,
      getContexts: async () => (offscreenOpen ? [{ contextType: "OFFSCREEN_DOCUMENT" }] : []),
      sendMessage: async (msg) => { calls.sentMessages.push(msg); return { ok: true }; },
    },
    tabs: {
      onRemoved: makeEvent("onRemoved"),
      create: (opts) => { calls.tabsCreated.push(opts); },
    },
    storage: {
      local: {
        // Real chrome.storage.local.get returns a deserialized COPY, never the
        // live object — faithful here so read/modify/write races are observable.
        get: async (key) =>
          typeof key === "string" ? { [key]: structuredClone(local[key]) } : structuredClone(local),
        set: async (obj) => { Object.assign(local, structuredClone(obj)); },
      },
      session: { set: async (obj) => { Object.assign(session, obj); } },
    },
    action: {
      setBadgeText: (o) => calls.badges.push(o),
      setBadgeBackgroundColor: () => {},
    },
    downloads: {
      download: (opts, cb) => { calls.downloads.push(opts); if (cb) cb(1); },
    },
    offscreen: {
      createDocument: async () => { calls.offscreenCreated += 1; },
      closeDocument: async () => { calls.offscreenClosed += 1; },
    },
    tabCapture: { getMediaStreamId: async () => "stream-1" },
  };

  const sandbox = {
    chrome,
    console,
    WebSocket: MockWebSocket,
    Blob: MockBlob,
    URL: { createObjectURL: () => "blob:test", revokeObjectURL: () => {} },
    setTimeout: (fn, ms) => { fakeNow += ms || 0; queueMicrotask(fn); return 0; },
    clearTimeout: () => {},
    queueMicrotask,
    Date: class extends Date { static now() { return fakeNow; } },
    importScripts: (...files) => {
      for (const f of files) {
        vm.runInContext(fs.readFileSync(path.join(REPO, f), "utf8"), ctx, { filename: f });
      }
    },
  };

  const ctx = vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(REPO, "background.js"), "utf8"), ctx, {
    filename: "background.js",
  });

  return {
    ctx,
    chrome,
    calls,
    listeners,
    local,
    setNow: (n) => { fakeNow = n; },
    /** Flush pending microtasks (mock async + timers resolve as microtasks). */
    async drain(rounds = 100) {
      for (let i = 0; i < rounds; i += 1) await Promise.resolve();
      await new Promise((r) => setTimeout(r, 0));
    },
    /** Simulate the worker waking on an inbound message (the common cold-wake path). */
    async wake(message = { type: "getStatus" }, sender = { tab: { id: 999 } }) {
      listeners.onMessage[0]?.(message, sender, () => {});
      await this.drain();
    },
    /** Simulate a browser-start event. */
    async startup() {
      listeners.onStartup.forEach((fn) => fn());
      await this.drain();
    },
  };
}
