/**
 * Background service worker.
 * Handles:
 * - Receiving transcript data from content scripts
 * - Formatting and saving markdown files via chrome.downloads
 * - Managing extension state across tabs
 * - Communicating with the popup
 */

// Import markdown formatter
importScripts("lib/markdown-formatter.js");

// Track active meetings per tab
const activeMeetings = new Map();

// Listen for messages from content scripts and popup
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const tabId = sender.tab?.id;

  switch (message.type) {
    case "meetingStarted":
      handleMeetingStarted(tabId, message);
      break;

    case "meetingEnded":
      handleMeetingEnded(tabId, message);
      break;

    case "getStatus":
      sendResponse({
        activeMeetings: Array.from(activeMeetings.entries()).map(
          ([id, info]) => ({
            tabId: id,
            platform: info.platform,
            title: info.title,
          })
        ),
      });
      return true; // Keep channel open for async response

    case "downloadTranscript":
      handleManualDownload(message);
      break;

    case "captionUpdate":
      // Forward to popup if it's open
      updateBadge(tabId, message.segmentCount);
      break;
  }
});

function handleMeetingStarted(tabId, message) {
  console.log(
    `[MeetingTranscriber] Meeting started on tab ${tabId}: ${message.platform}`
  );
  activeMeetings.set(tabId, {
    platform: message.platform,
    title: message.title,
    startTime: new Date(),
  });
  updateBadge(tabId, 0);
}

function handleMeetingEnded(tabId, message) {
  console.log(`[MeetingTranscriber] Meeting ended on tab ${tabId}`);
  activeMeetings.delete(tabId);

  const { transcript, meetingInfo } = message;

  if (!transcript || transcript.length === 0) {
    console.log("[MeetingTranscriber] No transcript to save.");
    clearBadge(tabId);
    return;
  }

  // Format and save
  const markdown = formatTranscriptAsMarkdown(transcript, meetingInfo);
  const filename = generateFilename(meetingInfo);

  saveMarkdownFile(markdown, filename);
  clearBadge(tabId);

  // Clear stored data
  chrome.storage.local.remove("currentMeeting");
}

function handleManualDownload(message) {
  const { transcript, meetingInfo } = message;
  if (!transcript || transcript.length === 0) return;

  const markdown = formatTranscriptAsMarkdown(transcript, meetingInfo);
  const filename = generateFilename(meetingInfo);
  saveMarkdownFile(markdown, filename);
}

/**
 * Save markdown content as a file via chrome.downloads API
 */
function saveMarkdownFile(content, filename) {
  const blob = new Blob([content], { type: "text/markdown" });
  const url = URL.createObjectURL(blob);

  chrome.downloads.download(
    {
      url,
      filename,
      saveAs: false, // Auto-save without dialog
    },
    (downloadId) => {
      if (chrome.runtime.lastError) {
        console.error(
          "[MeetingTranscriber] Download error:",
          chrome.runtime.lastError
        );
      } else {
        console.log(
          `[MeetingTranscriber] Transcript saved: ${filename} (download ${downloadId})`
        );
      }
      // Clean up blob URL
      URL.revokeObjectURL(url);
    }
  );
}

/**
 * Update the extension badge to show segment count
 */
function updateBadge(tabId, count) {
  if (!tabId) return;
  chrome.action.setBadgeText({ text: count > 0 ? String(count) : "●", tabId });
  chrome.action.setBadgeBackgroundColor({ color: "#e53e3e", tabId });
}

function clearBadge(tabId) {
  if (!tabId) return;
  chrome.action.setBadgeText({ text: "", tabId });
}

// Clean up when a tab closes
chrome.tabs.onRemoved.addListener((tabId) => {
  if (activeMeetings.has(tabId)) {
    console.log(
      `[MeetingTranscriber] Tab ${tabId} closed during meeting. Attempting recovery...`
    );
    activeMeetings.delete(tabId);

    // Try to recover from storage
    chrome.storage.local.get("currentMeeting", (result) => {
      if (result.currentMeeting) {
        const { transcript, meetingInfo } = result.currentMeeting;
        if (transcript && transcript.length > 0) {
          const markdown = formatTranscriptAsMarkdown(
            transcript,
            meetingInfo
          );
          const filename = generateFilename(meetingInfo);
          saveMarkdownFile(markdown, filename);
          chrome.storage.local.remove("currentMeeting");
        }
      }
    });
  }
});
