/**
 * Popup UI logic.
 * Shows meeting status and provides manual download control.
 */

document.addEventListener("DOMContentLoaded", () => {
  const statusIndicator = document.getElementById("status-indicator");
  const statusText = document.getElementById("status-text");
  const meetingInfoSection = document.getElementById("meeting-info");
  const infoPlatform = document.getElementById("info-platform");
  const infoSegments = document.getElementById("info-segments");
  const btnDownload = document.getElementById("btn-download");
  const instructions = document.getElementById("instructions");

  // Check for active meetings
  chrome.runtime.sendMessage({ type: "getStatus" }, (response) => {
    if (chrome.runtime.lastError || !response) return;

    const meetings = response.activeMeetings || [];
    if (meetings.length > 0) {
      const meeting = meetings[0];
      statusIndicator.className = "status recording";
      statusText.textContent = "Recording...";
      infoPlatform.textContent = meeting.platform;
      meetingInfoSection.classList.remove("hidden");
      btnDownload.classList.remove("hidden");
      instructions.classList.add("hidden");
    }
  });

  // Get live segment count from active tab
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (!tabs[0]) return;

    chrome.tabs.sendMessage(
      tabs[0].id,
      { type: "getTranscript" },
      (response) => {
        if (chrome.runtime.lastError || !response) return;

        if (response.transcript) {
          infoSegments.textContent = response.transcript.length;
        }
      }
    );
  });

  // Check for selector warnings
  chrome.storage.session.get("selectorWarning", (result) => {
    if (chrome.runtime.lastError || !result.selectorWarning) return;

    const warning = result.selectorWarning;
    // Only show if recent (within last hour)
    if (Date.now() - warning.timestamp < 3600000) {
      const warningEl = document.getElementById("selector-warning");
      const warningText = document.getElementById("warning-text");
      warningText.textContent = `${warning.platform}: ${warning.failures} selector(s) may be outdated. Transcription could be incomplete.`;
      warningEl.classList.remove("hidden");
    }
  });

  // Manual download button
  btnDownload.addEventListener("click", () => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (!tabs[0]) return;

      chrome.tabs.sendMessage(
        tabs[0].id,
        { type: "getTranscript" },
        (response) => {
          if (chrome.runtime.lastError || !response) return;

          chrome.runtime.sendMessage({
            type: "downloadTranscript",
            transcript: response.transcript,
            meetingInfo: response.meetingInfo,
          });

          btnDownload.textContent = "Downloaded!";
          setTimeout(() => {
            btnDownload.textContent = "Download Transcript";
          }, 2000);
        }
      );
    });
  });
});
