/**
 * Chrome storage management for transcript persistence.
 * Saves transcript state to chrome.storage.local for recovery
 * if the tab closes unexpectedly.
 */

const TranscriptStorage = (() => {
  let saveDebounceTimer = null;
  const SAVE_DEBOUNCE_MS = 5000; // Save at most every 5 seconds

  /**
   * Save transcript and meeting info to chrome.storage.local
   */
  function save(transcript, meetingInfo) {
    if (saveDebounceTimer) return; // Already scheduled

    saveDebounceTimer = setTimeout(() => {
      saveDebounceTimer = null;
      const data = {
        transcript,
        meetingInfo: {
          ...meetingInfo,
          participants: Array.from(meetingInfo.participants || []),
        },
        savedAt: new Date().toISOString(),
      };

      chrome.storage.local.set({ currentMeeting: data }, () => {
        if (chrome.runtime.lastError) {
          console.warn(
            "[MeetingTranscriber] Storage save error:",
            chrome.runtime.lastError
          );
        }
      });
    }, SAVE_DEBOUNCE_MS);
  }

  /**
   * Load any previously saved meeting data (for crash recovery)
   */
  function load(callback) {
    chrome.storage.local.get("currentMeeting", (result) => {
      callback(result.currentMeeting || null);
    });
  }

  /**
   * Clear saved meeting data
   */
  function clear() {
    chrome.storage.local.remove("currentMeeting");
  }

  return { save, load, clear };
})();
