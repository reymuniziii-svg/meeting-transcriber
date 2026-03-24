/**
 * Google Meet caption scraper.
 *
 * DOM structure (as of early 2026):
 * - Captions container: div[role="region"][tabindex="0"]
 * - Each caption block contains:
 *   - Speaker name element (preceding sibling or child with person name)
 *   - Transcript text in div[jsname="tgaKEf"]
 * - Captions update in-place via characterData mutations
 *
 * References: TranscripTonic, Meet-Script
 */

(() => {
  const PLATFORM = "Google Meet";
  let observer = null;
  let meetingDetectionInterval = null;
  let captionDetectionInterval = null;
  let hasStarted = false;
  let username = "";

  // DOM selectors (use semantic attributes for resilience)
  const SELECTORS = {
    // Meeting active indicator: the "call_end" button
    callEndButton: 'button[aria-label*="Leave"], button[aria-label*="leave"], [data-tooltip*="Leave"]',
    // Captions container
    captionsContainer: 'div[role="region"][tabindex="0"]',
    // Captions toggle button
    captionsButton:
      'button[aria-label*="caption" i], button[aria-label*="subtitle" i], button[data-tooltip*="caption" i]',
    // Meeting title
    meetingTitle: "[data-meeting-title], .u6vdEc",
    // Username (pre-join screen)
    username: ".awLEm",
  };

  /**
   * Start polling for meeting detection
   */
  function init() {
    console.log("[MeetingTranscriber] Google Meet content script loaded.");

    // Try to capture username from pre-join screen
    const usernameEl = document.querySelector(SELECTORS.username);
    if (usernameEl) {
      username = usernameEl.textContent.trim();
    }

    // Poll for meeting start
    meetingDetectionInterval = setInterval(detectMeeting, 2000);
  }

  /**
   * Detect when user has joined a meeting
   */
  function detectMeeting() {
    const leaveButton = document.querySelector(SELECTORS.callEndButton);
    if (leaveButton && !hasStarted) {
      hasStarted = true;
      clearInterval(meetingDetectionInterval);
      onMeetingJoined();
    }
  }

  /**
   * Called when meeting is detected
   */
  function onMeetingJoined() {
    const titleEl = document.querySelector(SELECTORS.meetingTitle);
    const title = titleEl
      ? titleEl.textContent.trim() || titleEl.getAttribute("data-meeting-title")
      : "";

    CaptionParser.startMeeting(PLATFORM, title || document.title);

    // Validate selectors are still working
    SelectorValidator.validate(PLATFORM, {
      "Leave/End button": SELECTORS.callEndButton,
      "Captions container": SELECTORS.captionsContainer,
      "Captions toggle": SELECTORS.captionsButton,
    });

    // Try to auto-enable captions
    autoEnableCaptions();

    // Start polling for captions container
    captionDetectionInterval = setInterval(detectCaptions, 1000);

    // Watch for meeting end
    watchForMeetingEnd();
  }

  /**
   * Try to enable captions automatically
   */
  function autoEnableCaptions() {
    setTimeout(() => {
      const ccBtn = document.querySelector(SELECTORS.captionsButton);
      if (ccBtn) {
        // Check if captions are already on by looking at aria-pressed or similar
        const isOn =
          ccBtn.getAttribute("aria-pressed") === "true" ||
          ccBtn.getAttribute("data-is-toggled") === "true";
        if (!isOn) {
          console.log("[MeetingTranscriber] Auto-enabling captions...");
          ccBtn.click();
        }
      }
    }, 3000); // Wait for UI to settle
  }

  /**
   * Detect when captions container appears in DOM
   */
  function detectCaptions() {
    const container = document.querySelector(SELECTORS.captionsContainer);
    if (container) {
      clearInterval(captionDetectionInterval);
      startObserving(container);
    }
  }

  /**
   * Attach MutationObserver to captions container
   */
  function startObserving(container) {
    console.log("[MeetingTranscriber] Observing captions container.");

    observer = new MutationObserver((mutations) => {
      processCaptionMutations(container);
    });

    observer.observe(container, {
      childList: true,
      subtree: true,
      characterData: true,
    });

    // Process any existing captions
    processCaptionMutations(container);
  }

  /**
   * Extract speaker name and text from the captions container.
   *
   * Google Meet caption structure (observed):
   * The container has child blocks, each with:
   * - A name element (often with class containing person info or an img + name)
   * - A text element with jsname="tgaKEf" or similar
   *
   * Captions update in-place: the text of the active block changes as words are recognized.
   * When a new person speaks, a new block is added.
   * Meet keeps only the last few blocks visible.
   */
  function processCaptionMutations(container) {
    // Get all caption blocks (direct children or nested structures)
    const blocks = container.querySelectorAll(
      'div[jsname="tgaKEf"], [data-message-text]'
    );

    if (blocks.length === 0) {
      // Fallback: try to find text nodes in the container
      processContainerFallback(container);
      return;
    }

    blocks.forEach((textEl) => {
      const text = textEl.textContent.trim();
      if (!text) return;

      // Find speaker name - walk up to find sibling/parent with name
      let speaker = findSpeakerName(textEl);

      // Replace "You" with actual username
      if (speaker === "You" && username) {
        speaker = username;
      }

      if (speaker && text) {
        CaptionParser.processCaption(speaker, text, textEl);
      }
    });
  }

  /**
   * Fallback: parse container when specific selectors don't match.
   * Walks the container children looking for name + text patterns.
   */
  function processContainerFallback(container) {
    const children = container.children;
    if (children.length === 0) return;

    // Iterate through visible caption blocks
    for (let i = 0; i < children.length; i++) {
      const block = children[i];
      const allText = block.innerText || block.textContent || "";
      if (!allText.trim()) continue;

      // Try to split into speaker + text
      // Common pattern: first line or element is speaker name, rest is text
      const lines = allText.split("\n").filter((l) => l.trim());
      if (lines.length >= 2) {
        const speaker = lines[0].trim();
        const text = lines.slice(1).join(" ").trim();
        if (speaker && text) {
          CaptionParser.processCaption(
            speaker === "You" && username ? username : speaker,
            text,
            block
          );
        }
      } else if (lines.length === 1) {
        // Single line - try to find speaker from previous blocks
        const text = lines[0].trim();
        CaptionParser.processCaption("Unknown Speaker", text, block);
      }
    }
  }

  /**
   * Walk up the DOM tree from a text element to find the speaker name.
   */
  function findSpeakerName(textEl) {
    // Strategy 1: Look for a sibling or parent-sibling with name content
    let parent = textEl.parentElement;
    for (let depth = 0; depth < 5 && parent; depth++) {
      // Check previous sibling
      const prev = parent.previousElementSibling;
      if (prev) {
        const nameText = prev.textContent.trim();
        // Speaker names are typically short (under 50 chars) and don't contain newlines
        if (nameText && nameText.length < 50 && !nameText.includes("\n")) {
          return nameText;
        }
      }

      // Check for child elements that look like name containers
      const nameEl = parent.querySelector(
        '[data-sender-name], [data-participant-id]'
      );
      if (nameEl) {
        return nameEl.textContent.trim();
      }

      parent = parent.parentElement;
    }

    // Strategy 2: Look for img alt text (avatar) near the text
    const nearbyImg = textEl
      .closest("div")
      ?.parentElement?.querySelector("img");
    if (nearbyImg && nearbyImg.alt) {
      return nearbyImg.alt.trim();
    }

    return null;
  }

  /**
   * Watch for the user leaving the meeting
   */
  function watchForMeetingEnd() {
    const endObserver = new MutationObserver(() => {
      const leaveButton = document.querySelector(SELECTORS.callEndButton);
      if (!leaveButton && hasStarted) {
        // Meeting ended
        onMeetingEnded();
        endObserver.disconnect();
      }
    });

    endObserver.observe(document.body, {
      childList: true,
      subtree: true,
    });

    // Also check periodically as backup
    const endCheck = setInterval(() => {
      const leaveButton = document.querySelector(SELECTORS.callEndButton);
      if (!leaveButton && hasStarted) {
        onMeetingEnded();
        clearInterval(endCheck);
      }
    }, 5000);
  }

  /**
   * Handle meeting end
   */
  function onMeetingEnded() {
    console.log("[MeetingTranscriber] Meeting ended.");
    if (observer) {
      observer.disconnect();
      observer = null;
    }
    CaptionParser.endMeeting();
    hasStarted = false;
  }

  // Listen for messages from popup
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === "getTranscript") {
      const data = CaptionParser.getTranscript();
      sendResponse(data);
      return true;
    }
  });

  // Start
  init();
})();
