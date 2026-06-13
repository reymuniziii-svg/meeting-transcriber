# Repo Scorecard — meeting-transcriber

_Reviewed: 2026-06-13 · branch `main` @ d448b67. Original review below; updated after the gap-closing pass (PLAN.md / SPEC.md)._

## Health: 4 / 5 — **Quick cleanup** _(was 3/5 "Needs work")_

A well-architected, genuinely working local-first tool with good UI security hygiene. The central data-loss bug that defined the 3/5 is **fixed and regression-tested**, the durability race is closed, and the dead code is gone — so what remains is a quick-cleanup tier: two medium localhost-WebSocket security gaps and the inherent (out-of-scope) brittleness of DOM speaker-name scraping.

> ### Update — gap-closing pass (2026-06-13)
> Worked SPEC.md's must-work behaviors to green (`node --test tests/` 9/9 + Python 5/5), independently re-reviewed.
> - ✅ **Fixed** Phase 2 #1 (lost transcript + bricked captures on worker death) — `recoverStaleMeetings()` in `background.js`, with an offscreen-liveness probe so it never truncates a still-live capture. Tests `MW3b`/`MW3d`.
> - ✅ **Fixed** Phase 2 #3 (storage read-modify-write race) — `withStorageLock()`. Test `MW3c`.
> - ➖ **Reclassified out of scope** Phase 2 #2 (diarization mislabeling) — SPEC marks pyannote out of scope; the dead batch path was deleted.
> - ✅ **Deleted** all Phase 3 items (storage.js, getMeetingSnapshot, launchd vars, batch transcribe.py + merge helper) — net −336 source lines.
> - ⏳ **Still open:** the two Phase 4 security mediums (out of SPEC scope) and the speaker-name brittleness — see Recommended action.

---

## About this repo

Privacy-first Chrome MV3 extension that captures meeting **tab audio** (Google Meet / Teams / Zoom web), streams 16 kHz mono PCM to a **local** Python WebSocket server (`ws://127.0.0.1:9090`) running **whisper.cpp** (+ Silero VAD, optional pyannote diarization), and merges the transcript with real speaker names scraped from the meeting UI. Output is Markdown via the Chrome Downloads API, correctable on a review page. Nothing leaves the machine.

- **Stack:** vanilla-JS MV3 extension (service worker, offscreen audio doc, per-platform content scripts) + Python 3 asyncio/`websockets` server; whisper.cpp via Homebrew; torch/Silero VAD; macOS `launchd`; Bash installers.
- **Commands:** install `./install.sh` · build _none_ (load unpacked) · test `python3 -m unittest discover -s server/tests` · run `./start-server.sh` (or launchd) · health `./install.sh --check`.
- **Riskiest area:** `background.js` service-worker capture/finalize state machine + the unauthenticated localhost WebSocket boundary.

---

## Phase 1 — Does it work? (verbatim verdict)

```
Builds:   yes — manifest.json valid, all 17 referenced files exist, all .py/.sh files parse cleanly
Tests:    pass — 5/5 tests pass in 0.002s with zero failures or skips
Runs:     partial — `python3 server/transcription-server.py --help` works; `./start-server.sh` exits early (missing fallback/.venv, never installed)
Blockers: fallback/.venv absent (run ./install.sh); torch/torchaudio/pyannote.audio not installed (VAD/diarization disabled without them)
```

_The "partial" run is expected on a fresh checkout — `./install.sh` creates the venv. Not a code defect._

_Added in the gap-closing pass: a zero-dependency Node harness (`tests/`, run `node --test tests/background.behaviors.test.mjs`) that drives `background.js` under mocked `chrome.*` APIs — 9 behavior tests, one per SPEC must-work behavior. Currently 9/9._

---

## Phase 2 — Top correctness issues

1. **[HIGH] Transcripts are lost — and all future captures blocked — if the MV3 worker dies mid-finalize.** `background.js:126-149`. On meeting end the meeting goes `pendingFinalization=true` / `captureStatus="stopping"` and depends on a 2s fallback timer to actually save. MV3 kills idle workers in ~30s, so "close tab and walk away" loses the timer. On restart, `rehydrateMeetings` restores the meeting but **nothing re-calls `finalizeMeetingIfReady` for pending meetings** — so the transcript is never written, no review tab opens, and the ghost `"stopping"` meeting (counts as `isCaptureLive`) permanently blocks new captures via the single-capture check (`:294`). Fix: after rehydrate, finalize any `pendingFinalization` meeting. **→ ✅ FIXED** — `recoverStaleMeetings()` finalizes pending/stale meetings on cold-worker wake and clears ghosts, with an offscreen-liveness probe so a still-live capture is never truncated. Tests `MW3b`, `MW3d`.
2. **[HIGH] Diarization speaker labels are jumbled across any meeting > 30 s (when `HF_TOKEN` is set).** `server/transcription-server.py:212-253`. Each refresh re-runs pyannote on a disjoint ~30 s chunk and rebuilds `Speaker N` labels from that chunk's order only; pyannote's `SPEAKER_xx` IDs are local to each call, and the client keys on the unstable `speaker_id` (`background.js:592,654`). "Speaker 1" in minute 1 ≠ minute 2. Fix: diarize a rolling full-meeting window (or once at finalize). **→ ➖ OUT OF SCOPE** — SPEC marks pyannote out of scope; left as-is (optional, off by default), and the standalone batch diarization path was deleted.
3. **[HIGH-confidence race] Unsynchronized read-modify-write of the whole meetings object loses updates / resurrects deleted meetings.** `background.js:812-826`. `persistMeetingState`/`removePersistedMeeting` do `get → mutate → set` on the shared `STORAGE_KEY` with no lock; with two tabs, a tab-1 finalize-delete interleaved with a tab-2 persist rewrites the deleted entry back → ghost meeting rehydrated, possibly re-downloaded. Fix: serialize writes, or write only the single tab's sub-key. **→ ✅ FIXED** — all map writes now serialize through `withStorageLock()`. Test `MW3c`.

_Also real, lower priority:_ offscreen socket `close`/`error` handlers read the global `captureState` instead of their own session (`offscreen.js:162-182`) — latent teardown-of-wrong-capture, gated today by the single-capture rule; and the diarization-disabled path holds ~86 MB of PCM needlessly (see Phase 3 note / `transcription-server.py:255-270`).

---

## Phase 3 — Overbuilt check: **Mildly overbuilt**

Core extension + server are right-sized; there's a discrete cluster of dead weight (~350–650 deletable lines). **→ ✅ All three deleted in the gap-closing pass (net −336 source lines), including the optional batch-tool cut.** Deletion list:

1. **`lib/storage.js` — entire file is dead** (~57 lines + 3 `manifest.json` refs). `TranscriptStorage` has zero callers (verified) and targets the abandoned `currentMeeting` key. Drop the file and its three content-script injections. _(This is also where bug-hunter's debounce bug lives — dead, so delete rather than fix.)_
2. **`getMeetingSnapshot` receive-path is dead across 4 files** (~22 lines). Listeners exist in all three content scripts + `speaker-tracker.getSnapshot()`, but **nothing sends** the message (verified). Remove listeners + `getSnapshot`.
3. **Two unread launchd env vars** `MEETING_TRANSCRIBER_REPO_DIR` / `MEETING_TRANSCRIBER_LOG_DIR` (`launchd/…plist.template:14-21`) — nothing reads them. _(Bigger optional cut: the standalone `fallback/transcribe.py` CLI + its sole-use `merge_transcription_and_diarization` helper, ~295 lines, are not wired into the extension — delete if you don't run the batch tool.)_

---

## Phase 4 — Security (high/medium only)

1. **[MEDIUM] No `Origin` check on the localhost WebSocket.** `server/transcription-server.py:317-324`. WebSocket connections bypass same-origin, so **any website the user visits** can open `ws://127.0.0.1:9090`, send `start` + audio, and spawn whisper.cpp jobs → local CPU/disk DoS (and temp-dir churn). Binding to `127.0.0.1` does **not** prevent browser cross-origin connections. Fix: validate the `Origin` header (or require a handshake token the extension knows).
2. **[MEDIUM] The server doesn't enforce its own bind host.** `server/transcription-server.py:332`. `--host` accepts `0.0.0.0` with no guard; only `start-server.sh:64` refuses non-`127.0.0.1`. Launched directly, or via an edited launchd template, the **unauthenticated** server is exposed to the LAN. Fix: enforce `127.0.0.1` in the server itself.

_Clean: whisper subprocess uses argv lists (no shell injection); review UI renders participant names via `textContent`/`createElement` (no XSS); secrets (`HF_TOKEN`) live in `~/.config`, not the repo._

---

## Recommended action

**Quick cleanup.** The data-loss bug (Phase 2 #1), the storage race (#3), and all the dead code are done and test-backed — the repo now meets its SPEC. The remaining items are both **out of SPEC scope** but worth a follow-up: (1) add an `Origin` check (or handshake token) to the localhost WebSocket and have the server self-enforce its `127.0.0.1` bind (Phase 4 — the highest-value next step); (2) speaker-name accuracy is still bounded by DOM-selector brittleness — acceptable by design, but the place real-world quality will fade. Neither blocks daily use.
