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
    }

    sendResponse({ ok: false, error: "Unsupported offscreen message type." });
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
  await cleanupCapture();

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
    stopped: false,
  };

  processor.onaudioprocess = (event) => {
    if (!captureState || captureState.socket.readyState !== WebSocket.OPEN) {
      return;
    }

    const input = event.inputBuffer;
    const pcm = floatTo16BitPCM(input);
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

  socket.addEventListener("message", (event) => {
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
        cleanupCapture().then(() => {
          reportToBackground("offscreenCaptureStopped", {
            tabId: config.tabId,
            sessionId: config.sessionId,
          });
        });
        break;

      case "error":
        reportToBackground("offscreenError", {
          tabId: config.tabId,
          error: payload.error || "Unknown transcription server error.",
        });
        break;
    }
  });

  socket.addEventListener("error", () => {
    reportToBackground("offscreenServerStatus", {
      tabId: config.tabId,
      status: "disconnected",
    });
    cleanupCapture();
  });

  socket.addEventListener("close", () => {
    if (!captureState || captureState.stopped) {
      return;
    }

    reportToBackground("offscreenServerStatus", {
      tabId: config.tabId,
      status: "disconnected",
    });
    cleanupCapture();
  });
}

async function stopCapture(config) {
  if (!captureState) {
    reportToBackground("offscreenCaptureStopped", {
      tabId: config.tabId,
      sessionId: config.sessionId,
    });
    return;
  }

  captureState.stopped = true;

  if (captureState.socket.readyState === WebSocket.OPEN) {
    captureState.socket.send(
      JSON.stringify({
        type: "stop",
        sessionId: captureState.sessionId,
      })
    );
    setTimeout(async () => {
      if (captureState) {
        await cleanupCapture();
        reportToBackground("offscreenCaptureStopped", {
          tabId: config.tabId,
          sessionId: config.sessionId,
        });
      }
    }, 500);
    return;
  }

  await cleanupCapture();
  reportToBackground("offscreenCaptureStopped", {
    tabId: config.tabId,
    sessionId: config.sessionId,
  });
}

async function cleanupCapture() {
  if (!captureState) return;

  try {
    captureState.processor.disconnect();
  } catch (error) {}

  try {
    captureState.source.disconnect();
  } catch (error) {}

  try {
    captureState.mutedGain.disconnect();
  } catch (error) {}

  try {
    captureState.mediaStream.getTracks().forEach((track) => track.stop());
  } catch (error) {}

  try {
    await captureState.audioContext.close();
  } catch (error) {}

  try {
    if (
      captureState.socket.readyState === WebSocket.OPEN ||
      captureState.socket.readyState === WebSocket.CONNECTING
    ) {
      captureState.socket.close();
    }
  } catch (error) {}

  captureState = null;
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
