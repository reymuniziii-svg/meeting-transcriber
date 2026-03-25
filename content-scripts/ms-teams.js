/**
 * Microsoft Teams speaker name extraction.
 */

(() => {
  const PLATFORM = "Microsoft Teams";
  let meetingDetectionInterval = null;
  let participantPollInterval = null;
  let activeSpeakerPollInterval = null;
  let endCheckInterval = null;
  let hasStarted = false;
  let missingSpeakerPolls = 0;

  const SELECTORS = {
    hangupButton:
      'button[data-tid="hangup-main-btn"], button[data-tid="hangup-leave-button"], #hangup-button',
    meetingTitle: '[data-tid="meeting-title"], [data-tid="call-title"]',
    participantNames: [
      '[data-tid="display-name"]',
      '[data-tid="participant-name"]',
      '[data-tid="author"]',
      '[aria-label*=" is talking" i]'
    ],
    activeSpeaker: [
      '[aria-label*=" is talking" i]',
      '[data-tid*="speaking"] [data-tid="display-name"]',
      '[data-tid*="speaker"] [data-tid="display-name"]',
      '[data-tid="author"]'
    ]
  };

  function init() {
    meetingDetectionInterval = setInterval(detectMeeting, 2000);
  }

  function detectMeeting() {
    const hangupButton = document.querySelector(SELECTORS.hangupButton);
    if (hangupButton && !hasStarted) {
      hasStarted = true;
      clearInterval(meetingDetectionInterval);
      onMeetingJoined();
    }
  }

  function onMeetingJoined() {
    const titleEl = document.querySelector(SELECTORS.meetingTitle);
    const title = titleEl ? titleEl.textContent.trim() : document.title;

    SpeakerTracker.startMeeting(PLATFORM, title);

    SelectorValidator.validate(PLATFORM, {
      "Hangup button": SELECTORS.hangupButton,
      "Participant names": SELECTORS.participantNames,
      "Active speaker": SELECTORS.activeSpeaker
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
      if (!document.querySelector(SELECTORS.hangupButton) && hasStarted) {
        onMeetingEnded();
      }
    }, 3000);
  }

  function collectParticipantNames() {
    const names = new Set();
    for (const selector of SELECTORS.participantNames) {
      document.querySelectorAll(selector).forEach((element) => {
        const name = extractName(element);
        if (name) {
          names.add(name);
        }
      });
    }
    return [...names];
  }

  function detectActiveSpeaker() {
    for (const selector of SELECTORS.activeSpeaker) {
      const element = document.querySelector(selector);
      const name = extractName(element);
      if (name) return name;
    }
    return null;
  }

  function extractName(element) {
    if (!element) return null;

    const raw =
      element.getAttribute?.("data-participant-name") ||
      element.getAttribute?.("aria-label") ||
      element.textContent;

    if (!raw) return null;

    const cleaned = raw
      .replace(/\bis talking\b/i, "")
      .replace(/\bmuted\b/i, "")
      .replace(/\s+/g, " ")
      .replace(/:$/, "")
      .trim();

    if (!cleaned || cleaned.length > 80) return null;
    if (/hang up|leave|captions|roster/i.test(cleaned)) return null;

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
