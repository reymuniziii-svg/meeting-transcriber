/**
 * Post-meeting review page.
 * Lets the user verify/correct speaker names and re-save the transcript.
 */

document.addEventListener("DOMContentLoaded", () => {
  const contentEl = document.getElementById("content");

  chrome.storage.local.get("lastTranscript", (result) => {
    const data = result.lastTranscript;
    if (!data || !Array.isArray(data.transcript) || data.transcript.length === 0) {
      return;
    }

    renderReview(contentEl, data.transcript, data.meetingInfo || {});
  });
});

function renderReview(contentEl, transcript, meetingInfo) {
  contentEl.replaceChildren();

  const speakerStats = buildSpeakerStats(transcript);
  const speakers = Object.keys(speakerStats);
  const participants = meetingInfo.participants || [];

  contentEl.appendChild(buildMetaBlock(transcript, meetingInfo, speakers.length));
  contentEl.appendChild(buildSpeakerMap(speakers, speakerStats, participants));
  contentEl.appendChild(buildActions(transcript, meetingInfo));
  contentEl.appendChild(buildTranscriptPreview(transcript));

  document.querySelectorAll(".speaker-input").forEach((input) => {
    input.addEventListener("input", () => {
      const original = input.dataset.original;
      const newName = input.value.trim() || original;
      document.querySelectorAll(`.segment[data-speaker-key="${cssEscape(original)}"] .segment-speaker`)
        .forEach((el) => {
          el.textContent = newName;
        });
    });
  });
}

function buildSpeakerStats(transcript) {
  const stats = {};
  for (const segment of transcript) {
    const speaker = segment.speaker || "Unknown Speaker";
    if (!stats[speaker]) {
      stats[speaker] = {
        words: 0,
        segments: 0,
        firstSeen: segment.timestamp,
      };
    }
    stats[speaker].words += (segment.text || "").trim().split(/\s+/).filter(Boolean).length;
    stats[speaker].segments += 1;
  }
  return stats;
}

function buildMetaBlock(transcript, meetingInfo, speakerCount) {
  const wrapper = document.createElement("div");
  wrapper.className = "meta";

  const row = document.createElement("div");
  row.className = "meta-row";
  wrapper.appendChild(row);

  appendMetaItem(row, meetingInfo.platform || "Unknown", true);
  appendMetaItem(
    row,
    meetingInfo.startTime
      ? new Date(meetingInfo.startTime).toLocaleDateString("en-US", {
          weekday: "short",
          month: "short",
          day: "numeric",
          year: "numeric",
        })
      : "Unknown"
  );
  appendMetaItem(row, meetingInfo.duration ? `${meetingInfo.duration} min` : "Unknown");
  appendMetaItem(row, `${transcript.length} segments`);
  appendMetaItem(row, `${speakerCount} speakers`);

  return wrapper;
}

function appendMetaItem(row, value, strong = false) {
  const item = document.createElement("span");
  item.className = "meta-item";
  if (strong) {
    const strongEl = document.createElement("strong");
    strongEl.textContent = value;
    item.appendChild(strongEl);
  } else {
    item.textContent = value;
  }
  row.appendChild(item);
}

function buildSpeakerMap(speakers, speakerStats, participants) {
  const wrapper = document.createElement("div");
  wrapper.className = "speaker-map";

  const title = document.createElement("h2");
  title.textContent = "Speaker Names";
  wrapper.appendChild(title);

  const intro = document.createElement("p");
  intro.textContent =
    'Verify these are correct. Edit any that are wrong, then click "Save Corrected Transcript" below.';
  wrapper.appendChild(intro);

  for (const speaker of speakers) {
    const stats = speakerStats[speaker];
    const row = document.createElement("div");
    row.className = "speaker-row";

    const label = document.createElement("span");
    label.className = "speaker-label";
    label.textContent = speaker;
    row.appendChild(label);

    const arrow = document.createElement("span");
    arrow.className = "speaker-arrow";
    arrow.textContent = "→";
    row.appendChild(arrow);

    const input = document.createElement("input");
    input.type = "text";
    input.className = "speaker-input";
    input.dataset.original = speaker;
    input.placeholder = `${speaker} (keep as-is)`;
    input.value = "";
    row.appendChild(input);

    const words = document.createElement("span");
    words.className = "speaker-words";
    words.textContent = `${stats.words} words`;
    row.appendChild(words);

    wrapper.appendChild(row);
  }

  if (participants.length > 0) {
    const participantsEl = document.createElement("p");
    participantsEl.style.marginTop = "12px";
    participantsEl.style.fontSize = "12px";
    participantsEl.style.color = "#666";
    participantsEl.textContent = `Detected participants: ${participants.join(", ")}`;
    wrapper.appendChild(participantsEl);
  }

  return wrapper;
}

function buildActions(transcript, meetingInfo) {
  const wrapper = document.createElement("div");

  const actions = document.createElement("div");
  actions.className = "actions";
  wrapper.appendChild(actions);

  const saveButton = document.createElement("button");
  saveButton.className = "btn btn-primary";
  saveButton.id = "btn-save";
  saveButton.textContent = "Save Corrected Transcript";
  actions.appendChild(saveButton);

  const dismissButton = document.createElement("button");
  dismissButton.className = "btn btn-secondary";
  dismissButton.id = "btn-dismiss";
  dismissButton.textContent = "Looks Good, Dismiss";
  actions.appendChild(dismissButton);

  const success = document.createElement("p");
  success.className = "success-msg";
  success.id = "success-msg";
  success.textContent = "Corrected transcript saved!";
  wrapper.appendChild(success);

  saveButton.addEventListener("click", async () => {
    saveButton.disabled = true;
    saveButton.textContent = "Saving...";
    success.style.display = "none";

    const result = await saveWithCorrections(transcript, meetingInfo);
    if (result?.ok) {
      saveButton.textContent = "Saved!";
      success.style.display = "block";
    } else {
      saveButton.disabled = false;
      saveButton.textContent = "Save Corrected Transcript";
      window.alert(result?.error || "Could not save corrected transcript.");
    }
  });

  dismissButton.addEventListener("click", () => {
    window.close();
  });

  return wrapper;
}

function buildTranscriptPreview(transcript) {
  const wrapper = document.createElement("div");
  wrapper.className = "transcript-section";

  const title = document.createElement("h2");
  title.textContent =
    transcript.length > 30
      ? `Transcript Preview (first 30 of ${transcript.length})`
      : "Transcript Preview";
  wrapper.appendChild(title);

  for (const segment of transcript.slice(0, 30)) {
    const segmentEl = document.createElement("div");
    segmentEl.className = `segment${(segment.confidence || 1) < 0.3 ? " low-confidence" : ""}`;
    segmentEl.dataset.speakerKey = segment.speaker || "Unknown Speaker";

    const header = document.createElement("div");
    header.className = "segment-header";
    segmentEl.appendChild(header);

    const speaker = document.createElement("span");
    speaker.className = "segment-speaker";
    speaker.textContent = segment.speaker || "Unknown Speaker";
    header.appendChild(speaker);

    if (segment.timestamp) {
      const time = document.createElement("span");
      time.className = "segment-time";
      time.textContent = ` (${new Date(segment.timestamp).toLocaleTimeString("en-US", {
        hour: "numeric",
        minute: "2-digit",
      })})`;
      header.appendChild(time);
    }

    const text = document.createElement("div");
    text.className = "segment-text";
    text.textContent = segment.text || "";
    segmentEl.appendChild(text);

    wrapper.appendChild(segmentEl);
  }

  return wrapper;
}

async function saveWithCorrections(transcript, meetingInfo) {
  const renameMap = {};
  document.querySelectorAll(".speaker-input").forEach((input) => {
    const original = input.dataset.original;
    const newName = input.value.trim();
    if (newName && newName !== original) {
      renameMap[original] = newName;
    }
  });

  const corrected = transcript.map((segment) => ({
    ...segment,
    speaker: renameMap[segment.speaker] || segment.speaker,
  }));

  const correctedInfo = {
    ...meetingInfo,
    participants: [...new Set(corrected.map((segment) => segment.speaker).filter(Boolean))],
    corrected: true,
  };

  return chrome.runtime.sendMessage({
    type: "downloadTranscript",
    transcript: corrected,
    meetingInfo: correctedInfo,
  });
}

function cssEscape(value) {
  if (window.CSS && typeof window.CSS.escape === "function") {
    return window.CSS.escape(value);
  }

  return String(value).replace(/["\\]/g, "\\$&");
}
