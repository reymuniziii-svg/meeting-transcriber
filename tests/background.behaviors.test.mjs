/**
 * SPEC must-work behaviors, encoded as runnable tests against background.js.
 * See SPEC.md "Test checklist". Each test names the behavior it locks.
 *
 * Run: node --test tests/
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { loadBackground } from "./helpers/load-background.mjs";

const AUDIO_START = 1_000_000_000 - 30_000; // 30s before "now"

/** A meeting as it would be persisted in chrome.storage.local. */
function meeting(overrides = {}) {
  return {
    tabId: 7,
    sessionId: "tab-7",
    platform: "Google Meet",
    title: "Standup",
    startTime: new Date(AUDIO_START).toISOString(),
    startEpochMs: AUDIO_START,
    endTime: new Date(AUDIO_START + 20_000).toISOString(),
    endEpochMs: AUDIO_START + 20_000,
    audioStartEpochMs: AUDIO_START,
    participants: ["Alice Rivera"],
    // Alice speaks from +1s to +6s of audio.
    speakerEvents: [
      { name: "Alice Rivera", timestamp: AUDIO_START + 1000 },
      { name: null, timestamp: AUDIO_START + 6000 },
    ],
    transcriptionSegments: [
      { start: 1.0, end: 3.0, text: "Hello team, quick standup." },
      { start: 3.2, end: 5.0, text: "These are the final words." },
    ],
    diarizationSegments: [],
    captureStatus: "idle",
    captureError: null,
    serverStatus: "disconnected",
    pendingFinalization: false,
    ...overrides,
  };
}

const seedWith = (m) => ({ currentMeetingsByTabId: { [String(m.tabId)]: m } });

// Sanity: the VM actually loaded background.js and exposed its functions.
test("harness loads background.js internals", () => {
  const h = loadBackground({ storage: {} });
  assert.equal(typeof h.ctx.finalizeMeetingIfReady, "function");
  assert.equal(typeof h.ctx.buildMergedTranscript, "function");
  assert.equal(typeof h.ctx.startCaptureForMeeting, "function");
});

// MW2 — Speech -> real name. Given DOM speaker events that overlap a spoken
// segment, the transcript is labeled with the real name, not "Speaker N".
test("MW2: spoken segments get the real speaker name from DOM events", () => {
  const h = loadBackground({ storage: {} });
  const out = h.ctx.buildMergedTranscript(meeting());
  assert.ok(out.length >= 1, "should produce transcript entries");
  assert.ok(
    out.every((e) => e.speaker === "Alice Rivera"),
    `every entry should be Alice Rivera, got ${JSON.stringify(out.map((e) => e.speaker))}`,
  );
  assert.ok(!out.some((e) => /Unknown|Speaker \d/.test(e.speaker)), "no generic labels");
});

// MW3a — End normally -> saved, including the final spoken segment.
test("MW3a: finalize writes a transcript that includes the last segment", async () => {
  const m = meeting();
  const h = loadBackground({ storage: seedWith(m) });
  await h.ctx.rehydrateMeetings(); // populate activeMeetings from storage
  await h.ctx.finalizeMeetingIfReady(7);
  await h.drain();

  assert.equal(h.calls.downloads.length, 1, "one markdown file should be written");
  const markdown = h.calls.blobs.at(-1) || "";
  assert.match(markdown, /These are the final words\./, "final segment must be present");
  assert.equal(h.calls.tabsCreated.length, 1, "review tab should open");
});

// MW3b — THE GAP (SPEC check 5). After the service worker dies mid-finalize and
// is later woken by a message, a meeting left pendingFinalization must still be
// saved, and must not remain as a live "ghost" that blocks future captures.
test("MW3b: a pendingFinalization meeting is recovered (saved + cleared) on worker wake", async () => {
  const m = meeting({ pendingFinalization: true, captureStatus: "stopping" });
  const h = loadBackground({ storage: seedWith(m) });

  await h.wake(); // cold worker wakes on an inbound message

  assert.equal(h.calls.downloads.length, 1, "lost transcript should be saved on recovery");
  const ghost = h.local.currentMeetingsByTabId?.["7"];
  assert.equal(ghost, undefined, "the recovered meeting must be removed from storage (no ghost)");
});

// MW3b (cont.) — a capture interrupted by worker death (no pendingFinalization)
// must not stay stuck in a live status that bricks all future captures.
test("MW3b: a capture interrupted by restart no longer blocks future captures", async () => {
  const m = meeting({ captureStatus: "capturing", pendingFinalization: false });
  const h = loadBackground({ storage: seedWith(m) });

  await h.wake();

  const live = ["starting", "waiting_for_server", "capturing", "stopping"];
  const survivor = h.local.currentMeetingsByTabId?.["7"];
  if (survivor) {
    assert.ok(
      !live.includes(survivor.captureStatus),
      `interrupted meeting must not keep a live status, got "${survivor.captureStatus}"`,
    );
  }
  // (If it was finalized away entirely, that's also non-blocking — fine.)
});

// MW3d — Regression guard for the recovery fix. In MV3 the offscreen capture
// document and the service worker have independent lifecycles: the worker can
// idle-die mid-call while the offscreen keeps recording, then wake cold when the
// offscreen delivers the next segment. Recovery must NOT finalize a meeting whose
// offscreen capture is still alive — that would truncate the transcript and pop a
// review tab mid-meeting (the opposite of "never lose").
test("MW3d: a still-live capture (offscreen alive) is NOT finalized on a cold wake", async () => {
  const m = meeting({ captureStatus: "capturing", pendingFinalization: false });
  const h = loadBackground({ storage: seedWith(m), offscreenOpen: true });

  await h.wake(
    {
      type: "offscreenTranscription",
      tabId: 7,
      segments: [{ start: 10, end: 12, text: "live words after the worker restarted" }],
    },
    { tab: { id: 7 } },
  );

  assert.equal(h.calls.downloads.length, 0, "must NOT finalize/write while capture is live");
  assert.equal(h.calls.tabsCreated.length, 0, "must NOT open a review tab mid-call");
  const survivor = h.local.currentMeetingsByTabId?.["7"];
  assert.ok(survivor, "the live meeting must remain");
  const texts = (survivor.transcriptionSegments || []).map((s) => s.text);
  assert.ok(
    texts.includes("live words after the worker restarted"),
    "the segment that woke the worker must be appended, not dropped",
  );
});

// MW3c — Durability (SPEC "never loses a transcript"). Concurrent state writes
// must not clobber each other; a lost write = a recovered transcript missing its
// most recent segments.
test("MW3c: concurrent meeting-state writes do not lose data", async () => {
  const h = loadBackground({ storage: { currentMeetingsByTabId: {} } });
  const m7 = h.ctx.createMeetingState(7);
  const m8 = h.ctx.createMeetingState(8);

  // Fire both without awaiting between them, forcing the get/modify/set interleave.
  await Promise.all([h.ctx.persistMeetingState(m7), h.ctx.persistMeetingState(m8)]);

  const map = h.local.currentMeetingsByTabId || {};
  assert.ok(map["7"], "tab 7 must survive a concurrent write");
  assert.ok(map["8"], "tab 8 must survive a concurrent write");
});

// MW4 — Failure -> clear error. With the local server unreachable, starting
// capture must fail loudly with a captureError, never silently "succeed".
test("MW4: server down -> startCapture fails with a clear error, no fake success", async () => {
  const m = meeting({ captureStatus: "idle" });
  const h = loadBackground({ storage: seedWith(m), wsBehavior: "error" });
  await h.ctx.rehydrateMeetings();

  const result = await h.ctx.startCaptureForMeeting(7, true);

  assert.equal(result.ok, false, "must not report success when server is down");
  assert.match(result.error || "", /server|timed out/i, "error should mention the server");
  assert.equal(h.calls.sentMessages.filter((x) => x.type === "startCapture").length, 0,
    "no capture should be started");
});

// MW1 — Start -> auto-capture. With the server reachable, starting capture
// drives the offscreen pipeline and emits a startCapture command.
test("MW1: server up -> startCapture launches the offscreen capture", async () => {
  const m = meeting({ captureStatus: "idle" });
  const h = loadBackground({ storage: seedWith(m), wsBehavior: "open" });
  await h.ctx.rehydrateMeetings();

  const result = await h.ctx.startCaptureForMeeting(7, true);

  assert.equal(result.ok, true, "capture should start when the server is reachable");
  assert.ok(h.calls.offscreenCreated >= 1, "offscreen document should be created");
  assert.equal(h.calls.sentMessages.filter((x) => x.type === "startCapture").length, 1,
    "exactly one startCapture command should be emitted");
});
