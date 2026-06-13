/**
 * Google Meet speaker name extraction.
 */

(() => {
  const PLATFORM = "Google Meet";
  let meetingDetectionInterval = null;
  let participantPollInterval = null;
  let activeSpeakerPollInterval = null;
  let endCheckInterval = null;
  let hasStarted = false;
  let missingSpeakerPolls = 0;
  let username = "";

  const SELECTORS = {
    callEndButton:
      'button[aria-label*="Leave"], button[aria-label*="leave"], [data-tooltip*="Leave"]',
    meetingTitle: "[data-meeting-title], .u6vdEc",
    username: ".awLEm",
    participantNames: [
      "[data-self-name]",
      "[data-participant-name]",
      "[data-requested-participant-name]",
      '[data-participant-id] span.notranslate',
      'button[aria-label^="More options for "]',
      '[aria-label*=" is speaking"]',
      'img[alt][data-iml]'
    ],
    activeSpeaker: [
      '[aria-label*=" is speaking"]',
      '[data-active-speaker="true"] [data-participant-name]',
      '[data-active-speaker="true"] [data-self-name]',
      '[data-active-speaker="true"] span.notranslate'
    ],
    captionsContainer: 'div[role="region"][tabindex="0"]',
    captionText: 'div[jsname="tgaKEf"], [data-message-text]'
  };

  function init() {
    const usernameEl = document.querySelector(SELECTORS.username);
    if (usernameEl) {
      username = usernameEl.textContent.trim();
    }

    if (!username) {
      const moreOpts = document.querySelector('button[aria-label^="More options for "]');
      if (moreOpts) {
        username = moreOpts.getAttribute("aria-label").replace(/^More options for /, "").trim();
      }
    }

    meetingDetectionInterval = setInterval(detectMeeting, 2000);
  }

  function detectMeeting() {
    const leaveButton = document.querySelector(SELECTORS.callEndButton);
    if (leaveButton && !hasStarted) {
      hasStarted = true;
      clearInterval(meetingDetectionInterval);
      onMeetingJoined();
    }
  }

  function onMeetingJoined() {
    const titleEl = document.querySelector(SELECTORS.meetingTitle);
    const title = titleEl
      ? titleEl.textContent.trim() || titleEl.getAttribute("data-meeting-title")
      : document.title;

    SpeakerTracker.startMeeting(PLATFORM, title);

    SelectorValidator.validate(PLATFORM, {
      "Leave button": SELECTORS.callEndButton,
      "Participant names": SELECTORS.participantNames,
      "Active speaker": {
        selectors: SELECTORS.activeSpeaker,
        optional: true
      },
      "Caption structure": {
        selectors: [SELECTORS.captionsContainer, SELECTORS.captionText],
        optional: true
      }
    });

    participantPollInterval = setInterval(() => {
      SpeakerTracker.setParticipants(collectParticipantNames());
    }, 5000);

    activeSpeakerPollInterval = setInterval(() => {
      const activeSpeaker = detectActiveSpeaker();
      if (activeSpeaker) {
        missingSpeakerPolls = 0;
        SpeakerTracker.setActiveSpeaker(activeSpeaker);
      } else {
        missingSpeakerPolls += 1;
        if (missingSpeakerPolls >= 3) {
          SpeakerTracker.clearActiveSpeaker();
        }
      }
    }, 1000);

    endCheckInterval = setInterval(() => {
      if (!document.querySelector(SELECTORS.callEndButton) && hasStarted) {
        onMeetingEnded();
      }
    }, 3000);
  }

  function collectParticipantNames() {
    const names = new Set();

    for (const selector of SELECTORS.participantNames) {
      const elements = document.querySelectorAll(selector);
      elements.forEach((element) => {
        const candidate = extractNameFromElement(element);
        if (candidate) {
          names.add(candidate);
        }
      });
    }

    const captionSpeaker = detectCaptionSpeaker();
    if (captionSpeaker) {
      names.add(captionSpeaker);
    }

    if (username) {
      names.add(username);
    }

    return [...names];
  }

  function detectActiveSpeaker() {
    for (const selector of SELECTORS.activeSpeaker) {
      const element = document.querySelector(selector);
      const name = extractNameFromElement(element);
      if (name) {
        return name === "You" && username ? username : name;
      }
    }

    // Fallback: find the tile with a speaking border highlight
    const tiles = document.querySelectorAll("[data-participant-id]");
    for (const tile of tiles) {
      const style = window.getComputedStyle(tile);
      const childDivs = tile.querySelectorAll("div");
      let hasSpeakingIndicator = false;
      for (const div of childDivs) {
        const cs = window.getComputedStyle(div);
        if (cs.borderColor && /rgb\(26, 115, 232\)|rgb\(66, 133, 244\)|#1a73e8|#4285f4/i.test(cs.borderColor)) {
          hasSpeakingIndicator = true;
          break;
        }
      }
      if (hasSpeakingIndicator) {
        const nameSpan = tile.querySelector("span.notranslate");
        const name = nameSpan?.textContent?.trim();
        if (name) return name === "You" && username ? username : name;
      }
    }

    return detectCaptionSpeaker();
  }

  function detectCaptionSpeaker() {
    const container = document.querySelector(SELECTORS.captionsContainer);
    if (!container) return null;

    const textElements = container.querySelectorAll(SELECTORS.captionText);
    const latest = textElements[textElements.length - 1];
    if (!latest) return null;

    const speaker = findSpeakerName(latest);
    if (speaker === "You" && username) {
      return username;
    }

    return speaker;
  }

  function findSpeakerName(textElement) {
    let parent = textElement?.parentElement;
    for (let depth = 0; depth < 5 && parent; depth += 1) {
      const previousSibling = parent.previousElementSibling;
      if (previousSibling) {
        const name = extractNameFromElement(previousSibling);
        if (name) return name;
      }

      const namedChild = parent.querySelector("[data-self-name], [data-participant-name], span.notranslate");
      const childName = extractNameFromElement(namedChild);
      if (childName) return childName;

      parent = parent.parentElement;
    }

    const nearbyImage = textElement?.closest("div")?.parentElement?.querySelector("img[alt]");
    return extractNameFromElement(nearbyImage);
  }

  function extractNameFromElement(element) {
    if (!element) return null;

    const raw =
      element.getAttribute?.("data-self-name") ||
      element.getAttribute?.("data-participant-name") ||
      element.getAttribute?.("aria-label") ||
      element.getAttribute?.("alt") ||
      element.textContent;

    if (!raw) return null;

    let cleaned = raw
      .replace(/^More options for /i, "")
      .replace(/\bis speaking\b/i, "")
      .replace(/\s+/g, " ")
      .replace(/:$/, "")
      .trim();

    if (!cleaned || cleaned.length > 80) return null;
    if (/leave|captions|present|meeting details|reframe|backgrounds|more_vert|visual_effects/i.test(cleaned)) return null;

    return cleaned;
  }

  function onMeetingEnded() {
    if (!hasStarted) return;

    clearInterval(participantPollInterval);
    clearInterval(activeSpeakerPollInterval);
    clearInterval(endCheckInterval);
    SpeakerTracker.endMeeting();
    hasStarted = false;
  }

  init();
})();
