/**
 * Selector validation utility.
 * Checks if critical DOM selectors are still valid on each platform.
 * Logs warnings if selectors appear broken so users know to update.
 */

const SelectorValidator = (() => {
  const VALIDATION_DELAY_MS = 10000; // Check 10s after meeting detected

  /**
   * Validate that critical selectors find elements in the DOM.
   * @param {string} platform - Platform name for logging
   * @param {Object} selectors - { name: cssSelector } pairs to check
   * @param {Document} doc - Document to query (default: document)
   */
  function validate(platform, selectors, doc = document) {
    setTimeout(() => {
      const results = [];
      let failures = 0;

      for (const [name, selector] of Object.entries(selectors)) {
        // Handle array of selectors (fallbacks)
        const selectorList = Array.isArray(selector) ? selector : [selector];
        let found = false;

        for (const sel of selectorList) {
          try {
            if (doc.querySelector(sel)) {
              found = true;
              break;
            }
          } catch (e) {
            // Invalid selector
          }
        }

        results.push({ name, found });
        if (!found) failures++;
      }

      if (failures > 0) {
        console.warn(
          `[MeetingTranscriber] ⚠ Selector validation for ${platform}:`
        );
        for (const r of results) {
          const icon = r.found ? "✓" : "✗";
          console.warn(`  ${icon} ${r.name}`);
        }
        console.warn(
          `  ${failures} selector(s) not found. The ${platform} UI may have changed.`
        );
        console.warn(
          "  Transcription may be incomplete. See docs/selector-maintenance.md"
        );

        // Notify background to show warning badge
        try {
          chrome.runtime.sendMessage({
            type: "selectorWarning",
            platform,
            failures,
            details: results.filter((r) => !r.found).map((r) => r.name),
          });
        } catch (e) {
          // Extension context may be invalid
        }
      } else {
        console.log(
          `[MeetingTranscriber] ✓ All ${platform} selectors validated.`
        );
      }
    }, VALIDATION_DELAY_MS);
  }

  return { validate };
})();
