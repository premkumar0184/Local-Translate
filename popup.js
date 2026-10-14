const translateButton = document.getElementById("translate");
const translateBtnText = document.getElementById("translate-btn-text");
const restoreButton = document.getElementById("restore");
const restoreBtnText = document.getElementById("restore-btn-text");

const serverBadge = document.getElementById("server-badge");
const serverDot = document.getElementById("server-dot");
const serverStatusText = document.getElementById("server-status-text");

const settingsToggleBtn = document.getElementById("settings-toggle-btn");
const settingsPanel = document.getElementById("settings-panel");
const settingsSavedTag = document.getElementById("settings-saved-tag");
const settingPreset = document.getElementById("setting-preset");
const settingThreads = document.getElementById("setting-threads");
const settingBatchLimit = document.getElementById("setting-batch-limit");
const tuningBadge = document.getElementById("tuning-badge");
const tuningImpactText = document.getElementById("tuning-impact-text");
const tuningConfigCode = document.getElementById("tuning-config-code");
const tuningMemoryText = document.getElementById("tuning-memory-text");
const settingsResetBtn = document.getElementById("settings-reset-btn");
const settingsCloseBtn = document.getElementById("settings-close-btn");

const progressContainer = document.getElementById("progress-container");
const progressBarFill = document.getElementById("progress-bar-fill");
const progressLabel = document.getElementById("progress-label");
const progressPercent = document.getElementById("progress-percent");

const statusPanel = document.getElementById("status-panel");
const statusMessage = document.getElementById("status-message");
const statusStats = document.getElementById("status-stats");

let isServerOnline = false;

// Hardware acceleration & tuning configuration presets
const PRESETS = {
  "cpu-default": {
    name: "CPU Standard",
    badge: "Balanced",
    threads: 4,
    batchSize: 40,
    impact: "Balanced CPU performance for standard browsing.",
    config: "--threads 4",
    memory: "~1.5 GB base RAM + ~200 MB per loaded language model"
  },
  "cpu-tuned": {
    name: "CPU Multi-Core",
    badge: "Multi-Core",
    threads: 8,
    batchSize: 100,
    impact: "Prevents bottle-necking during batch translation requests.",
    config: "--threads 8 --batch-limit 100",
    memory: "Smooth operation on machines with 8 GB+ RAM"
  },
  "gpu-docker": {
    name: "NVIDIA GPU (Docker)",
    badge: "5x-15x GPU",
    threads: 4,
    batchSize: 100,
    impact: "5x to 15x inference speedup on CUDA-capable GPUs.",
    config: "docker run --gpus all ... --batch-limit 100",
    memory: "Automatic CTranslate2 CUDA inference via NVIDIA Toolkit"
  },
  "gpu-python": {
    name: "NVIDIA GPU (Python)",
    badge: "PyTorch CUDA",
    threads: 4,
    batchSize: 100,
    impact: "Automatic CTranslate2 CUDA inference in Python venv.",
    config: "Install CUDA-enabled PyTorch in venv",
    memory: "Optimizes matrix throughput directly with CUDA"
  },
  "eco-memory": {
    name: "Low Memory Mode",
    badge: "Low RAM",
    threads: 2,
    batchSize: 25,
    impact: "Minimizes background memory pressure on budget machines.",
    config: "--threads 2 --batch-limit 25",
    memory: "~1.5 GB base RAM (recommended for <= 8 GB RAM)"
  },
  "custom": {
    name: "Custom Tuning",
    badge: "Custom",
    threads: 4,
    batchSize: 40,
    impact: "Custom user-configured thread concurrency and batch limits.",
    config: "User-defined configuration",
    memory: "Dynamic system allocation"
  }
};

const DEFAULT_SETTINGS = {
  preset: "cpu-default",
  threads: 4,
  batchSize: 40
};

let currentSettings = { ...DEFAULT_SETTINGS };
let saveTimeout = null;

function updateTuningCard() {
  const presetKey = currentSettings.preset in PRESETS ? currentSettings.preset : "custom";
  const p = PRESETS[presetKey];
  if (!p) return;

  if (tuningBadge) tuningBadge.textContent = p.badge;
  if (tuningImpactText) tuningImpactText.textContent = p.impact;
  if (tuningConfigCode) {
    tuningConfigCode.textContent = presetKey === "custom"
      ? `--threads ${currentSettings.threads} --batch-limit ${currentSettings.batchSize}`
      : p.config;
  }
  if (tuningMemoryText) tuningMemoryText.textContent = p.memory;
}

function applySettingsToUI() {
  if (settingPreset) settingPreset.value = currentSettings.preset || "cpu-default";
  if (settingThreads) settingThreads.value = String(currentSettings.threads || 4);
  if (settingBatchLimit) settingBatchLimit.value = String(currentSettings.batchSize || 40);
  updateTuningCard();
}

function showSavedIndicator() {
  if (!settingsSavedTag) return;
  settingsSavedTag.hidden = false;
  clearTimeout(saveTimeout);
  saveTimeout = setTimeout(() => {
    settingsSavedTag.hidden = true;
  }, 1200);
}

async function saveSettings() {
  try {
    if (typeof chrome !== "undefined" && chrome?.storage?.local?.set) {
      await chrome.storage.local.set({ translatorSettings: currentSettings });
    }
    if (typeof localStorage !== "undefined") {
      localStorage.setItem("libreTranslatorSettings", JSON.stringify(currentSettings));
    }
    showSavedIndicator();
  } catch (err) {
    console.warn("Could not save settings:", err);
  }
}

async function loadSettings() {
  try {
    if (typeof chrome !== "undefined" && chrome?.storage?.local?.get) {
      const data = await chrome.storage.local.get(["translatorSettings"]);
      if (data?.translatorSettings) {
        currentSettings = { ...DEFAULT_SETTINGS, ...data.translatorSettings };
      }
    } else if (typeof localStorage !== "undefined") {
      const saved = localStorage.getItem("libreTranslatorSettings");
      if (saved) {
        currentSettings = { ...DEFAULT_SETTINGS, ...JSON.parse(saved) };
      }
    }
  } catch {
    currentSettings = { ...DEFAULT_SETTINGS };
  }
  applySettingsToUI();
}

function checkIfPresetMatchesCustom() {
  let matched = "custom";
  for (const [key, val] of Object.entries(PRESETS)) {
    if (key !== "custom" && val.threads === currentSettings.threads && val.batchSize === currentSettings.batchSize) {
      if (currentSettings.preset === key) {
        matched = key;
        break;
      }
      if (matched === "custom") matched = key;
    }
  }
  currentSettings.preset = matched;
  if (settingPreset) settingPreset.value = matched;
}

function toggleSettings(force) {
  if (!settingsPanel) return;
  const shouldOpen = typeof force === "boolean" ? force : settingsPanel.hidden;
  settingsPanel.hidden = !shouldOpen;
  if (settingsToggleBtn) {
    settingsToggleBtn.classList.toggle("active", shouldOpen);
    settingsToggleBtn.setAttribute("aria-expanded", String(shouldOpen));
  }
}

if (settingsToggleBtn) {
  settingsToggleBtn.addEventListener("click", () => toggleSettings());
}

if (settingsCloseBtn) {
  settingsCloseBtn.addEventListener("click", () => toggleSettings(false));
}

if (settingsResetBtn) {
  settingsResetBtn.addEventListener("click", () => {
    currentSettings = { ...DEFAULT_SETTINGS };
    applySettingsToUI();
    saveSettings();
  });
}

if (settingPreset) {
  settingPreset.addEventListener("change", () => {
    const selected = settingPreset.value;
    if (selected !== "custom" && PRESETS[selected]) {
      currentSettings.preset = selected;
      currentSettings.threads = PRESETS[selected].threads;
      currentSettings.batchSize = PRESETS[selected].batchSize;
      if (settingThreads) settingThreads.value = String(currentSettings.threads);
      if (settingBatchLimit) settingBatchLimit.value = String(currentSettings.batchSize);
    } else {
      currentSettings.preset = "custom";
    }
    updateTuningCard();
    saveSettings();
  });
}

if (settingThreads) {
  settingThreads.addEventListener("change", () => {
    currentSettings.threads = parseInt(settingThreads.value, 10) || 4;
    checkIfPresetMatchesCustom();
    updateTuningCard();
    saveSettings();
  });
}

if (settingBatchLimit) {
  settingBatchLimit.addEventListener("change", () => {
    currentSettings.batchSize = parseInt(settingBatchLimit.value, 10) || 40;
    checkIfPresetMatchesCustom();
    updateTuningCard();
    saveSettings();
  });
}

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

async function sendToPage(action, payload = {}) {
  const tab = await getActiveTab();
  await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
  return chrome.tabs.sendMessage(tab.id, { action, ...payload });
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
    const isModelError = error?.message?.includes("English model");
    const errorMsg = isModelError
      ? "English model ('en') is not installed in LibreTranslate. Install with: argospm install translate-..._en"
      : "Cannot reach LibreTranslate at 127.0.0.1:5000. Start server: docker compose up -d";
    translateButton.title = isModelError ? "English target model missing" : "Local LibreTranslate server is offline";
    setStatus(errorMsg, "error");
    return false;
  }
}

function isRestrictedUrl(url) {
  if (!url) return true;
  const restrictedProtocols = [
    "chrome:", "edge:", "brave:", "opera:", "vivaldi:", "about:",
    "chrome-extension:", "devtools:", "view-source:", "data:"
  ];
  return restrictedProtocols.some((proto) => url.startsWith(proto)) ||
         url.startsWith("https://chromewebstore.google.com") ||
         url.startsWith("https://microsoftedge.microsoft.com/addons");
}

async function syncPageState() {
  let tab;
  try {
    tab = await getActiveTab();
  } catch {
    setStatus("No active browser tab found.", "idle");
    return;
  }

  if (isRestrictedUrl(tab.url)) {
    translateButton.disabled = true;
    translateButton.title = "Internal browser and restricted pages cannot be translated";
    restoreButton.disabled = true;
    setStatus(
      "Restricted page: Browser internal pages (e.g. settings/extensions) cannot be translated. Open any regular website to use.",
      "idle"
    );
    return;
  }

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
    if (isServerOnline) {
      setStatus("Local server is ready. Click Translate or press Alt+Shift+W.", "idle");
    }
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
    const result = await sendToPage("translatePage", { settings: currentSettings });
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
  if (navigator.platform?.includes("Mac") || navigator.userAgent?.includes("Mac")) {
    const shortcutMod = document.getElementById("shortcut-mod");
    if (shortcutMod) shortcutMod.textContent = "Option";
  }
  await loadSettings();
  const online = await checkServer();
  if (online) {
    await syncPageState();
  }
})();
