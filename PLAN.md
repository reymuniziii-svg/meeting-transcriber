# PLAN — Close the gap to SPEC.md

_Plan written 2026-06-13. Scope = the SPEC.md must-work behaviors only. No engine redesign, no feature adds, no security work (tracked separately in SCORECARD)._

## The gap (from Phase 1 tests)

`node --test tests/background.behaviors.test.mjs` → **5 pass, 2 fail**. The two failures are the entire gap:

- ❌ `MW3b: a pendingFinalization meeting is recovered (saved + cleared) on worker wake`
- ❌ `MW3b: a capture interrupted by restart no longer blocks future captures`

Both are SPEC check 5 (**"never loses a transcript"**) and its knock-on (a ghost meeting bricks future capture, hurting check 1 / MW1). Everything else SPEC asks for already passes. Python suite: 5/5 green.

---

## Items (ordered by importance)

### Fix

**F1 — Recover stale meetings when the worker wakes.** _(closes both failing tests)_
- File: **`background.js` only.**
- Add `recoverStaleMeetings()`: after `rehydrateMeetings()`, for each loaded meeting that is `pendingFinalization` **or** in a live `captureStatus` (`starting`/`waiting_for_server`/`capturing`/`stopping`), call `finalizeMeetingIfReady(tabId)`. `finalizeMeetingIfReady` already saves-if-there-are-segments and cleans-up-if-empty, so this both **rescues the partial transcript** (never lose) and **clears the ghost** (unblocks future captures).
- Wire it into the cold-wake paths: call it right after rehydrate inside `ensureMeetingsLoaded()`, and from `onInstalled` / `onStartup`. Safe because rehydrate only runs on a cold worker (in-memory `activeMeetings` empty ⇒ any persisted "live" capture is provably dead — the offscreen doc died with the worker).
- **Deliberate behavior:** if the worker dies *mid-call* with segments already captured, recovery saves the partial and opens the review tab. That can surface mid-meeting, but it honors "never lose" and is rare. Auto-*resuming* a broken capture is **out of scope** (a feature, not a fix).
- **Done =** both `MW3b` tests green; all other Node + Python tests stay green.

**F2 — Serialize storage writes.** _(optional hardening; same file as F1 ⇒ serial)_
- File: **`background.js` only.**
- `persistMeetingState` / `removePersistedMeeting` do an unsynchronized `get → mutate whole map → set`; two concurrent handlers (e.g. `activeSpeaker` + `offscreenTranscription`) can lose the persisted copy of recent segments, so a post-restart recovery reads a stale transcript. Fix: route all writes through a single promise-chain queue so they can't interleave.
- **Done =** a new `MW3c` test that interleaves two persists asserts both survive in storage (RED before, GREEN after); other tests stay green.
- _Recommend including_ (it serves the #1 "never lose" priority and is ~10 lines), but it can be deferred without affecting F1.

### Deletions (simplifier-flagged overbuilt + SPEC out-of-scope)

Per the guardrail "treat overbuilt as a deletion": these are dead or out-of-scope. Each is mechanical and low-risk.

**D1 — Dead `lib/storage.js`.** Delete the file; remove its 3 `manifest.json` content-script refs. `TranscriptStorage` has zero callers. _(Also removes the latent debounce bug that lived only in this dead module.)_
**D2 — Dead `getMeetingSnapshot` path.** Remove the listener block in `content-scripts/{google-meet,ms-teams,zoom-web}.js` and `getSnapshot` from `lib/speaker-tracker.js`. No sender exists.
**D3 — Out-of-scope batch diarization.** Delete `fallback/transcribe.py` and `merge_transcription_and_diarization` from `server/whisper_utils.py` (its only caller). SPEC marks pyannote out of scope; this is the standalone batch CLI, not wired into the extension. _(Keep `fallback/.venv` + `requirements.txt` — the streaming server runs from there. Streaming diarization in `transcription-server.py` is left as-is: optional, off by default, not simplifier-flagged.)_
**D4 — Unused launchd env vars.** Remove `MEETING_TRANSCRIBER_REPO_DIR` / `MEETING_TRANSCRIBER_LOG_DIR` from `launchd/…plist.template`; nothing reads them.

- **Done (each) =** no dangling references (grep clean), `manifest.json` / plist still parse, and the full Node + Python suites stay green.

---

## Parallel-safe partition (files are disjoint)

| Stream | Files touched | Depends on |
|--------|---------------|------------|
| **A** (F1, F2) | `background.js` | — |
| **B** (D1) | `lib/storage.js`, `manifest.json` | — |
| **C** (D2) | `content-scripts/*.js`, `lib/speaker-tracker.js` | — |
| **D** (D3) | `fallback/transcribe.py`, `server/whisper_utils.py` | — |
| **E** (D4) | `launchd/*.plist.template` | — |

Streams A–E touch non-overlapping files, so they are parallel-safe in principle.

**Recommended execution: a single serial session, test-first — do _not_ escalate.** This is a small gap (one real fix + four mechanical deletions). Per the ladder, an agent-team/worktree setup would cost more coordination than the work itself. Order: **F1 → F2 → D1 → D2 → D3 → D4**, re-running the suite after each.

---

## Explicitly out of scope (guardrails against re-bloat)

- **Speaker-name accuracy beyond the existing DOM mechanism** (SPEC check 2 "partial"). It's inherent to DOM scraping, not a discrete bug; new selectors / acoustic fallback are not in scope (pyannote is SPEC-out-of-scope).
- **The 800 ms offscreen stop-timeout** that could clip a final window on a slow model. Normal-end already passes; reworking it needs a server round-trip redesign. Defer.
- **Security findings** (WebSocket `Origin` check, server self-binding to 127.0.0.1). Real, but not a SPEC must-work behavior. Tracked in SCORECARD; decide separately.
- **Engine redesign / cloud transcription** (SPEC open question — decide deliberately first).
- **Auto-resume of a capture broken by worker death** (a feature).
- **Multi-meeting concurrency, Windows/Linux, cloud sync** (SPEC out of scope).
- **The review/correction page stays** (SPEC open question: keep as supporting feature).

---

## Verification (Phase 4)

1. `node --test tests/background.behaviors.test.mjs` → all green (incl. the two formerly-red).
2. `python3 -m unittest discover -s server/tests` → still 5/5.
3. Grep that deleted symbols/files leave no references; `manifest.json` + plist parse.
4. Fresh-context adversarial review of the combined diff against SPEC.md; refresh SCORECARD.
