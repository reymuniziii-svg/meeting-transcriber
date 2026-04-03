/**
 * Offscreen audio capture pipeline for MV3.
 */

let captureState = null;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    switch (message.type) {
      case "startCapture":
        await startCapture(message);
        sendResponse({ ok: true });
        return;
      case "stopCapture":
        await stopCapture(message);
        sendResponse({ ok: true });
        return;
      default:
        return;
    }
  })().catch((error) => {
    console.error("[MeetingTranscriber] Offscreen error:", error);
    reportToBackground("offscreenError", {
      tabId: message.tabId,
      error: error.message || String(error),
    });
    sendResponse({ ok: false, error: error.message || String(error) });
  });

  return true;
});

async function startCapture(config) {
  await cleanupCapture({ reason: "replaced", suppressTerminalEvent: true });

  const mediaStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      mandatory: {
        chromeMediaSource: "tab",
        chromeMediaSourceId: config.streamId,
      },
    },
    video: false,
  });

  const audioContext = new AudioContext({ sampleRate: 16000 });
  const source = audioContext.createMediaStreamSource(mediaStream);
  const processor = audioContext.createScriptProcessor(4096, source.channelCount || 1, 1);
  const mutedGain = audioContext.createGain();
  mutedGain.gain.value = 0;

  const socket = new WebSocket(config.wsUrl || "ws://127.0.0.1:9090");
  socket.binaryType = "arraybuffer";

  captureState = {
    ...config,
    mediaStream,
    audioContext,
    source,
    processor,
    mutedGain,
    socket,
    stopRequested: false,
    terminalReported: false,
  };

  processor.onaudioprocess = (event) => {
    if (!captureState || captureState.socket.readyState !== WebSocket.OPEN) {
      return;
    }

    const pcm = floatTo16BitPCM(event.inputBuffer);
    captureState.socket.send(pcm.buffer);
  };

  source.connect(processor);
  processor.connect(mutedGain);
  mutedGain.connect(audioContext.destination);
  await audioContext.resume();

  socket.addEventListener("open", () => {
    reportToBackground("offscreenServerStatus", {
      tabId: config.tabId,
      status: "connected",
    });

    socket.send(
      JSON.stringify({
        type: "start",
        sessionId: config.sessionId,
        title: config.title,
        prompt: config.prompt,
        vocab: config.vocab,
      })
    );

    reportToBackground("offscreenCaptureStarted", {
      tabId: config.tabId,
      sessionId: config.sessionId,
      startedAt: Date.now(),
    });
  });

  socket.addEventListener("message", async (event) => {
    let payload;
    try {
      payload = JSON.parse(event.data);
    } catch (error) {
      return;
    }

    switch (payload.type) {
      case "transcription":
        reportToBackground("offscreenTranscription", {
          tabId: config.tabId,
          sessionId: config.sessionId,
          segments: payload.segments || [],
        });
        break;
      case "diarization":
        reportToBackground("offscreenDiarization", {
          tabId: config.tabId,
          sessionId: config.sessionId,
          speakers: payload.speakers || [],
        });
        break;
      case "sessionStopped":
        await cleanupCapture({
          reason: "sessionStopped",
          reportStopped: true,
          reportTerminal: true,
          terminalServerStatus: "disconnected",
        });
        break;
      case "error":
        reportToBackground("offscreenError", {
          tabId: config.tabId,
          error: payload.error || "Unknown transcription server error.",
        });
        break;
      default:
        break;
    }
  });

  socket.addEventListener("error", async () => {
    reportToBackground("offscreenServerStatus", {
      tabId: config.tabId,
      status: "disconnected",
    });
    await cleanupCapture({
      reason: "socketError",
      reportStopped: captureState?.stopRequested,
      reportTerminal: true,
      terminalError: captureState?.stopRequested
        ? null
        : "The local server connection failed during audio capture.",
      terminalServerStatus: "disconnected",
    });
  });

  socket.addEventListener("close", async () => {
    const state = captureState;
    if (!state) {
      return;
    }

    reportToBackground("offscreenServerStatus", {
      tabId: state.tabId,
      status: "disconnected",
    });

    await cleanupCapture({
      reason: state.stopRequested ? "closedAfterStop" : "unexpectedClose",
      reportStopped: state.stopRequested,
      reportTerminal: true,
      terminalError: state.stopRequested
        ? null
        : "The local server closed the capture connection unexpectedly.",
      terminalServerStatus: "disconnected",
    });
  });
}

async function stopCapture(config) {
  if (!captureState) {
    reportToBackground("offscreenCaptureStopped", {
      tabId: config.tabId,
      sessionId: config.sessionId,
    });
    reportToBackground("offscreenCaptureTerminal", {
      tabId: config.tabId,
      sessionId: config.sessionId,
      reason: "alreadyStopped",
      serverStatus: "disconnected",
    });
    return;
  }

  captureState.stopRequested = true;

  if (captureState.socket.readyState === WebSocket.OPEN) {
    captureState.socket.send(
      JSON.stringify({
        type: "stop",
        sessionId: captureState.sessionId,
      })
    );

    setTimeout(async () => {
      if (!captureState) {
        return;
      }

      await cleanupCapture({
        reason: "stopTimeout",
        reportStopped: true,
        reportTerminal: true,
        terminalServerStatus: "disconnected",
      });
    }, 800);
    return;
  }

  await cleanupCapture({
    reason: "stopWithoutOpenSocket",
    reportStopped: true,
    reportTerminal: true,
    terminalServerStatus: "disconnected",
  });
}

async function cleanupCapture(options = {}) {
  if (!captureState) {
    return;
  }

  const state = captureState;
  captureState = null;

  try {
    state.processor.disconnect();
  } catch (error) {
    // Ignore.
  }

  try {
    state.source.disconnect();
  } catch (error) {
    // Ignore.
  }

  try {
    state.mutedGain.disconnect();
  } catch (error) {
    // Ignore.
  }

  try {
    state.mediaStream.getTracks().forEach((track) => track.stop());
  } catch (error) {
    // Ignore.
  }

  try {
    await state.audioContext.close();
  } catch (error) {
    // Ignore.
  }

  try {
    if (
      state.socket.readyState === WebSocket.OPEN ||
      state.socket.readyState === WebSocket.CONNECTING
    ) {
      state.socket.close();
    }
  } catch (error) {
    // Ignore.
  }

  if (options.reportStopped) {
    reportToBackground("offscreenCaptureStopped", {
      tabId: state.tabId,
      sessionId: state.sessionId,
    });
  }

  if (options.reportTerminal && !options.suppressTerminalEvent && !state.terminalReported) {
    state.terminalReported = true;
    reportToBackground("offscreenCaptureTerminal", {
      tabId: state.tabId,
      sessionId: state.sessionId,
      reason: options.reason || "cleanup",
      error: options.terminalError || null,
      serverStatus: options.terminalServerStatus || "disconnected",
    });
  }
}

function floatTo16BitPCM(audioBuffer) {
  const channels = audioBuffer.numberOfChannels;
  const frameCount = audioBuffer.length;
  const pcm = new Int16Array(frameCount);

  for (let index = 0; index < frameCount; index += 1) {
    let sample = 0;
    for (let channel = 0; channel < channels; channel += 1) {
      sample += audioBuffer.getChannelData(channel)[index] || 0;
    }

    sample /= channels;
    const clamped = Math.max(-1, Math.min(1, sample));
    pcm[index] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
  }

  return pcm;
}

function reportToBackground(type, payload) {
  try {
    chrome.runtime.sendMessage({ type, ...payload });
  } catch (error) {
    console.warn("[MeetingTranscriber] Could not report offscreen status:", error);
  }
}
