/**
 * Zoom Web Client caption scraper.
 *
 * Key challenge: Zoom web runs inside an iframe (#webclient).
 * All DOM queries must go through iframe.contentDocument.
 *
 * DOM structure (as of early 2026):
 * - Iframe: #webclient
 * - Captions container: .live-transcription-subtitle__box (inside iframe)
 * - Each caption block has speaker avatar/name + text
 * - Captions both append AND truncate from the beginning as text grows
 *
 * References: TranscripTonic Zoom scraper
 */

(() => {
  const PLATFORM = "Zoom";
  let captionObserver = null;
  let meetingDetectionInterval = null;
  let captionDetectionInterval = null;
  let hasStarted = false;
  let lastCaptionTexts = new Map(); // elementRef -> last text

  const SELECTORS = {
    // Zoom web client iframe
    iframe: "#webclient",
    // Meeting active indicator (inside iframe)
    audioMenu: "#audioOptionMenu",
    leaveButton: ".footer__leave-btn-container",
    // Captions container (inside iframe)
    captionsContainer: ".live-transcription-subtitle__box",
    // Individual caption items
    captionItem:
      ".live-transcription-subtitle__item, [class*='subtitle__item']",
  };

  // URL pattern for active Zoom meeting
  const ZOOM_MEETING_URL = /^https:\/\/app\.zoom\.us\/wc\/\d+\/.+$/;

  function init() {
    console.log("[MeetingTranscriber] Zoom web content script loaded.");
    meetingDetectionInterval = setInterval(detectMeeting, 2000);
  }

  /**
   * Get the iframe's document, or fall back to main document.
   */
  function getZoomDocument() {
    const iframe = document.querySelector(SELECTORS.iframe);
    if (iframe) {
      try {
        return iframe.contentDocument || iframe.contentWindow?.document;
      } catch (e) {
        // Cross-origin iframe - can't access
        return null;
      }
    }
    // No iframe - Zoom might render directly in the page
    return document;
  }

  function detectMeeting() {
    // Check URL pattern first
    if (!ZOOM_MEETING_URL.test(window.location.href)) return;

    const zoomDoc = getZoomDocument();
    if (!zoomDoc) return;

    const audioMenu = zoomDoc.querySelector(SELECTORS.audioMenu);
    if (audioMenu && !hasStarted) {
      hasStarted = true;
      clearInterval(meetingDetectionInterval);
      onMeetingJoined(zoomDoc);
    }
  }

  function onMeetingJoined(zoomDoc) {
    // Try to get meeting title from page title
    const title = document.title.replace("Zoom", "").replace("|", "").trim();
    CaptionParser.startMeeting(PLATFORM, title || "Zoom Meeting");

    captionDetectionInterval = setInterval(() => detectCaptions(zoomDoc), 1000);
    watchForMeetingEnd(zoomDoc);
  }

  function detectCaptions(zoomDoc) {
    const container = zoomDoc.querySelector(SELECTORS.captionsContainer);
    if (container) {
      clearInterval(captionDetectionInterval);
      startObserving(container, zoomDoc);
    }
  }

  function startObserving(container, zoomDoc) {
    console.log("[MeetingTranscriber] Observing Zoom captions.");

    captionObserver = new MutationObserver(() => {
      processCaptions(container, zoomDoc);
    });

    captionObserver.observe(container, {
      childList: true,
      subtree: true,
      characterData: true,
    });

    processCaptions(container, zoomDoc);
  }

  /**
   * Process Zoom caption elements.
   *
   * Zoom caption structure varies, but generally:
   * - Each subtitle item has an avatar (img) or name element + text span
   * - Text both appends new words AND truncates old ones from the beginning
   */
  function processCaptions(container, zoomDoc) {
    const items = container.querySelectorAll(SELECTORS.captionItem);

    items.forEach((item, index) => {
      const { speaker, text } = extractSpeakerAndText(item, zoomDoc);
      if (!speaker || !text) return;

      const elementKey = `zoom_item_${index}`;

      // Zoom truncates the beginning of long captions, so we need to detect
      // both appended text and truncated+new text
      const lastText = lastCaptionTexts.get(elementKey);
      if (lastText === text) return;

      // Find new content
      let newText = text;
      if (lastText) {
        const newPart = findNewPart(lastText, text);
        if (newPart) {
          newText = text; // Send full current text - parser handles dedup
        }
      }

      lastCaptionTexts.set(elementKey, text);
      CaptionParser.processCaption(speaker, newText, elementKey);
    });
  }

  /**
   * Extract speaker name and text from a caption item element.
   */
  function extractSpeakerAndText(item, zoomDoc) {
    let speaker = null;
    let text = null;

    // Try to find speaker from specific elements
    const children = item.children;
    if (children.length === 0) {
      return { speaker: null, text: null };
    }

    // Check first child - could be img (avatar) or text (name)
    const firstChild = children[0];

    if (firstChild.tagName === "IMG") {
      // Avatar image - try to match against participant list
      speaker = findSpeakerByAvatar(firstChild, zoomDoc);
    } else if (firstChild.textContent) {
      const nameCandidate = firstChild.textContent.trim();
      // Speaker names end with ":" in some Zoom versions
      if (nameCandidate.length < 50) {
        speaker = nameCandidate.replace(/:$/, "").trim();
      }
    }

    // Get text from remaining children
    const textParts = [];
    for (let i = 1; i < children.length; i++) {
      const t = children[i].textContent.trim();
      if (t) textParts.push(t);
    }
    text = textParts.join(" ");

    // Fallback: parse innerText
    if (!text) {
      const fullText = item.innerText.trim();
      const lines = fullText.split("\n").filter((l) => l.trim());
      if (lines.length >= 2 && !speaker) {
        speaker = lines[0].replace(/:$/, "").trim();
        text = lines.slice(1).join(" ").trim();
      } else if (lines.length === 1) {
        text = lines[0].trim();
      }
    }

    if (!speaker) speaker = "Unknown Speaker";

    return { speaker, text };
  }

  /**
   * Try to identify speaker by matching avatar image against participant list.
   * Zoom shows participant avatars - if we can match the src, we can find the name.
   */
  function findSpeakerByAvatar(imgEl, zoomDoc) {
    const src = imgEl.getAttribute("src");
    if (!src) return imgEl.alt || null;

    // Check alt text first
    if (imgEl.alt && imgEl.alt.trim()) {
      return imgEl.alt.trim();
    }

    // Try to find matching images elsewhere in the page with names
    const allImgs = zoomDoc.querySelectorAll("img");
    for (const img of allImgs) {
      if (img === imgEl) continue;
      if (img.src === src && img.alt) {
        return img.alt.trim();
      }
    }

    // Check cached mappings
    const cached = localStorage.getItem(`zoom_avatar_${src}`);
    if (cached) return cached;

    return null;
  }

  /**
   * Find the new part of text when Zoom updates captions.
   * Handles both appending and truncation from the beginning.
   */
  function findNewPart(oldText, newText) {
    // Simple append
    if (newText.startsWith(oldText)) {
      return newText.substring(oldText.length).trim();
    }

    // Zoom truncated the beginning - find overlap
    for (let i = 1; i < oldText.length; i++) {
      const suffix = oldText.substring(i);
      if (newText.startsWith(suffix)) {
        return newText.substring(suffix.length).trim();
      }
    }

    // No overlap - entirely new text
    return newText;
  }

  function watchForMeetingEnd(zoomDoc) {
    const endCheck = setInterval(() => {
      // Check if we're still on a meeting URL
      if (!ZOOM_MEETING_URL.test(window.location.href)) {
        onMeetingEnded();
        clearInterval(endCheck);
        return;
      }

      // Check if leave button is gone (meeting ended)
      const leaveBtn = zoomDoc.querySelector(SELECTORS.leaveButton);
      const audioMenu = zoomDoc.querySelector(SELECTORS.audioMenu);
      if (!leaveBtn && !audioMenu && hasStarted) {
        onMeetingEnded();
        clearInterval(endCheck);
      }
    }, 5000);
  }

  function onMeetingEnded() {
    console.log("[MeetingTranscriber] Zoom meeting ended.");
    if (captionObserver) {
      captionObserver.disconnect();
      captionObserver = null;
    }
    lastCaptionTexts.clear();
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
