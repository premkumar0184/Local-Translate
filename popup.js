const translateButton = document.getElementById("translate");
const translateBtnText = document.getElementById("translate-btn-text");
const restoreButton = document.getElementById("restore");
const restoreBtnText = document.getElementById("restore-btn-text");

const serverBadge = document.getElementById("server-badge");
const serverDot = document.getElementById("server-dot");
const serverStatusText = document.getElementById("server-status-text");

const progressContainer = document.getElementById("progress-container");
const progressBarFill = document.getElementById("progress-bar-fill");
const progressLabel = document.getElementById("progress-label");
const progressPercent = document.getElementById("progress-percent");

const statusPanel = document.getElementById("status-panel");
const statusMessage = document.getElementById("status-message");
const statusStats = document.getElementById("status-stats");

let isServerOnline = false;

function setStatus(message, state = "idle", stats = []) {
  statusPanel.className = `status-panel panel-${state}`;
  statusMessage.textContent = message;

  if (stats.length > 0) {
    statusStats.hidden = false;
    statusStats.innerHTML = stats
      .map((s) => `<span class="stats-chip">${s}</span>`)
      .join("");
  } else {
    statusStats.hidden = true;
    statusStats.innerHTML = "";
  }
}

function updateProgress(percent, label) {
  progressContainer.hidden = false;
  progressBarFill.style.width = `${Math.min(100, Math.max(0, percent))}%`;
  progressPercent.textContent = `${Math.round(percent)}%`;
  if (label) progressLabel.textContent = label;
}

function hideProgress() {
  progressContainer.hidden = true;
  progressBarFill.style.width = "0%";
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab?.id) throw new Error("Could not locate active tab.");
  return tab;
}

async function sendToPage(action) {
  const tab = await getActiveTab();
  await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
  return chrome.tabs.sendMessage(tab.id, { action });
}

async function checkServer() {
  serverDot.className = "status-dot dot-checking";
  serverStatusText.textContent = "Checking…";

  const startTime = performance.now();
  try {
    const response = await fetch("http://127.0.0.1:5000/languages", {
      signal: AbortSignal.timeout(2500)
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const languages = await response.json();
    const codes = new Set(languages.map((l) => l.code));
    if (!codes.has("en")) throw new Error("English model is not installed.");

    const latency = Math.max(1, Math.round(performance.now() - startTime));
    isServerOnline = true;
    serverDot.className = "status-dot dot-online";
    serverStatusText.textContent = `Ready · ${latency}ms`;
    translateButton.disabled = false;
    translateButton.removeAttribute("title");
    return true;
  } catch (error) {
    isServerOnline = false;
    serverDot.className = "status-dot dot-offline";
    serverStatusText.textContent = "Offline";
    translateButton.disabled = true;
    translateButton.title = "Local LibreTranslate server is offline";
    setStatus(
      "Cannot reach LibreTranslate at 127.0.0.1:5000. Start server: sudo docker start libretranslate",
      "error"
    );
    return false;
  }
}

async function syncPageState() {
  try {
    const state = await sendToPage("getState");
    if (!state?.ok) return;

    if (state.busy) {
      translateButton.disabled = true;
      translateBtnText.textContent = "Translating…";
      restoreButton.disabled = false;
      restoreBtnText.textContent = "Cancel";
      updateProgress(45, "Translating page in background…");
      setStatus("Translation is running on this page…", "idle");
    } else if (state.translatedCount > 0) {
      restoreButton.disabled = false;
      restoreBtnText.textContent = "Restore original";
      if (state.lastStats) {
        const s = state.lastStats;
        const stats = [
          `${s.translatedCount} fragments`,
          `${s.uniqueCount} unique phrases`
        ];
        if (s.savedByDedup > 0) stats.push(`${s.savedByDedup} deduplicated`);
        setStatus("Page is translated to English.", "success", stats);
      } else {
        setStatus(`Page is translated (${state.translatedCount} fragments).`, "success");
      }
    } else if (isServerOnline) {
      setStatus("Local server is ready. Click Translate or press Alt+Shift+W.", "idle");
    }
  } catch {
    // Restricted or inactive browser tab
  }
}

serverBadge.addEventListener("click", async () => {
  const online = await checkServer();
  if (online) {
    syncPageState();
  }
});

translateButton.addEventListener("click", async () => {
  if (!isServerOnline) return;

  translateButton.disabled = true;
  translateBtnText.textContent = "Translating…";
  restoreButton.disabled = false;
  restoreBtnText.textContent = "Cancel";

  updateProgress(5, "Scanning page text…");
  setStatus("Extracting translatable text and prioritizing visible content…", "idle");

  const startTime = performance.now();
  try {
    const result = await sendToPage("translatePage");
    const duration = ((performance.now() - startTime) / 1000).toFixed(1);

    if (result?.ok) {
      updateProgress(100, "Translation complete");
      setTimeout(hideProgress, 800);

      const stats = [
        `${result.translatedCount} fragments`,
        `${result.uniqueCount} unique phrases`,
        `${duration}s`
      ];
      if (result.savedByDedup > 0) {
        stats.push(`${result.savedByDedup} deduplicated`);
      }

      setStatus(`Done! Page translated to English in ${duration}s.`, "success", stats);
    } else if (result?.aborted) {
      hideProgress();
      setStatus("Translation was cancelled.", "idle");
    } else if (result?.partial) {
      setTimeout(hideProgress, 800);
      setStatus(
        `Partially translated (${result.translatedCount}/${result.total} fragments). ${result.error}`,
        "error"
      );
    } else {
      hideProgress();
      setStatus(result?.error || "Translation failed.", "error");
    }
  } catch (error) {
    hideProgress();
    setStatus(
      `Could not translate this page: ${error?.message || String(error)}. Restricted browser pages cannot be translated.`,
      "error"
    );
  } finally {
    translateBtnText.textContent = "Translate to English";
    restoreBtnText.textContent = "Restore original";
    translateButton.disabled = !isServerOnline;
    syncPageState();
  }
});

restoreButton.addEventListener("click", async () => {
  const wasTranslating = restoreBtnText.textContent === "Cancel";
  translateButton.disabled = true;
  restoreButton.disabled = true;
  hideProgress();

  if (wasTranslating) {
    setStatus("Cancelling translation and restoring original text…", "idle");
  } else {
    setStatus("Restoring original text…", "idle");
  }

  try {
    const result = await sendToPage("restoreOriginals");
    if (result?.ok) {
      setStatus(`Restored ${result.restored} text fragments to original text.`, "idle");
    } else {
      setStatus(result?.error || "Restore failed.", "error");
    }
  } catch (error) {
    setStatus(`Could not restore page: ${error?.message || String(error)}.`, "error");
  } finally {
    translateBtnText.textContent = "Translate to English";
    restoreBtnText.textContent = "Restore original";
    translateButton.disabled = !isServerOnline;
    restoreButton.disabled = false;
    syncPageState();
  }
});

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "translatorProgress") {
    const { doneUnique, totalUnique, updatedNodes, totalNodes } = message;
    const percent = totalUnique > 0 ? (doneUnique / totalUnique) * 100 : 0;
    updateProgress(
      percent,
      `Translating… ${doneUnique}/${totalUnique} phrases (${updatedNodes} nodes)`
    );
  }
});

// Initialization
(async () => {
  const online = await checkServer();
  if (online) {
    await syncPageState();
  }
})();
