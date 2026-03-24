/**
 * Post-meeting review page.
 * Lets user verify/correct speaker names and re-save the transcript.
 */

document.addEventListener("DOMContentLoaded", () => {
  const contentEl = document.getElementById("content");

  chrome.storage.local.get("lastTranscript", (result) => {
    const data = result.lastTranscript;
    if (!data || !data.transcript || data.transcript.length === 0) {
      return; // Show empty state
    }

    renderReview(data.transcript, data.meetingInfo);
  });

  function renderReview(transcript, meetingInfo) {
    // Collect unique speakers and their word counts
    const speakerStats = {};
    for (const seg of transcript) {
      const sp = seg.speaker;
      if (!speakerStats[sp]) {
        speakerStats[sp] = { words: 0, segments: 0, firstSeen: seg.timestamp };
      }
      speakerStats[sp].words += (seg.text || "").split(/\s+/).length;
      speakerStats[sp].segments += 1;
    }

    const speakers = Object.keys(speakerStats);
    const participants = meetingInfo.participants || [];

    // Build the page
    let html = "";

    // Meta info
    const date = meetingInfo.startTime
      ? new Date(meetingInfo.startTime).toLocaleDateString("en-US", {
          weekday: "short",
          month: "short",
          day: "numeric",
          year: "numeric",
        })
      : "Unknown";
    const duration = meetingInfo.duration
      ? `${meetingInfo.duration} min`
      : "Unknown";

    html += `
      <div class="meta">
        <div class="meta-row">
          <span class="meta-item"><strong>${meetingInfo.platform || "Unknown"}</strong></span>
          <span class="meta-item">${date}</span>
          <span class="meta-item">${duration}</span>
          <span class="meta-item">${transcript.length} segments</span>
          <span class="meta-item">${speakers.length} speakers</span>
        </div>
      </div>
    `;

    // Speaker renaming
    html += `
      <div class="speaker-map">
        <h2>Speaker Names</h2>
        <p>Verify these are correct. Edit any that are wrong, then click "Save Corrected Transcript" below.</p>
    `;

    for (const speaker of speakers) {
      const stats = speakerStats[speaker];
      // Pre-fill with participant name if we have a matching index
      const suggestedName =
        participants.length > 0 ? "" : "";

      html += `
        <div class="speaker-row">
          <span class="speaker-label">${speaker}</span>
          <span class="speaker-arrow">&rarr;</span>
          <input
            type="text"
            class="speaker-input"
            data-original="${speaker}"
            placeholder="${speaker} (keep as-is)"
            value="${suggestedName}"
          />
          <span class="speaker-words">${stats.words} words</span>
        </div>
      `;
    }

    if (participants.length > 0) {
      html += `
        <p style="margin-top: 12px; font-size: 12px; color: #666;">
          Detected participants: ${participants.join(", ")}
        </p>
      `;
    }

    html += `</div>`;

    // Actions
    html += `
      <div class="actions">
        <button class="btn btn-primary" id="btn-save">Save Corrected Transcript</button>
        <button class="btn btn-secondary" id="btn-dismiss">Looks Good, Dismiss</button>
      </div>
      <p class="success-msg" id="success-msg">Corrected transcript saved!</p>
    `;

    // Transcript preview (first 30 segments)
    const previewSegments = transcript.slice(0, 30);
    html += `
      <div class="transcript-section">
        <h2>Transcript Preview${transcript.length > 30 ? ` (first 30 of ${transcript.length})` : ""}</h2>
    `;

    for (const seg of previewSegments) {
      const time = seg.timestamp
        ? new Date(seg.timestamp).toLocaleTimeString("en-US", {
            hour: "numeric",
            minute: "2-digit",
          })
        : "";
      const confidence = seg.confidence || 1;
      const lowConf = confidence < 0.3 ? " low-confidence" : "";

      html += `
        <div class="segment${lowConf}" data-speaker="${seg.speaker}">
          <div class="segment-header">
            <span class="segment-speaker">${seg.speaker}</span>
            ${time ? `<span class="segment-time">(${time})</span>` : ""}
          </div>
          <div class="segment-text">${seg.text}</div>
        </div>
      `;
    }

    html += `</div>`;

    contentEl.innerHTML = html;

    // Wire up buttons
    document.getElementById("btn-save").addEventListener("click", () => {
      saveWithCorrections(transcript, meetingInfo);
    });

    document.getElementById("btn-dismiss").addEventListener("click", () => {
      window.close();
    });

    // Live preview: update transcript preview when speaker names change
    const inputs = document.querySelectorAll(".speaker-input");
    inputs.forEach((input) => {
      input.addEventListener("input", () => {
        const original = input.dataset.original;
        const newName = input.value.trim() || original;
        // Update preview
        const segs = document.querySelectorAll(
          `.segment[data-speaker="${original}"] .segment-speaker`
        );
        segs.forEach((el) => {
          el.textContent = newName;
        });
      });
    });
  }

  function saveWithCorrections(transcript, meetingInfo) {
    // Build speaker rename map
    const renameMap = {};
    document.querySelectorAll(".speaker-input").forEach((input) => {
      const original = input.dataset.original;
      const newName = input.value.trim();
      if (newName && newName !== original) {
        renameMap[original] = newName;
      }
    });

    // Apply renames
    const corrected = transcript.map((seg) => ({
      ...seg,
      speaker: renameMap[seg.speaker] || seg.speaker,
    }));

    // Update participants
    const correctedInfo = {
      ...meetingInfo,
      participants: [
        ...new Set(corrected.map((s) => s.speaker)),
      ],
    };

    // Send to background for re-save
    chrome.runtime.sendMessage({
      type: "downloadTranscript",
      transcript: corrected,
      meetingInfo: correctedInfo,
    });

    // Show success
    const btn = document.getElementById("btn-save");
    const msg = document.getElementById("success-msg");
    btn.disabled = true;
    btn.textContent = "Saved!";
    msg.style.display = "block";

    setTimeout(() => {
      btn.disabled = false;
      btn.textContent = "Save Corrected Transcript";
    }, 3000);
  }
});
