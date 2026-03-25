/**
 * Background service worker.
 * Coordinates live audio capture, Whisper results, speaker timelines, and downloads.
 */

importScripts("lib/markdown-formatter.js");

const OFFSCREEN_DOCUMENT_PATH = "offscreen.html";
const OFFSCREEN_DOCUMENT_URL = chrome.runtime.getURL(OFFSCREEN_DOCUMENT_PATH);
const activeMeetings = new Map();

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const tabId = sender.tab?.id ?? message.tabId;

  (async () => {
    switch (message.type) {
      case "meetingStarted":
        await handleMeetingStarted(tabId, message);
        sendResponse({ ok: true });
        return;

      case "meetingEnded":
        await handleMeetingEnded(tabId, message);
        sendResponse({ ok: true });
        return;

      case "participants":
        await handleParticipants(tabId, message.names || []);
        sendResponse({ ok: true });
        return;

      case "activeSpeaker":
        await handleActiveSpeaker(tabId, message);
        sendResponse({ ok: true });
        return;

      case "activeSpeakerCleared":
        await handleActiveSpeakerCleared(tabId, message.timestamp);
        sendResponse({ ok: true });
        return;

      case "selectorWarning":
        await handleSelectorWarning(tabId, message);
        sendResponse({ ok: true });
        return;

      case "getStatus":
        sendResponse(await getStatus(tabId));
        return;

      case "beginCapture":
        sendResponse(await startCaptureForMeeting(message.tabId, true));
        return;

      case "downloadCurrentTranscript":
        sendResponse(await handleManualDownload(message.tabId));
        return;

      case "downloadTranscript":
        sendResponse(await handleDirectDownload(message.transcript, message.meetingInfo));
        return;

      case "offscreenCaptureStarted":
        await handleOffscreenCaptureStarted(message);
        sendResponse({ ok: true });
        return;

      case "offscreenCaptureStopped":
        await handleOffscreenCaptureStopped(message);
        sendResponse({ ok: true });
        return;

      case "offscreenServerStatus":
        await handleOffscreenServerStatus(message);
        sendResponse({ ok: true });
        return;

      case "offscreenTranscription":
        await handleOffscreenTranscription(message);
        sendResponse({ ok: true });
        return;

      case "offscreenDiarization":
        await handleOffscreenDiarization(message);
        sendResponse({ ok: true });
        return;

      case "offscreenError":
        await handleOffscreenError(message);
        sendResponse({ ok: true });
        return;
    }

    sendResponse({ ok: false, error: `Unsupported message type: ${message.type}` });
  })().catch((error) => {
    console.error("[MeetingTranscriber] Background error:", error);
    sendResponse({ ok: false, error: error.message || String(error) });
  });

  return true;
});

async function handleMeetingStarted(tabId, message) {
  if (!tabId) return;

  const existing = activeMeetings.get(tabId) || createMeetingState(tabId, message);
  existing.platform = message.platform || existing.platform;
  existing.title = message.title || existing.title;
  existing.startTime = message.startTime || existing.startTime;
  existing.startEpochMs = existing.startEpochMs || Date.now();
  existing.endTime = null;
  existing.endEpochMs = null;
  existing.pendingFinalization = false;
  activeMeetings.set(tabId, existing);

  updateBadge(tabId, existing.transcriptionSegments.length);
  await persistMeetingState(existing);

  const startResult = await startCaptureForMeeting(tabId, false);
  if (!startResult.ok && startResult.error) {
    console.warn("[MeetingTranscriber] Capture not started yet:", startResult.error);
  }
}

async function handleMeetingEnded(tabId, message) {
  const meeting = getMeeting(tabId);
  if (!meeting) return;

  meeting.endTime = message.meetingInfo?.endTime || new Date().toISOString();
  meeting.endEpochMs = new Date(meeting.endTime).getTime();
  meeting.pendingFinalization = true;

  if (Array.isArray(message.speakerTimeline) && message.speakerTimeline.length > 0) {
    for (const segment of message.speakerTimeline) {
      meeting.completedSpeakerTimeline.push(segment);
    }
  }

  await persistMeetingState(meeting);

  if (meeting.captureStatus === "capturing" || meeting.captureStatus === "starting") {
    await stopCaptureForMeeting(meeting);
    setTimeout(() => {
      finalizeMeetingIfReady(tabId).catch((error) => {
        console.error("[MeetingTranscriber] Deferred finalize failed:", error);
      });
    }, 1500);
    return;
  }

  await finalizeMeetingIfReady(tabId);
}

async function handleParticipants(tabId, names) {
  const meeting = getMeeting(tabId);
  if (!meeting) return;

  meeting.participants = mergeUniqueNames(meeting.participants, names);
  await persistMeetingState(meeting);
}

async function handleActiveSpeaker(tabId, message) {
  const meeting = getMeeting(tabId);
  if (!meeting || !message.name || !message.timestamp) return;

  const lastEvent = meeting.speakerEvents[meeting.speakerEvents.length - 1];
  if (lastEvent && lastEvent.name === message.name) {
    return;
  }

  meeting.speakerEvents.push({
    name: message.name,
    timestamp: message.timestamp,
  });

  meeting.participants = mergeUniqueNames(meeting.participants, [message.name]);
  await persistMeetingState(meeting);
}

async function handleActiveSpeakerCleared(tabId, timestamp) {
  const meeting = getMeeting(tabId);
  if (!meeting || !timestamp) return;

  const lastEvent = meeting.speakerEvents[meeting.speakerEvents.length - 1];
  if (lastEvent && lastEvent.name === null) {
    return;
  }

  meeting.speakerEvents.push({
    name: null,
    timestamp,
  });

  await persistMeetingState(meeting);
}

async function handleSelectorWarning(tabId, message) {
  if (tabId) {
    chrome.action.setBadgeText({ text: "!", tabId });
    chrome.action.setBadgeBackgroundColor({ color: "#f6ad55", tabId });
  }

  await chrome.storage.session.set({
    selectorWarning: {
      platform: message.platform,
      failures: message.failures,
      details: message.details,
      timestamp: Date.now(),
    },
  });
}

async function getStatus(tabId) {
  const meeting = tabId ? activeMeetings.get(tabId) : activeMeetings.values().next().value;
  if (!meeting) {
    return { meeting: null, activeMeetings: [] };
  }

  return {
    meeting: summarizeMeeting(meeting),
    activeMeetings: [...activeMeetings.values()].map(summarizeMeeting),
  };
}

async function startCaptureForMeeting(tabId, userInitiated) {
  const meeting = getMeeting(tabId);
  if (!meeting) {
    return { ok: false, error: "No active meeting found for this tab." };
  }

  if (meeting.captureStatus === "capturing" || meeting.captureStatus === "starting") {
    return { ok: true, status: meeting.captureStatus };
  }

  const otherMeeting = [...activeMeetings.values()].find(
    (candidate) =>
      candidate.tabId !== tabId &&
      (candidate.captureStatus === "capturing" || candidate.captureStatus === "starting")
  );
  if (otherMeeting) {
    return {
      ok: false,
      error: "Only one live audio capture session is supported at a time.",
    };
  }

  try {
    await ensureOffscreenDocument();

    meeting.captureStatus = "starting";
    meeting.captureError = null;
    await persistMeetingState(meeting);

    const streamId = await chrome.tabCapture.getMediaStreamId({
      targetTabId: tabId,
    });

    await chrome.runtime.sendMessage({
      type: "startCapture",
      tabId,
      sessionId: `tab-${tabId}`,
      streamId,
      wsUrl: "ws://127.0.0.1:9090",
      title: meeting.title,
      platform: meeting.platform,
      prompt: "",
      vocab: meeting.participants.join(", "),
    });

    return { ok: true, status: "starting" };
  } catch (error) {
    const message = error?.message || String(error);
    const lowered = message.toLowerCase();

    if (!userInitiated && lowered.includes("user gesture")) {
      meeting.captureStatus = "awaiting_user_gesture";
      meeting.captureError = "Open the extension popup and click Connect Audio.";
    } else if (lowered.includes("user gesture")) {
      meeting.captureStatus = "awaiting_user_gesture";
      meeting.captureError = message;
    } else {
      meeting.captureStatus = "error";
      meeting.captureError = message;
    }

    await persistMeetingState(meeting);
    return { ok: false, error: meeting.captureError };
  }
}

async function stopCaptureForMeeting(meeting) {
  try {
    await chrome.runtime.sendMessage({
      type: "stopCapture",
      tabId: meeting.tabId,
      sessionId: meeting.sessionId,
    });
  } catch (error) {
    console.warn("[MeetingTranscriber] Could not stop offscreen capture:", error);
  }
}

async function handleManualDownload(tabId) {
  const meeting = getMeeting(tabId);
  if (!meeting) {
    return { ok: false, error: "No active meeting found." };
  }

  const transcript = buildMergedTranscript(meeting);
  if (transcript.length === 0) {
    return { ok: false, error: "No transcript segments available yet." };
  }

  const meetingInfo = buildMeetingInfo(meeting, transcript);
  const markdown = formatTranscriptAsMarkdown(transcript, meetingInfo);
  saveMarkdownFile(markdown, generateFilename(meetingInfo));
  return { ok: true };
}

async function handleDirectDownload(transcript, meetingInfo) {
  if (!Array.isArray(transcript) || transcript.length === 0) {
    return { ok: false, error: "No transcript provided." };
  }

  const markdown = formatTranscriptAsMarkdown(transcript, meetingInfo);
  saveMarkdownFile(markdown, generateFilename(meetingInfo));
  return { ok: true };
}

async function handleOffscreenCaptureStarted(message) {
  const meeting = getMeeting(message.tabId);
  if (!meeting) return;

  meeting.captureStatus = "capturing";
  meeting.serverStatus = "connected";
  meeting.audioStartEpochMs = message.startedAt || Date.now();
  meeting.sessionId = message.sessionId || meeting.sessionId;
  await persistMeetingState(meeting);
}

async function handleOffscreenCaptureStopped(message) {
  const meeting = getMeeting(message.tabId);
  if (!meeting) return;

  meeting.captureStatus = "stopped";
  await persistMeetingState(meeting);

  if (meeting.pendingFinalization) {
    await finalizeMeetingIfReady(meeting.tabId);
  }

  await closeOffscreenDocumentIfIdle();
}

async function handleOffscreenServerStatus(message) {
  const meeting = getMeeting(message.tabId);
  if (!meeting) return;

  meeting.serverStatus = message.status || "unknown";
  if (message.status === "disconnected" && meeting.captureStatus === "starting") {
    meeting.captureStatus = "error";
    meeting.captureError = "Whisper server is not running on ws://127.0.0.1:9090.";
  }
  await persistMeetingState(meeting);
}

async function handleOffscreenTranscription(message) {
  const meeting = getMeeting(message.tabId);
  if (!meeting || !Array.isArray(message.segments)) return;

  for (const segment of message.segments) {
    if (!segment.text) continue;
    meeting.transcriptionSegments.push({
      start: Number(segment.start),
      end: Number(segment.end),
      text: segment.text.trim(),
    });
  }

  meeting.transcriptionSegments.sort((a, b) => a.start - b.start);
  updateBadge(meeting.tabId, meeting.transcriptionSegments.length);
  await persistMeetingState(meeting);
}

async function handleOffscreenDiarization(message) {
  const meeting = getMeeting(message.tabId);
  if (!meeting || !Array.isArray(message.speakers)) return;

  meeting.diarizationSegments = message.speakers
    .map((speaker) => ({
      start: Number(speaker.start),
      end: Number(speaker.end),
      speaker_id: speaker.speaker_id,
      label: speaker.label || speaker.speaker_id,
    }))
    .sort((a, b) => a.start - b.start);

  await persistMeetingState(meeting);
}

async function handleOffscreenError(message) {
  const meeting = getMeeting(message.tabId);
  if (!meeting) return;

  meeting.captureStatus = "error";
  meeting.serverStatus = "disconnected";
  meeting.captureError = message.error || "Unknown offscreen capture error.";
  await persistMeetingState(meeting);
}

async function finalizeMeetingIfReady(tabId) {
  const meeting = getMeeting(tabId);
  if (!meeting) return;

  const transcript = buildMergedTranscript(meeting);
  const meetingInfo = buildMeetingInfo(meeting, transcript);

  activeMeetings.delete(tabId);
  clearBadge(tabId);

  if (transcript.length === 0) {
    await chrome.storage.local.remove("currentMeeting");
    return;
  }

  const reviewData = {
    transcript,
    meetingInfo,
    savedAt: new Date().toISOString(),
  };
  await chrome.storage.local.set({ lastTranscript: reviewData });

  const markdown = formatTranscriptAsMarkdown(transcript, meetingInfo);
  saveMarkdownFile(markdown, generateFilename(meetingInfo));

  await chrome.storage.local.remove("currentMeeting");

  chrome.tabs.create({
    url: chrome.runtime.getURL("review.html"),
    active: true,
  });
}

function buildMergedTranscript(meeting) {
  if (!meeting.audioStartEpochMs || meeting.transcriptionSegments.length === 0) {
    return [];
  }

  const domTimeline = buildDomTimeline(
    meeting,
    meeting.endEpochMs || Date.now()
  );
  const speakerMap = matchSpeakerIdsToRealNames(
    meeting.diarizationSegments,
    domTimeline
  );

  const transcript = [];
  for (const segment of meeting.transcriptionSegments) {
    const diarizationMatch = findBestOverlap(segment, meeting.diarizationSegments, "speaker_id");
    const domMatch = findBestOverlap(segment, domTimeline, "name");

    let speaker = domMatch?.value || null;
    let confidence = domMatch?.score || 0;

    if (diarizationMatch) {
      const mappedName =
        speakerMap.get(diarizationMatch.value) ||
        diarizationMatch.meta?.label ||
        diarizationMatch.value;
      if (!speaker || diarizationMatch.score >= confidence) {
        speaker = mappedName;
        confidence = diarizationMatch.score;
      }
    }

    transcript.push({
      speaker: speaker || "Unknown Speaker",
      text: segment.text,
      timestamp: new Date(
        meeting.audioStartEpochMs + segment.start * 1000
      ).toISOString(),
      start: segment.start,
      end: segment.end,
      confidence: Number(confidence.toFixed(2)),
    });
  }

  return consolidateTranscript(transcript);
}

function buildDomTimeline(meeting, endEpochMs) {
  const rawEvents = [...meeting.speakerEvents]
    .map((event) => ({
      name: event.name,
      timestamp: Number(event.timestamp),
    }))
    .filter((event) => Number.isFinite(event.timestamp))
    .sort((a, b) => a.timestamp - b.timestamp);

  const timeline = [];
  let previous = null;

  for (const event of rawEvents) {
    if (previous && previous.name === event.name) {
      continue;
    }

    if (previous && previous.name) {
      const start = Math.max(
        0,
        (previous.timestamp - meeting.audioStartEpochMs) / 1000
      );
      const end = Math.max(start, (event.timestamp - meeting.audioStartEpochMs) / 1000);
      timeline.push({
        name: previous.name,
        start,
        end,
      });
    }

    previous = { ...event };
  }

  if (previous && previous.name) {
    const start = Math.max(0, (previous.timestamp - meeting.audioStartEpochMs) / 1000);
    const end = Math.max(start, (endEpochMs - meeting.audioStartEpochMs) / 1000);
    timeline.push({
      name: previous.name,
      start,
      end,
    });
  }

  return timeline;
}

function matchSpeakerIdsToRealNames(diarizationSegments, domTimeline) {
  const overlapBySpeaker = new Map();

  for (const diarization of diarizationSegments || []) {
    for (const dom of domTimeline || []) {
      const overlap = getOverlapSeconds(diarization, dom);
      if (overlap <= 0) continue;

      const existing = overlapBySpeaker.get(diarization.speaker_id) || new Map();
      existing.set(dom.name, (existing.get(dom.name) || 0) + overlap);
      overlapBySpeaker.set(diarization.speaker_id, existing);
    }
  }

  const resolved = new Map();
  for (const [speakerId, nameScores] of overlapBySpeaker.entries()) {
    let bestName = null;
    let bestScore = 0;

    for (const [name, score] of nameScores.entries()) {
      if (score > bestScore) {
        bestName = name;
        bestScore = score;
      }
    }

    if (bestName) {
      resolved.set(speakerId, bestName);
    }
  }

  return resolved;
}

function findBestOverlap(segment, candidates, valueKey) {
  if (!Array.isArray(candidates) || candidates.length === 0) {
    return null;
  }

  let best = null;
  const duration = Math.max(segment.end - segment.start, 0.1);

  for (const candidate of candidates) {
    const overlap = getOverlapSeconds(segment, candidate);
    if (overlap <= 0) continue;

    const score = overlap / duration;
    if (!best || score > best.score) {
      best = {
        value: candidate[valueKey],
        score,
        meta: candidate,
      };
    }
  }

  return best;
}

function getOverlapSeconds(a, b) {
  return Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));
}

function consolidateTranscript(transcript) {
  const consolidated = [];

  for (const segment of transcript) {
    const previous = consolidated[consolidated.length - 1];
    if (
      previous &&
      previous.speaker === segment.speaker &&
      segment.start - previous.end <= 1.5
    ) {
      previous.text = `${previous.text} ${segment.text}`.trim();
      previous.end = segment.end;
      previous.confidence = Number(
        ((previous.confidence + segment.confidence) / 2).toFixed(2)
      );
      continue;
    }

    consolidated.push({ ...segment });
  }

  return consolidated;
}

function buildMeetingInfo(meeting, transcript) {
  const participantSet = new Set(meeting.participants || []);
  for (const segment of transcript || []) {
    participantSet.add(segment.speaker);
  }

  return {
    platform: meeting.platform,
    title: meeting.title,
    startTime: meeting.startTime,
    endTime: meeting.endTime || new Date().toISOString(),
    duration: meeting.startTime
      ? Math.max(
          0,
          Math.round(
            ((meeting.endEpochMs || Date.now()) -
              new Date(meeting.startTime).getTime()) /
              60000
          )
        )
      : 0,
    participants: [...participantSet].filter(Boolean),
  };
}

function createMeetingState(tabId, message = {}) {
  return {
    tabId,
    sessionId: `tab-${tabId}`,
    platform: message.platform || "Unknown",
    title: message.title || "Untitled Meeting",
    startTime: message.startTime || new Date().toISOString(),
    startEpochMs: Date.now(),
    endTime: null,
    endEpochMs: null,
    audioStartEpochMs: null,
    participants: [],
    speakerEvents: [],
    completedSpeakerTimeline: [],
    transcriptionSegments: [],
    diarizationSegments: [],
    captureStatus: "idle",
    captureError: null,
    serverStatus: "unknown",
    pendingFinalization: false,
  };
}

function summarizeMeeting(meeting) {
  return {
    tabId: meeting.tabId,
    platform: meeting.platform,
    title: meeting.title,
    segmentCount: meeting.transcriptionSegments.length,
    participantCount: meeting.participants.length,
    captureStatus: meeting.captureStatus,
    captureError: meeting.captureError,
    serverStatus: meeting.serverStatus,
  };
}

function mergeUniqueNames(existing, incoming) {
  return [...new Set([...(existing || []), ...(incoming || [])].filter(Boolean))];
}

function getMeeting(tabId) {
  if (!tabId) return null;
  return activeMeetings.get(tabId) || null;
}

async function persistMeetingState(meeting) {
  activeMeetings.set(meeting.tabId, meeting);
  await chrome.storage.local.set({
    currentMeeting: {
      ...meeting,
    },
  });
}

async function ensureOffscreenDocument() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [OFFSCREEN_DOCUMENT_URL],
  });

  if (contexts.length > 0) {
    return;
  }

  await chrome.offscreen.createDocument({
    url: OFFSCREEN_DOCUMENT_PATH,
    reasons: ["USER_MEDIA"],
    justification:
      "Capture meeting tab audio and stream it to the local Whisper server.",
  });
}

async function closeOffscreenDocumentIfIdle() {
  const stillCapturing = [...activeMeetings.values()].some(
    (meeting) =>
      meeting.captureStatus === "capturing" || meeting.captureStatus === "starting"
  );
  if (stillCapturing) return;

  try {
    await chrome.offscreen.closeDocument();
  } catch (error) {
    // No offscreen document open.
  }
}

function saveMarkdownFile(content, filename) {
  const blob = new Blob([content], { type: "text/markdown" });
  const url = URL.createObjectURL(blob);

  chrome.downloads.download(
    {
      url,
      filename,
      saveAs: false,
    },
    () => URL.revokeObjectURL(url)
  );
}

function updateBadge(tabId, count) {
  if (!tabId) return;
  chrome.action.setBadgeText({ text: count > 0 ? String(count) : "●", tabId });
  chrome.action.setBadgeBackgroundColor({ color: "#e53e3e", tabId });
}

function clearBadge(tabId) {
  if (!tabId) return;
  chrome.action.setBadgeText({ text: "", tabId });
}

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const meeting = activeMeetings.get(tabId);
  if (meeting) {
    meeting.endTime = new Date().toISOString();
    meeting.endEpochMs = Date.now();
    meeting.pendingFinalization = true;
    await finalizeMeetingIfReady(tabId);
    return;
  }

  const stored = await chrome.storage.local.get("currentMeeting");
  if (stored.currentMeeting?.tabId !== tabId) {
    return;
  }

  const recovered = stored.currentMeeting;
  const transcript = buildMergedTranscript(recovered);
  if (transcript.length === 0) {
    await chrome.storage.local.remove("currentMeeting");
    return;
  }

  const meetingInfo = buildMeetingInfo(recovered, transcript);
  saveMarkdownFile(
    formatTranscriptAsMarkdown(transcript, meetingInfo),
    generateFilename(meetingInfo)
  );
  await chrome.storage.local.remove("currentMeeting");
});
