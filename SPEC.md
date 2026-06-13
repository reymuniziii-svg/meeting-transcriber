# SPEC — Meeting Transcriber

_Intent captured with the user on 2026-06-13. The user is the source of truth; the code only shows what was built. Where the two diverge, this file wins._

## Purpose

Turn my Meet / Teams / Zoom calls into **accurate, speaker-labeled Markdown transcripts with zero friction**, so meetings become reliable searchable notes and records. It exists because generic transcribers don't reliably attach *real names* to who-said-what, and I don't want a bot in the meeting. Built first for my own PR-agency meetings; clean installability by other people is a real future goal, not a today goal.

## Who / what it serves

- **Primary user (today):** me, on my Mac, for my own meetings.
- **Future:** colleagues / other people who install it themselves.
- **Consumer of the output:** a human reading the resulting Markdown transcript (which I then move into my own tools/files manually).

## Definition of good

All four of these are **core**, not nice-to-have. The tool only counts as "working" if every one holds:

1. **Accurate transcript text** — words are right enough to use as notes without heavy editing.
2. **Correct speaker names** — who-said-what is labeled with real names from the meeting UI.
3. **Never loses a transcript** — if a meeting happened, I always end up with the file.
4. **Zero-friction capture** — it just works when a meeting starts; no per-call setup or babysitting.

## Must-work behaviors

1. **Start → auto-capture.** When a supported meeting opens, audio capture begins automatically (or with a single click if Chrome demands a user gesture) — no per-call setup.
2. **Speech → real name.** When someone speaks, their words are labeled with their real name scraped from the meeting UI, not "Speaker 1."
3. **End/close → saved.** When a meeting ends or the tab closes (even abruptly mid-call), the complete transcript is written to disk, including the final spoken segment.
4. **Failure → clear error.** When the local server is down or capture fails, the popup says so plainly — it never silently drops audio or fakes success.

## Out of scope

These are explicitly **not** goals — guardrails against over-building:

- **Acoustic diarization (pyannote / HF_TOKEN voice clustering).** Real names from the meeting UI are the intended source of who-said-what; the pyannote path is optional and droppable.
- **Multiple meetings at once.** Only one live capture ever runs. Concurrent multi-meeting capture is not a goal.
- **Windows / Linux support.** macOS-only is acceptable.
- **Cloud sync / upload / built-in sharing.** No backend, no account, no sharing UI. Transcripts are local files I move manually. (This is about *features* — see Constraints for the engine.)

## Constraints

- **Nothing is locked.** The user explicitly did not fix any technical constraint. The stack (local Python + whisper.cpp, vanilla-JS MV3 extension, Chrome-only, load-unpacked, launchd auto-start) is all **open to redesign**. Optimize purely for the outcome (the four must-work behaviors).
- **Even on-device processing is negotiable.** The current build is privacy-first and fully local, and that is its present identity — but the user has *not* locked it as a hard requirement. A cloud-based transcription engine would be acceptable if it clearly better delivers accuracy / speaker names / reliability / low friction.
  - Boundary: that openness applies to the *engine*, not to *features*. Building sync/sharing/upload remains out of scope regardless.

## Open questions

- **Should privacy-first-local stay the de facto approach?** It isn't a hard constraint, but the entire current codebase is built around it. Worth a deliberate decision before any rebuild swaps the engine for a cloud service — the trade is real-name accuracy/friction vs. the privacy promise the README currently makes.
- **Is the post-meeting review/correction page a must-keep?** It supports "correct speaker names" but wasn't named as a must-work behavior. Treat as a supporting feature unless told otherwise.

---

## Test checklist

Plain-English pass/fail checks — one per must-work behavior. The gap between this spec and reality = which of these currently fail.

_Reality column updated after the 2026-06-13 gap-closing pass (PLAN.md). Every behavior is now backed by a runnable test (`node --test tests/`); the named test pins it. Legend: ✅ pass · ⚠️ partial (out of scope) · ❌ fail. **Current tally: 5 pass, 1 partial, 0 fail.**_

- ☑ Opening a Google Meet / Teams / Zoom web meeting starts audio capture automatically (or after a single "Connect Audio" click), with no other setup.
  - _Reality:_ ✅ **Pass** — auto-start + gesture fallback work. The old caveat (a prior meeting stuck in "stopping" silently blocking a fresh start) is **resolved**: cold-worker recovery now clears stale/ghost meetings. Test: `MW1`.
- ☐ A captured utterance appears in the transcript labeled with the speaker's **real name** from the meeting UI, not a generic "Speaker N."
  - _Reality:_ ⚠️ **Partial — unchanged, by design.** The merge mechanism is correct and now locked by a test (`MW2`: real DOM names attach when speaker events exist), but real-world accuracy is still bounded by per-platform selector brittleness (fails to a warning badge) with no acoustic fallback. Improving selector robustness is **explicitly out of scope** (pyannote is out of scope; see above).
- ☑ Ending a meeting normally writes a Markdown transcript to disk, and the **last thing said** before it ended is present in that file.
  - _Reality:_ ✅ **Pass** — normal end flushes the final window on `stop` and `finalizeMeetingIfReady` writes it, last segment included. Test: `MW3a`. (Minor 800 ms stop-timeout clip risk on a slow model remains — out of scope.)
- ☑ Closing the meeting tab **abruptly mid-call** still produces a complete transcript file including the final segment.
  - _Reality:_ ✅ **Pass** — abrupt close flags `pendingFinalization`; even if the worker dies before the 2 s timer, the **next cold-worker wake finalizes it** (recovery). Test: `MW3b`.
- ☑ A captured transcript is **never silently lost** — e.g. after a browser/service-worker restart, an in-progress meeting still ends up saved rather than stuck or dropped.
  - _Reality:_ ✅ **Pass — fixed (was the headline failure).** Cold-worker recovery finalizes `pendingFinalization` and genuinely-stale (offscreen-dead) meetings and clears ghosts; a **still-live** capture is left alone via an offscreen-liveness probe (so recovery never truncates an ongoing meeting); serialized storage writes stop concurrent updates from clobbering each other. Tests: `MW3b`, `MW3c`, `MW3d`. [background.js `recoverStaleMeetings`]
- ☑ With the local server stopped, starting capture shows a **clear failure message** in the popup — no silent failure, no fake "success."
  - _Reality:_ ✅ **Pass** — `waitForServerReachability` + disconnect handlers set a clear `captureError`; no capture starts, no fake success. Test: `MW4`.
