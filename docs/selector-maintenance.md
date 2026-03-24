# Selector Maintenance Guide

Meeting platforms frequently update their web UI, which can break the DOM selectors used to scrape captions. This guide explains how to identify and fix broken selectors.

## When Selectors Break

You'll know selectors are broken when:
- The extension shows "Recording..." but no segments are captured
- Speaker names show as "Unknown Speaker"
- The captions container isn't detected (no recording starts)

## How to Fix

### 1. Open DevTools

1. Join a meeting in Chrome
2. Enable captions in the meeting
3. Open DevTools (`Cmd+Option+I`)
4. Go to the **Elements** tab

### 2. Find the Captions Container

With captions visible on screen:

1. Use the element picker (`Cmd+Shift+C`) and click on a caption
2. Walk up the DOM tree to find the container that holds all captions
3. Look for stable attributes: `role`, `aria-label`, `data-tid`, `jsname`
4. Avoid relying on class names — they're often auto-generated and change frequently

### 3. Identify Speaker and Text Elements

Within each caption block, find:
- **Speaker name element**: Usually a separate `<div>` or `<span>` with the person's name
- **Text element**: The caption text that updates in real-time

Note the relationship between them (sibling, parent-child, etc.).

### 4. Update the Content Script

Each platform's content script has a `SELECTORS` object at the top:

```javascript
const SELECTORS = {
  captionsContainer: '...',
  speakerName: '...',
  captionText: '...',
  // ...
};
```

Update the relevant selectors. Prefer:
- `[data-tid="..."]` (Teams-specific stable attributes)
- `[role="region"]` (ARIA roles)
- `[aria-label="..."]` (accessibility labels)
- `[jsname="..."]` (Google's stable JS hooks)

Over:
- `.randomClassName` (auto-generated, breaks often)
- Complex nested selectors

### 5. Test

1. Reload the extension at `chrome://extensions/`
2. Join a test meeting
3. Verify captions are captured with speaker names
4. Check the console for `[MeetingTranscriber]` log messages

## Platform-Specific Notes

### Google Meet

**Captions container**: Look for `div[role="region"]` with `tabindex="0"` — this is the scrollable captions area.

**Speaker names**: Google Meet nests the speaker name in a sibling element above the text. The code walks up the DOM tree from the text node to find the name. If Google changes this nesting, update `findSpeakerName()` in `google-meet.js`.

**Known quirk**: Meet keeps only the last few caption blocks visible and mutates them in-place. The `characterData` mutation type is key.

### Microsoft Teams

**Most stable selectors**: Teams uses `data-tid` attributes extensively. These are more stable than class names.

Key `data-tid` values:
- `closed-caption-v2-virtual-list-content` — captions container
- `author` — speaker name
- `closed-caption-text` — caption text
- `hangup-main-btn` — leave button (meeting detection)

### Zoom Web

**Iframe challenge**: Zoom renders inside `#webclient` iframe. All queries must go through `iframe.contentDocument`.

**Caption classes**: Zoom uses descriptive class names like `.live-transcription-subtitle__box` which are more stable than auto-generated ones, but still change between versions.

**Avatar matching**: When speaker names aren't in text form, the code matches avatar `<img>` elements against participant images elsewhere on the page. If Zoom changes avatar rendering, update `extractSpeakerAndText()` in `zoom-web.js`.

## Debugging Tips

Open the Chrome DevTools console and filter for `[MeetingTranscriber]` to see the extension's logs:

```
[MeetingTranscriber] Google Meet content script loaded.
[MeetingTranscriber] Observing captions container.
```

If you see "content script loaded" but not "Observing captions", the captions container selector is broken.

If you see "Observing" but no segments in the popup, the speaker/text extraction is broken.

## Submitting a Fix

1. Update the selectors in the relevant content script
2. Test on a live meeting
3. Note your Chrome version and the date (helps track when platforms change)
4. Submit a PR with before/after screenshots if possible
