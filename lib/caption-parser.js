/**
 * Unified caption parser with deduplication logic.
 * Shared across all platform content scripts.
 *
 * Handles:
 * - Buffering in-progress captions (platforms update text in-place)
 * - Detecting utterance boundaries (speaker change or pause)
 * - Deduplicating live-updating caption text
 * - Maintaining a structured transcript array
 */

const CaptionParser = (() => {
  let transcript = [];
  let currentBuffer = null; // { speaker, text, timestamp, elementRef }
  let meetingInfo = {
    platform: "",
    title: "",
    startTime: null,
    participants: new Set(),
  };
  let isRecording = false;
  let flushTimer = null;

  const FLUSH_DELAY_MS = 3000; // Flush buffer after 3s of no updates

  /**
   * Initialize the parser for a new meeting
   */
  function startMeeting(platform, title = "") {
    transcript = [];
    currentBuffer = null;
    meetingInfo = {
      platform,
      title: title || `${platform} Meeting`,
      startTime: new Date(),
      participants: new Set(),
    };
    isRecording = true;
    console.log(`[MeetingTranscriber] Started recording: ${platform}`);
    notifyBackground("meetingStarted", { platform, title: meetingInfo.title });
  }

  /**
   * Process a caption update from the DOM observer.
   * Called every time a caption element changes.
   *
   * @param {string} speaker - Speaker name from DOM
   * @param {string} text - Full current text of the caption element
   * @param {*} elementRef - Optional reference to track which DOM element this is
   */
  function processCaption(speaker, text, elementRef = null) {
    if (!isRecording || !speaker || !text) return;

    const trimmedSpeaker = speaker.trim();
    const trimmedText = text.trim();
    if (!trimmedSpeaker || !trimmedText) return;

    meetingInfo.participants.add(trimmedSpeaker);

    // Reset flush timer on every update
    if (flushTimer) clearTimeout(flushTimer);

    // Same speaker, same element (or no element tracking) = update buffer
    if (
      currentBuffer &&
      currentBuffer.speaker === trimmedSpeaker &&
      (elementRef === null || currentBuffer.elementRef === elementRef)
    ) {
      currentBuffer.text = trimmedText;
    } else {
      // Different speaker or different element = flush old buffer, start new
      flushBuffer();
      currentBuffer = {
        speaker: trimmedSpeaker,
        text: trimmedText,
        timestamp: new Date(),
        elementRef,
      };
    }

    // Auto-flush after inactivity
    flushTimer = setTimeout(flushBuffer, FLUSH_DELAY_MS);

    // Persist to storage periodically
    saveToStorage();
  }

  /**
   * Flush the current buffer to the transcript array
   */
  function flushBuffer() {
    if (!currentBuffer) return;

    // Merge with previous entry if same speaker and text is an extension
    const lastEntry = transcript[transcript.length - 1];
    if (lastEntry && lastEntry.speaker === currentBuffer.speaker) {
      // If the new text starts with the old text, it's a continuation
      if (currentBuffer.text.startsWith(lastEntry.text)) {
        lastEntry.text = currentBuffer.text;
      } else {
        // New utterance from same speaker
        transcript.push({
          speaker: currentBuffer.speaker,
          text: currentBuffer.text,
          timestamp: currentBuffer.timestamp,
        });
      }
    } else {
      transcript.push({
        speaker: currentBuffer.speaker,
        text: currentBuffer.text,
        timestamp: currentBuffer.timestamp,
      });
    }

    currentBuffer = null;
    saveToStorage();
  }

  /**
   * End the meeting and trigger file save
   */
  function endMeeting() {
    if (!isRecording) return;

    flushBuffer();
    if (flushTimer) clearTimeout(flushTimer);
    isRecording = false;

    const endTime = new Date();
    const duration = meetingInfo.startTime
      ? Math.round((endTime - meetingInfo.startTime) / 60000)
      : 0;

    console.log(
      `[MeetingTranscriber] Meeting ended. ${transcript.length} segments captured.`
    );

    notifyBackground("meetingEnded", {
      transcript,
      meetingInfo: {
        ...meetingInfo,
        participants: Array.from(meetingInfo.participants),
        endTime,
        duration,
      },
    });
  }

  /**
   * Get the current transcript
   */
  function getTranscript() {
    flushBuffer();
    return { transcript: [...transcript], meetingInfo: { ...meetingInfo, participants: Array.from(meetingInfo.participants) } };
  }

  /**
   * Check if currently recording
   */
  function getIsRecording() {
    return isRecording;
  }

  /**
   * Send message to background service worker
   */
  function notifyBackground(type, data) {
    try {
      chrome.runtime.sendMessage({ type, ...data });
    } catch (e) {
      console.warn("[MeetingTranscriber] Could not notify background:", e);
    }
  }

  /**
   * Save current state to chrome.storage.local
   */
  function saveToStorage() {
    TranscriptStorage.save(transcript, meetingInfo);
  }

  return {
    startMeeting,
    processCaption,
    flushBuffer,
    endMeeting,
    getTranscript,
    getIsRecording,
  };
})();
