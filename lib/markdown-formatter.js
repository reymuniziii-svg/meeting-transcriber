/**
 * Formats transcript data into clean markdown.
 */

function formatTranscriptAsMarkdown(transcript, meetingInfo) {
  const date = meetingInfo.startTime
    ? new Date(meetingInfo.startTime)
    : new Date();
  const dateStr = date.toLocaleDateString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
  const startTimeStr = date.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
  });
  const participants = (meetingInfo.participants || []).join(", ") || "Unknown";
  const duration = meetingInfo.duration
    ? `${meetingInfo.duration} minutes`
    : "Unknown";

  let md = `# Meeting Transcript\n\n`;
  md += `- **Date**: ${dateStr}\n`;
  md += `- **Time**: ${startTimeStr}\n`;
  md += `- **Platform**: ${meetingInfo.platform || "Unknown"}\n`;
  md += `- **Title**: ${meetingInfo.title || "Untitled Meeting"}\n`;
  md += `- **Duration**: ${duration}\n`;
  md += `- **Participants**: ${participants}\n`;
  md += `\n---\n\n`;
  md += `## Transcript\n\n`;

  if (!transcript || transcript.length === 0) {
    md += `*No transcript captured.*\n`;
    return md;
  }

  for (const entry of transcript) {
    const time = entry.timestamp
      ? new Date(entry.timestamp).toLocaleTimeString("en-US", {
          hour: "numeric",
          minute: "2-digit",
        })
      : "";
    const timeStr = time ? ` (${time})` : "";
    md += `**${entry.speaker}**${timeStr}\n`;
    md += `${entry.text}\n\n`;
  }

  return md;
}

/**
 * Generate a filename for the transcript
 */
function generateFilename(meetingInfo) {
  const date = meetingInfo.startTime
    ? new Date(meetingInfo.startTime)
    : new Date();
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  const hh = String(date.getHours()).padStart(2, "0");
  const min = String(date.getMinutes()).padStart(2, "0");

  const platform = (meetingInfo.platform || "meeting").toLowerCase().replace(/\s+/g, "-");
  const title = (meetingInfo.title || "untitled")
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .substring(0, 50);

  return `Meeting Transcripts/${yyyy}-${mm}-${dd}_${hh}-${min}_${platform}_${title}.md`;
}
