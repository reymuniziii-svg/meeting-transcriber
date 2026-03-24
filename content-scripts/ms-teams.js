/**
 * Microsoft Teams (web) caption scraper.
 *
 * DOM structure (as of early 2026):
 * - Captions container: [data-tid="closed-caption-v2-virtual-list-content"]
 *   or [data-tid="closed-captions-renderer"] or [data-tid*="closed-caption"]
 * - Individual caption: .fui-ChatMessageCompact
 * - Speaker name: [data-tid="author"]
 * - Caption text: [data-tid="closed-caption-text"]
 *
 * References: Live-Captions-Saver (Zerg00s)
 */

(() => {
  const PLATFORM = "Microsoft Teams";
  let captionObserver = null;
  let meetingDetectionInterval = null;
  let captionDetectionInterval = null;
  let hasStarted = false;
  let processedCaptionIds = new Map(); // captionId -> last known text

  const SELECTORS = {
    // Meeting active: hangup button
    hangupButton:
      'button[data-tid="hangup-main-btn"], button[data-tid="hangup-leave-button"], #hangup-button',
    // Pre-join button
    prejoinButton: "#prejoin-join-button",
    // Captions container (multiple fallbacks)
    captionsContainer: [
      '[data-tid="closed-caption-v2-virtual-list-content"]',
      '[data-tid="closed-captions-renderer"]',
      '[data-tid*="closed-caption"]',
    ],
    // Individual caption elements
    captionItem: ".fui-ChatMessageCompact, [data-tid*='caption-item']",
    // Speaker name within a caption
    speakerName: '[data-tid="author"]',
    // Caption text within a caption
    captionText: '[data-tid="closed-caption-text"]',
    // Captions ready indicator
    captionsReady: '[data-tid="closed-caption-renderer-wrapper"]',
    // Meeting title
    meetingTitle: '[data-tid="meeting-title"], [data-tid="call-title"]',
  };

  function init() {
    console.log("[MeetingTranscriber] Teams content script loaded.");
    meetingDetectionInterval = setInterval(detectMeeting, 2000);
  }

  function detectMeeting() {
    const hangupBtn = document.querySelector(SELECTORS.hangupButton);
    if (hangupBtn && !hasStarted) {
      hasStarted = true;
      clearInterval(meetingDetectionInterval);
      onMeetingJoined();
    }
  }

  function onMeetingJoined() {
    const titleEl = document.querySelector(SELECTORS.meetingTitle);
    const title = titleEl ? titleEl.textContent.trim() : "";

    CaptionParser.startMeeting(PLATFORM, title || document.title);

    // Auto-enable captions via keyboard shortcut
    autoEnableCaptions();

    // Poll for captions container
    captionDetectionInterval = setInterval(detectCaptions, 1000);

    watchForMeetingEnd();
  }

  /**
   * Enable captions via keyboard shortcut.
   * macOS: Cmd+Shift+A  |  Windows: Alt+Shift+C
   */
  function autoEnableCaptions() {
    setTimeout(() => {
      const isMac = navigator.platform.toUpperCase().includes("MAC");
      const event = new KeyboardEvent("keydown", {
        key: isMac ? "a" : "c",
        code: isMac ? "KeyA" : "KeyC",
        shiftKey: true,
        metaKey: isMac,
        altKey: !isMac,
        bubbles: true,
      });
      document.dispatchEvent(event);
      console.log("[MeetingTranscriber] Sent captions shortcut.");
    }, 4000);
  }

  function detectCaptions() {
    let container = null;
    for (const selector of SELECTORS.captionsContainer) {
      container = document.querySelector(selector);
      if (container) break;
    }

    if (container) {
      clearInterval(captionDetectionInterval);
      startObserving(container);
    }
  }

  function startObserving(container) {
    console.log("[MeetingTranscriber] Observing Teams captions.");

    captionObserver = new MutationObserver(() => {
      processCaptions(container);
    });

    captionObserver.observe(container, {
      childList: true,
      subtree: true,
      characterData: true,
    });

    processCaptions(container);
  }

  /**
   * Process all visible caption elements in the container.
   * Teams creates distinct elements per caption line and updates text in-place.
   */
  function processCaptions(container) {
    const items = container.querySelectorAll(SELECTORS.captionItem);

    items.forEach((item) => {
      // Generate or retrieve a stable ID for this element
      let captionId = item.getAttribute("data-mt-caption-id");
      if (!captionId) {
        captionId = `cap_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        item.setAttribute("data-mt-caption-id", captionId);
      }

      const nameEl = item.querySelector(SELECTORS.speakerName);
      const textEl = item.querySelector(SELECTORS.captionText);

      if (!nameEl || !textEl) {
        // Fallback: try to extract from innerText
        processItemFallback(item, captionId);
        return;
      }

      const speaker = nameEl.innerText.trim();
      const text = textEl.innerText.trim();

      if (!speaker || !text) return;

      // Only process if text has changed
      const lastText = processedCaptionIds.get(captionId);
      if (lastText === text) return;

      processedCaptionIds.set(captionId, text);
      CaptionParser.processCaption(speaker, text, captionId);
    });
  }

  /**
   * Fallback for when specific selectors don't match.
   */
  function processItemFallback(item, captionId) {
    const text = item.innerText.trim();
    if (!text) return;

    const lastText = processedCaptionIds.get(captionId);
    if (lastText === text) return;

    processedCaptionIds.set(captionId, text);

    // Try to split first line as speaker
    const lines = text.split("\n").filter((l) => l.trim());
    if (lines.length >= 2) {
      CaptionParser.processCaption(lines[0].trim(), lines.slice(1).join(" ").trim(), captionId);
    } else {
      CaptionParser.processCaption("Unknown Speaker", text, captionId);
    }
  }

  function watchForMeetingEnd() {
    const endCheck = setInterval(() => {
      const hangupBtn = document.querySelector(SELECTORS.hangupButton);
      if (!hangupBtn && hasStarted) {
        onMeetingEnded();
        clearInterval(endCheck);
      }
    }, 5000);
  }

  function onMeetingEnded() {
    console.log("[MeetingTranscriber] Teams meeting ended.");
    if (captionObserver) {
      captionObserver.disconnect();
      captionObserver = null;
    }
    processedCaptionIds.clear();
    CaptionParser.endMeeting();
    hasStarted = false;
  }

  // Listen for messages from popup
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === "getTranscript") {
      sendResponse(CaptionParser.getTranscript());
      return true;
    }
  });

  init();
})();
