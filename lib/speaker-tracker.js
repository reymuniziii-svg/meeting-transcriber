/**
 * Shared speaker activity tracker used by all platform content scripts.
 */

const SpeakerTracker = (() => {
  let activeSpeakerTimeline = [];
  let participants = [];
  let currentSpeaker = null;
  let currentStart = null;
  let meetingInfo = {
    platform: "",
    title: "",
    startTime: null,
  };
  let isMeetingActive = false;

  function startMeeting(platform, title = "") {
    activeSpeakerTimeline = [];
    participants = [];
    currentSpeaker = null;
    currentStart = null;
    meetingInfo = {
      platform,
      title: title || `${platform} Meeting`,
      startTime: new Date().toISOString(),
    };
    isMeetingActive = true;

    notifyBackground("meetingStarted", {
      platform,
      title: meetingInfo.title,
      startTime: meetingInfo.startTime,
    });
  }

  function setParticipants(names) {
    if (!isMeetingActive) return;

    const normalized = normalizeNames(names);
    if (normalized.join("|") === participants.join("|")) {
      return;
    }

    participants = normalized;
    notifyBackground("participants", { names: participants });
  }

  function setActiveSpeaker(name, timestamp = Date.now()) {
    if (!isMeetingActive) return;

    const normalized = normalizeName(name);
    if (!normalized) {
      clearActiveSpeaker(timestamp);
      return;
    }

    if (currentSpeaker === normalized) {
      return;
    }

    if (currentSpeaker && currentStart) {
      activeSpeakerTimeline.push({
        name: currentSpeaker,
        start: currentStart,
        end: timestamp,
      });
    }

    currentSpeaker = normalized;
    currentStart = timestamp;
    notifyBackground("activeSpeaker", {
      name: normalized,
      timestamp,
    });
  }

  function clearActiveSpeaker(timestamp = Date.now()) {
    if (!isMeetingActive || !currentSpeaker || !currentStart) {
      return;
    }

    activeSpeakerTimeline.push({
      name: currentSpeaker,
      start: currentStart,
      end: timestamp,
    });

    currentSpeaker = null;
    currentStart = null;
    notifyBackground("activeSpeakerCleared", { timestamp });
  }

  function endMeeting(timestamp = Date.now()) {
    if (!isMeetingActive) return;

    clearActiveSpeaker(timestamp);
    isMeetingActive = false;

    const endTime = new Date(timestamp).toISOString();
    const duration = meetingInfo.startTime
      ? Math.round((timestamp - new Date(meetingInfo.startTime).getTime()) / 60000)
      : 0;

    notifyBackground("meetingEnded", {
      meetingInfo: {
        ...meetingInfo,
        participants: [...participants],
        endTime,
        duration,
      },
      speakerTimeline: [...activeSpeakerTimeline],
    });
  }

  function getSnapshot() {
    const timeline = [...activeSpeakerTimeline];
    if (currentSpeaker && currentStart) {
      timeline.push({
        name: currentSpeaker,
        start: currentStart,
        end: Date.now(),
      });
    }

    return {
      isMeetingActive,
      meetingInfo: {
        ...meetingInfo,
        participants: [...participants],
      },
      speakerTimeline: timeline,
      currentSpeaker,
    };
  }

  function notifyBackground(type, data) {
    try {
      chrome.runtime.sendMessage({ type, ...data });
    } catch (error) {
      console.warn("[MeetingTranscriber] Could not notify background:", error);
    }
  }

  function normalizeNames(names) {
    return [...new Set((names || []).map(normalizeName).filter(Boolean))];
  }

  function normalizeName(name) {
    if (!name || typeof name !== "string") return null;

    const cleaned = name
      .replace(/\s+/g, " ")
      .replace(/:$/, "")
      .trim();

    if (!cleaned) return null;
    if (cleaned.length > 80) return null;

    const lower = cleaned.toLowerCase();
    const blocked = [
      "mute",
      "unmute",
      "leave",
      "caption",
      "present now",
      "meeting details",
      "speaker view",
      "gallery view",
      "more options",
      "you",
    ];

    if (blocked.includes(lower)) {
      return null;
    }

    return cleaned;
  }

  return {
    startMeeting,
    setParticipants,
    setActiveSpeaker,
    clearActiveSpeaker,
    endMeeting,
    getSnapshot,
  };
})();
