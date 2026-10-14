const API_BASE = "http://127.0.0.1:5000";
const CACHE_MAX = 2000;
const translationCache = new Map();
const inFlight = new Map();

function getCached(text) {
  if (!translationCache.has(text)) return undefined;
  const val = translationCache.get(text);
  translationCache.delete(text);
  translationCache.set(text, val);
  return val;
}

function setCache(text, val) {
  if (typeof val !== "string" || !val) return;
  if (translationCache.has(text)) {
    translationCache.delete(text);
  } else if (translationCache.size >= CACHE_MAX) {
    const oldestKey = translationCache.keys().next().value;
    translationCache.delete(oldestKey);
  }
  translationCache.set(text, val);
}

async function requestTranslation(texts, format = "html") {
  let response;
  try {
    response = await fetch(`${API_BASE}/translate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        q: texts,
        source: "auto",
        target: "en",
        format: format || "html"
      }),
      signal: AbortSignal.timeout(150000)
    });
  } catch (err) {
    if (err?.name === "TimeoutError") {
      throw new Error("Translation request timed out (150s). Local LibreTranslate server may be overloaded.");
    }
    throw new Error("Cannot reach LibreTranslate at 127.0.0.1:5000. Please ensure the local server is running.");
  }

  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error(`LibreTranslate returned an invalid response (HTTP ${response.status}).`);
  }

  if (!response.ok) {
    throw new Error(payload?.error || `LibreTranslate request failed (HTTP ${response.status}).`);
  }

  const result = payload?.translatedText;
  if (Array.isArray(result)) {
    if (result.length !== texts.length) {
      throw new Error(`LibreTranslate count mismatch (expected ${texts.length}, got ${result.length}).`);
    }
    return result;
  }
  if (typeof result === "string" && texts.length === 1) return [result];
  throw new Error("LibreTranslate returned an unexpected batch response structure.");
}

async function translateBatch(texts, format = "html") {
  if (!Array.isArray(texts) || texts.length === 0) return [];

  const results = new Array(texts.length);
  const uncachedMap = new Map();
  const waitingPromises = [];

  for (let i = 0; i < texts.length; i++) {
    const text = texts[i];
    const cached = getCached(text);
    if (cached !== undefined) {
      results[i] = cached;
    } else if (inFlight.has(text)) {
      const p = inFlight.get(text).then((trans) => {
        results[i] = trans;
      });
      waitingPromises.push(p);
    } else {
      let list = uncachedMap.get(text);
      if (!list) {
        list = [];
        uncachedMap.set(text, list);
      }
      list.push(i);
    }
  }

  const uniqueUncached = Array.from(uncachedMap.keys());
  if (uniqueUncached.length > 0) {
    const resolvers = new Map();
    for (const key of uniqueUncached) {
      let resolve, reject;
      const promise = new Promise((res, rej) => {
        resolve = res;
        reject = rej;
      });
      promise.catch(() => {});
      inFlight.set(key, promise);
      resolvers.set(key, { resolve, reject });
    }

    try {
      const translated = await requestTranslation(uniqueUncached, format);
      for (let j = 0; j < uniqueUncached.length; j++) {
        const orig = uniqueUncached[j];
        const trans = translated[j];
        setCache(orig, trans);
        resolvers.get(orig)?.resolve(trans);
        const indices = uncachedMap.get(orig);
        for (const idx of indices) {
          results[idx] = trans;
        }
      }
    } catch (err) {
      for (const key of uniqueUncached) {
        resolvers.get(key)?.reject(err);
      }
      throw err;
    } finally {
      for (const key of uniqueUncached) {
        inFlight.delete(key);
      }
    }
  }

  if (waitingPromises.length > 0) {
    await Promise.all(waitingPromises);
  }

  return results;
}

if (typeof chrome !== "undefined" && chrome?.runtime?.onMessage) {
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.action === "translateBatch") {
      translateBatch(message.texts, message.format || "html")
        .then((translations) => sendResponse({ ok: true, translations }))
        .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
      return true;
    }
  });
}

const CONTEXT_MENU_ID = "translate-to-english";

function isRestrictedUrl(url) {
  if (!url) return false;
  const restrictedProtocols = [
    "chrome:", "edge:", "brave:", "opera:", "vivaldi:", "about:",
    "chrome-extension:", "devtools:", "view-source:", "data:"
  ];
  return (
    restrictedProtocols.some((proto) => url.startsWith(proto)) ||
    url.startsWith("https://chromewebstore.google.com") ||
    url.startsWith("https://microsoftedge.microsoft.com/addons")
  );
}

function isValidTabId(id) {
  return typeof id === "number" && Number.isInteger(id) && id > 0;
}

function setupContextMenu(callback) {
  if (typeof chrome === "undefined" || !chrome?.contextMenus?.create) {
    if (typeof callback === "function") callback();
    return;
  }

  const createItem = () => {
    try {
      chrome.contextMenus.create({
        id: CONTEXT_MENU_ID,
        title: "Translate to English",
        contexts: ["page", "selection"]
      }, () => {
        if (chrome.runtime?.lastError) {
          // Suppress unchecked runtime.lastError if item already exists upon reload
        }
        if (typeof callback === "function") callback();
      });
    } catch (err) {
      console.warn("Could not register context menu:", err);
      if (typeof callback === "function") callback();
    }
  };

  try {
    if (typeof chrome?.contextMenus?.removeAll === "function") {
      chrome.contextMenus.removeAll(() => {
        if (chrome.runtime?.lastError) {
          // Suppress unchecked runtime.lastError
        }
        createItem();
      });
    } else {
      createItem();
    }
  } catch (err) {
    console.warn("Could not remove existing context menus:", err);
    createItem();
  }
}

async function getStoredSettings() {
  if (typeof chrome !== "undefined" && chrome?.storage?.local?.get) {
    try {
      const data = await chrome.storage.local.get(["translatorSettings"]);
      return data?.translatorSettings || null;
    } catch {
      return null;
    }
  }
  return null;
}

async function getTargetTab(tab) {
  if (isValidTabId(tab?.id)) return tab;
  if (typeof chrome !== "undefined" && chrome?.tabs?.query) {
    const [activeTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    return isValidTabId(activeTab?.id) ? activeTab : null;
  }
  return null;
}

async function translateTab(targetTab = null) {
  try {
    const tab = await getTargetTab(targetTab);
    if (!tab || !isValidTabId(tab.id)) return null;
    if (tab.url && isRestrictedUrl(tab.url)) return null;

    if (typeof chrome !== "undefined" && chrome?.scripting?.executeScript) {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ["content.js"]
      });
    }

    const settings = await getStoredSettings();
    if (typeof chrome !== "undefined" && chrome?.tabs?.sendMessage) {
      const payload = { action: "translatePage" };
      if (settings) {
        payload.settings = settings;
      }
      return await chrome.tabs.sendMessage(tab.id, payload);
    }
    return null;
  } catch (error) {
    console.warn("Could not translate this tab:", error);
    return null;
  }
}

async function handleContextMenuClick(info, tab) {
  if (info?.menuItemId !== CONTEXT_MENU_ID) return null;
  return await translateTab(tab);
}

if (typeof chrome !== "undefined" && chrome?.runtime?.onInstalled) {
  chrome.runtime.onInstalled.addListener(setupContextMenu);
}

if (typeof chrome !== "undefined" && chrome?.contextMenus?.onClicked) {
  chrome.contextMenus.onClicked.addListener(handleContextMenuClick);
}

if (typeof chrome !== "undefined" && chrome?.commands?.onCommand) {
  chrome.commands.onCommand.addListener(async (command) => {
    if (command !== "translate-page") return;
    await translateTab();
  });
}

globalThis.__heliumBackground = {
  API_BASE,
  CACHE_MAX,
  CONTEXT_MENU_ID,
  translationCache,
  inFlight,
  getCached,
  setCache,
  requestTranslation,
  translateBatch,
  isRestrictedUrl,
  isValidTabId,
  getStoredSettings,
  getTargetTab,
  translateTab,
  translateActiveTab: translateTab,
  setupContextMenu,
  handleContextMenuClick
};
globalThis.__libreBackground = globalThis.__heliumBackground;

