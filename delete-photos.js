(async function () {
  "use strict";

  const CONFIG = {
    batchLimit: 200,        // cap per delete action; huge selections are what trigger Google's failures
    clickDelay: 20,         // ms between checkbox clicks (DOM churns while you click)
    timeout: 30000,
    emptyScrollLimit: 8,    // consecutive empty scroll+wait cycles before declaring victory
    backoff: { base: 5000, max: 300000 }, // 5s doubling up to 5min on any failure
    selectors: {
      checkbox: ".ckGgle[aria-checked=false]",
      selectedCheckbox: ".ckGgle[aria-checked=true]",
      deleteButton: 'button[aria-label="Move to trash"]',
    },
  };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const log = (msg, style = "") =>
    console.log(`%c[${new Date().toLocaleTimeString()}] ${msg}`, style);

  async function waitUntil(condition, description, timeout = CONFIG.timeout) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const result = condition();
      if (result && (result.nodeType || result.length > 0 || result === true)) {
        return result;
      }
      await sleep(250);
    }
    throw new Error(`timeout waiting for ${description}`);
  }

  function pressEscape() {
    for (const type of ["keydown", "keyup"]) {
      document.dispatchEvent(
        new KeyboardEvent(type, {
          key: "Escape", code: "Escape", keyCode: 27, which: 27, bubbles: true,
        })
      );
    }
  }

  function visibleCheckboxes() {
    return Array.from(
      document.querySelectorAll(CONFIG.selectors.checkbox)
    ).filter((el) => el.offsetParent !== null);
  }

  function selectedCount() {
    return document.querySelectorAll(CONFIG.selectors.selectedCheckbox).length;
  }

  // Recovery: close any open dialog, then clear any partial selection.
  async function resetState() {
    pressEscape();
    await sleep(400);
    pressEscape();
    await sleep(600);
  }

  async function selectBatch() {
    const boxes = visibleCheckboxes().slice(0, CONFIG.batchLimit);
    for (const box of boxes) {
      try {
        box.click();
      } catch (e) {
        /* node was recycled by the virtualized grid; ignore */
      }
      await sleep(CONFIG.clickDelay);
    }
    await sleep(600);
    return selectedCount();
  }

  async function deleteSelected() {
    const trashBtn = await waitUntil(
      () => document.querySelector(CONFIG.selectors.deleteButton),
      "trash button",
      10000
    );
    trashBtn.click();

    // Match "Move to trash" or "Move to bin" (locale-safe), inside the dialog.
    const confirmBtn = await waitUntil(
      () =>
        Array.from(document.querySelectorAll("button")).find((b) => {
          const t = b.textContent.trim().toLowerCase();
          return t.startsWith("move to") && (t.includes("trash") || t.includes("bin"));
        }),
      "confirmation button",
      10000
    );
    confirmBtn.click();

    // Success signal: the selected checkboxes disappear from the DOM.
    await waitUntil(
      () => selectedCount() === 0,
      "selection to clear after delete",
      25000
    );
  }

  async function run() {
    let total = 0;
    let failures = 0;
    let emptyScrolls = 0;

    log("--- Google Photos Deleter (robust) ---", "color:#4CAF50;font-size:14px;font-weight:bold");
    console.warn("Keep this tab FOCUSED and VISIBLE. Chrome heavily throttles timers in background tabs, which stalls scripts like this.");

    while (true) {
      try {
        window.scrollTo(0, 0); // new photos backfill from the top after each delete
        await sleep(800);

        const count = await selectBatch();

        if (count === 0) {
          // Grid may just not have rendered yet (virtualized list). Nudge it.
          emptyScrolls++;
          if (emptyScrolls >= CONFIG.emptyScrollLimit) {
            log("No photos found after repeated scroll attempts. Library appears empty — check Trash to confirm.", "color:#4CAF50;font-weight:bold");
            break;
          }
          log(`Nothing selectable yet, scrolling to trigger load (${emptyScrolls}/${CONFIG.emptyScrollLimit})...`, "color:#9E9E9E");
          window.scrollBy(0, window.innerHeight * 2);
          await sleep(2500);
          continue;
        }
        emptyScrolls = 0;

        log(`Selected ${count} photos. Deleting...`);
        await deleteSelected();

        total += count;
        failures = 0;
        log(`Batch done. Total moved to trash: ${total}`, "color:#4CAF50");

        await sleep(1500); // breathe between batches; stay under the rate limiter
      } catch (err) {
        failures++;
        const wait = Math.min(
          CONFIG.backoff.base * 2 ** (failures - 1),
          CONFIG.backoff.max
        );
        log(
          `Hiccup: ${err.message}. Resetting and backing off ${Math.round(wait / 1000)}s (consecutive failure #${failures}).`,
          "color:#FFC107"
        );
        await resetState();
        await sleep(wait);
        // No break — we never give up, we just slow down.
      }
    }

    log(`Finished. ~${total} photos moved to trash.`, "color:#4CAF50;font-size:14px;font-weight:bold");
  }

  await run();
})();
