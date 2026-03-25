/**
 * Zoom Web Client speaker name extraction.
 */

(() => {
  const PLATFORM = "Zoom";
  const ZOOM_MEETING_URL = /^https:\/\/app\.zoom\.us\/wc\/\d+\/.+$/;
  let meetingDetectionInterval = null;
  let participantPollInterval = null;
  let activeSpeakerPollInterval = null;
  let endCheckInterval = null;
  let hasStarted = false;
  let missingSpeakerPolls = 0;

  const SELECTORS = {
    iframe: "#webclient",
    audioMenu: "#audioOptionMenu",
    leaveButton: ".footer__leave-btn-container",
    participantNames: [
      '[class*="participants-item__name"]',
      '[class*="participants-li__display-name"]',
      '[class*="video-avatar__avatar-name"]',
      '[class*="subtitle__speaker-name"]'
    ],
    activeSpeaker: [
      '[class*="active-speaker"] [class*="participants-item__name"]',
      '[class*="active-speaker"] [class*="video-avatar__avatar-name"]',
      '[class*="subtitle__speaker-name"]'
    ]
  };

  function init() {
    meetingDetectionInterval = setInterval(detectMeeting, 2000);
  }

  function getZoomDocument() {
    const iframe = document.querySelector(SELECTORS.iframe);
    if (!iframe) return document;

    try {
      return iframe.contentDocument || iframe.contentWindow?.document || null;
    } catch (error) {
      return null;
    }
  }

  function detectMeeting() {
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
    const title = document.title.replace("Zoom", "").replace("|", "").trim();
    SpeakerTracker.startMeeting(PLATFORM, title || "Zoom Meeting");

    SelectorValidator.validate(
      PLATFORM,
      {
        "Audio menu": SELECTORS.audioMenu,
        "Participant names": SELECTORS.participantNames,
        "Active speaker": SELECTORS.activeSpeaker
      },
      zoomDoc
    );

    participantPollInterval = setInterval(() => {
      SpeakerTracker.setParticipants(collectParticipantNames(zoomDoc));
    }, 5000);

    activeSpeakerPollInterval = setInterval(() => {
      const activeSpeaker = detectActiveSpeaker(zoomDoc);
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
      const currentDoc = getZoomDocument();
      if (!currentDoc || !ZOOM_MEETING_URL.test(window.location.href)) {
        onMeetingEnded();
        return;
      }

      const leaveButton = currentDoc.querySelector(SELECTORS.leaveButton);
      const audioMenu = currentDoc.querySelector(SELECTORS.audioMenu);
      if (!leaveButton && !audioMenu && hasStarted) {
        onMeetingEnded();
      }
    }, 3000);
  }

  function collectParticipantNames(zoomDoc) {
    const names = new Set();

    for (const selector of SELECTORS.participantNames) {
      zoomDoc.querySelectorAll(selector).forEach((element) => {
        const name = extractName(element);
        if (name) {
          names.add(name);
        }
      });
    }

    return [...names];
  }

  function detectActiveSpeaker(zoomDoc) {
    for (const selector of SELECTORS.activeSpeaker) {
      const element = zoomDoc.querySelector(selector);
      const name = extractName(element);
      if (name) return name;
    }
    return null;
  }

  function extractName(element) {
    if (!element) return null;

    const raw =
      element.getAttribute?.("aria-label") ||
      element.getAttribute?.("alt") ||
      element.textContent;

    if (!raw) return null;

    const cleaned = raw
      .replace(/\bis speaking\b/i, "")
      .replace(/\s+/g, " ")
      .replace(/:$/, "")
      .trim();

    if (!cleaned || cleaned.length > 80) return null;
    if (/leave|mute|unmute|captions|participants/i.test(cleaned)) return null;

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

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === "getMeetingSnapshot") {
      sendResponse(SpeakerTracker.getSnapshot());
      return true;
    }
  });

  init();
})();
