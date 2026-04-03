/**
 * Popup UI logic.
 */

const SERVER_WS_URL = "ws://127.0.0.1:9090";

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
  renderServerHealth(serverStatusBox, serverStatusText, serverWarning, serverWarningText, serverConnected);

  if (tabId) {
    const response = await chrome.runtime.sendMessage({ type: "getStatus", tabId });
    renderMeeting(response?.meeting);
  }

  const result = await chrome.storage.session.get("selectorWarning");
  if (result.selectorWarning && Date.now() - result.selectorWarning.timestamp < 3600000) {
    selectorWarning.classList.remove("hidden");
    warningText.textContent = `${result.selectorWarning.platform}: ${result.selectorWarning.failures} selector group(s) failed repeated checks.`;
  }

  btnStartCapture.addEventListener("click", async () => {
    if (!tabId) {
      return;
    }

    serverWarning.classList.add("hidden");
    btnStartCapture.disabled = true;
    btnStartCapture.textContent = "Waiting for local server...";
    infoCapture.textContent = "Waiting for local server";

    const result = await chrome.runtime.sendMessage({
      type: "beginCapture",
      tabId,
    });

    if (!result?.ok) {
      serverWarning.classList.remove("hidden");
      serverWarningText.textContent = result?.error || "Capture failed.";
      infoCapture.textContent = "Capture failed";
      btnStartCapture.disabled = false;
      btnStartCapture.textContent = "Connect Audio";
      return;
    }

    infoCapture.textContent = formatCaptureStatus(result.status || "starting");
    btnStartCapture.textContent = "Connecting...";

    setTimeout(async () => {
      const refreshed = await chrome.runtime.sendMessage({ type: "getStatus", tabId });
      renderMeeting(refreshed?.meeting);
    }, 1200);
  });

  btnDownload.addEventListener("click", async () => {
    if (!tabId) {
      return;
    }

    const result = await chrome.runtime.sendMessage({
      type: "downloadCurrentTranscript",
      tabId,
    });

    btnDownload.textContent = result?.ok ? "Downloaded!" : "No Transcript Yet";
    setTimeout(() => {
      btnDownload.textContent = "Download Transcript";
    }, 2000);
  });

  function renderMeeting(meeting) {
    if (!meeting) {
      statusIndicator.className = "status idle";
      statusText.textContent = "No active meeting";
      meetingInfoSection.classList.add("hidden");
      btnStartCapture.classList.add("hidden");
      btnDownload.classList.add("hidden");
      return;
    }

    statusIndicator.className = "status recording";
    statusText.textContent = "Meeting detected";
    meetingInfoSection.classList.remove("hidden");
    infoPlatform.textContent = meeting.platform;
    infoSegments.textContent = meeting.segmentCount;
    infoCapture.textContent = formatCaptureStatus(meeting.captureStatus);

    btnDownload.classList.toggle("hidden", meeting.segmentCount === 0);

    const shouldShowConnect = ["idle", "awaiting_user_gesture", "error", "stopped"].includes(
      meeting.captureStatus
    );
    btnStartCapture.classList.toggle("hidden", !shouldShowConnect);
    btnStartCapture.disabled = false;
    btnStartCapture.textContent =
      meeting.captureStatus === "awaiting_user_gesture" ? "Grant Audio Permission" : "Connect Audio";

    if (meeting.captureError) {
      serverWarning.classList.remove("hidden");
      serverWarningText.textContent = meeting.captureError;
    }
  }
});

function renderServerHealth(serverStatusBox, serverStatusText, serverWarning, serverWarningText, connected) {
  serverStatusBox.classList.remove("hidden");
  serverStatusText.textContent = connected ? "Connected" : "Waiting";
  serverStatusText.className = connected ? "server-ok" : "server-bad";

  if (!connected) {
    serverWarning.classList.remove("hidden");
    serverWarningText.textContent =
      "Waiting for local server. launchd should restart it automatically after install.";
  }
}

function formatCaptureStatus(status) {
  switch (status) {
    case "capturing":
      return "Connected";
    case "starting":
      return "Starting";
    case "waiting_for_server":
      return "Waiting for local server";
    case "awaiting_user_gesture":
      return "Audio capture permission needed";
    case "stopping":
      return "Stopping";
    case "error":
      return "Capture failed";
    case "stopped":
      return "Stopped";
    default:
      return "Idle";
  }
}

function pingWhisperServer() {
  return new Promise((resolve) => {
    let settled = false;
    const socket = new WebSocket(SERVER_WS_URL);
    const timeout = setTimeout(() => finish(false), 1500);

    function finish(result) {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      try {
        socket.close();
      } catch (error) {
        // Ignore.
      }
      resolve(result);
    }

    socket.addEventListener("open", () => finish(true));
    socket.addEventListener("error", () => finish(false));
    socket.addEventListener("close", () => finish(false));
  });
}
