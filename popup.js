/**
 * Popup UI logic.
 */

document.addEventListener("DOMContentLoaded", async () => {
  const statusIndicator = document.getElementById("status-indicator");
  const statusText = document.getElementById("status-text");
  const meetingInfoSection = document.getElementById("meeting-info");
  const infoPlatform = document.getElementById("info-platform");
  const infoSegments = document.getElementById("info-segments");
  const infoCapture = document.getElementById("info-capture");
  const serverStatusBox = document.getElementById("server-status");
  const serverStatusText = document.getElementById("server-status-text");
  const serverWarning = document.getElementById("server-warning");
  const serverWarningText = document.getElementById("server-warning-text");
  const selectorWarning = document.getElementById("selector-warning");
  const warningText = document.getElementById("warning-text");
  const btnStartCapture = document.getElementById("btn-start-capture");
  const btnDownload = document.getElementById("btn-download");

  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const tabId = activeTab?.id;

  const serverConnected = await pingWhisperServer();
  serverStatusBox.classList.remove("hidden");
  serverStatusText.textContent = serverConnected ? "Connected" : "Disconnected";
  serverStatusText.className = serverConnected ? "server-ok" : "server-bad";

  if (!serverConnected) {
    serverWarning.classList.remove("hidden");
    serverWarningText.textContent =
      "Whisper server not running. Start it with ./start-server.sh";
  }

  if (tabId) {
    const response = await chrome.runtime.sendMessage({ type: "getStatus", tabId });
    const meeting = response?.meeting;

    if (meeting) {
      statusIndicator.className = "status recording";
      statusText.textContent = "Meeting detected";
      meetingInfoSection.classList.remove("hidden");
      infoPlatform.textContent = meeting.platform;
      infoSegments.textContent = meeting.segmentCount;
      infoCapture.textContent = formatCaptureStatus(meeting.captureStatus);
      btnDownload.classList.remove("hidden");

      if (
        meeting.captureStatus === "awaiting_user_gesture" ||
        meeting.captureStatus === "idle" ||
        meeting.captureStatus === "error"
      ) {
        btnStartCapture.classList.remove("hidden");
      }

      if (meeting.captureError) {
        serverWarning.classList.remove("hidden");
        serverWarningText.textContent = meeting.captureError;
      }
    }
  }

  const result = await chrome.storage.session.get("selectorWarning");
  if (result.selectorWarning && Date.now() - result.selectorWarning.timestamp < 3600000) {
    selectorWarning.classList.remove("hidden");
    warningText.textContent = `${result.selectorWarning.platform}: ${result.selectorWarning.failures} selector(s) may be outdated.`;
  }

  btnStartCapture.addEventListener("click", async () => {
    if (!tabId) return;

    btnStartCapture.disabled = true;
    btnStartCapture.textContent = "Connecting...";

    const result = await chrome.runtime.sendMessage({
      type: "beginCapture",
      tabId,
    });

    if (!result?.ok) {
      serverWarning.classList.remove("hidden");
      serverWarningText.textContent = result?.error || "Could not connect audio capture.";
      btnStartCapture.disabled = false;
      btnStartCapture.textContent = "Connect Audio";
      return;
    }

    infoCapture.textContent = "Starting";
    btnStartCapture.textContent = "Connected";
    setTimeout(() => {
      btnStartCapture.classList.add("hidden");
    }, 1200);
  });

  btnDownload.addEventListener("click", async () => {
    if (!tabId) return;

    const result = await chrome.runtime.sendMessage({
      type: "downloadCurrentTranscript",
      tabId,
    });

    btnDownload.textContent = result?.ok ? "Downloaded!" : "No Transcript Yet";
    setTimeout(() => {
      btnDownload.textContent = "Download Transcript";
    }, 2000);
  });
});

function formatCaptureStatus(status) {
  switch (status) {
    case "capturing":
      return "Connected";
    case "starting":
      return "Starting";
    case "awaiting_user_gesture":
      return "Needs click";
    case "error":
      return "Error";
    default:
      return "Idle";
  }
}

function pingWhisperServer() {
  return new Promise((resolve) => {
    let settled = false;
    const socket = new WebSocket("ws://127.0.0.1:9090");
    const timeout = setTimeout(() => finish(false), 1500);

    function finish(result) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      try {
        socket.close();
      } catch (error) {}
      resolve(result);
    }

    socket.addEventListener("open", () => finish(true));
    socket.addEventListener("error", () => finish(false));
    socket.addEventListener("close", () => finish(false));
  });
}
