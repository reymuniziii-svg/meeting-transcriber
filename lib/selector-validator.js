/**
 * Selector validation utility.
 * Checks if critical DOM selectors are still valid on each platform.
 * Logs warnings if selectors appear broken so users know to update.
 */

const SelectorValidator = (() => {
  const VALIDATION_ATTEMPTS = 3;
  const VALIDATION_INTERVAL_MS = 10000;

  /**
   * Validate that critical selectors find elements in the DOM.
   * @param {string} platform - Platform name for logging
   * @param {Object} selectors - { name: cssSelector } pairs to check
   * @param {Document} doc - Document to query (default: document)
   */
  function validate(platform, selectors, doc = document) {
    let attempt = 0;
    const attemptsByGroup = new Map();

    const runAttempt = () => {
      attempt += 1;
      const results = [];

      for (const [name, selectorConfig] of Object.entries(selectors)) {
        const config = normalizeSelectorConfig(selectorConfig);
        const found = selectorGroupFound(config.selectors, doc);
        const history = attemptsByGroup.get(name) || [];
        history.push(found);
        attemptsByGroup.set(name, history);

        results.push({
          name,
          found,
          optional: config.optional,
        });
      }

      if (attempt < VALIDATION_ATTEMPTS) {
        setTimeout(runAttempt, VALIDATION_INTERVAL_MS);
        return;
      }

      const failedRequiredGroups = results.filter((result) => {
        if (result.optional) {
          return false;
        }
        const history = attemptsByGroup.get(result.name) || [];
        return history.every((found) => !found);
      });

      if (failedRequiredGroups.length === 0) {
        console.log(`[MeetingTranscriber] ✓ ${platform} selector checks passed.`);
        return;
      }

      console.warn(`[MeetingTranscriber] Selector validation for ${platform}:`);
      for (const result of results) {
        const history = attemptsByGroup.get(result.name) || [];
        const status = history.some(Boolean) ? "✓" : "✗";
        console.warn(`  ${status} ${result.name}`);
      }
      console.warn(
        `  ${failedRequiredGroups.length} selector group(s) failed every check across ${VALIDATION_ATTEMPTS} attempts.`
      );
      console.warn("  See docs/selector-maintenance.md");

      try {
        chrome.runtime.sendMessage({
          type: "selectorWarning",
          platform,
          failures: failedRequiredGroups.length,
          details: failedRequiredGroups.map((result) => result.name),
        });
      } catch (error) {
        // Extension context may be invalid.
      }
    };

    setTimeout(runAttempt, VALIDATION_INTERVAL_MS);
  }

  return { validate };
})();

function normalizeSelectorConfig(selectorConfig) {
  if (
    selectorConfig &&
    typeof selectorConfig === "object" &&
    !Array.isArray(selectorConfig) &&
    Object.prototype.hasOwnProperty.call(selectorConfig, "selectors")
  ) {
    return {
      selectors: Array.isArray(selectorConfig.selectors)
        ? selectorConfig.selectors
        : [selectorConfig.selectors],
      optional: Boolean(selectorConfig.optional),
    };
  }

  return {
    selectors: Array.isArray(selectorConfig) ? selectorConfig : [selectorConfig],
    optional: false,
  };
}

function selectorGroupFound(selectors, doc) {
  for (const selector of selectors) {
    try {
      if (doc.querySelector(selector)) {
        return true;
      }
    } catch (error) {
      // Ignore invalid selectors and continue to fallbacks.
    }
  }

  return false;
}
