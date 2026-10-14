(() => {
  const STATE_KEY = "__heliumLocalTranslatorState";
  const state = (globalThis[STATE_KEY] ||= {
    installed: false,
    busy: false,
    abortController: null,
    originals: new Map(),
    lastStats: null
  });

  if (state.installed) return;
  state.installed = true;

  const BATCH_SIZE = 40;
  const MAX_CONCURRENT_BATCHES = Math.min(6, Math.max(2, (navigator.hardwareConcurrency || 4) - 1));
  const MAX_TEXT_NODES = 10000;
  const SKIP_TAGS = new Set([
    "SCRIPT", "STYLE", "NOSCRIPT", "TEXTAREA", "INPUT", "SELECT", "OPTION",
    "CODE", "PRE", "KBD", "SAMP", "SVG", "MATH", "CANVAS", "AUDIO", "VIDEO",
    "IFRAME", "OBJECT", "TEMPLATE"
  ]);

  const runIdle = typeof requestIdleCallback === "function"
    ? (fn) => requestIdleCallback(fn, { timeout: 500 })
    : (fn) => setTimeout(fn, 0);

  function reportProgress(doneUnique, totalUnique, updatedNodes, totalNodes) {
    chrome.runtime.sendMessage({
      type: "translatorProgress",
      doneUnique,
      totalUnique,
      updatedNodes,
      totalNodes
    }).catch(() => {});
  }

  function sendResponseAsync(sendResponse, promise) {
    promise.then(sendResponse).catch((error) => {
      sendResponse({ ok: false, error: error?.message || String(error) });
    });
  }

  function splitWhitespace(text) {
    const leading = text.match(/^\s*/u)?.[0] || "";
    if (leading.length === text.length) {
      return { leading, core: "", trailing: "" };
    }
    const trailing = text.match(/\s*$/u)?.[0] || "";
    const end = text.length - trailing.length;
    return { leading, core: text.slice(leading.length, end), trailing };
  }

  function isEligibleText(text) {
    const trimmed = text.trim();
    return trimmed.length > 0 && /\p{L}/u.test(trimmed);
  }

  function shouldRejectElement(node) {
    return (
      SKIP_TAGS.has(node.tagName) ||
      node.hidden ||
      node.hasAttribute("hidden") ||
      node.isContentEditable ||
      node.getAttribute("aria-hidden") === "true"
    );
  }

  function collectTextNodes() {
    const root = document.body || document.documentElement;
    if (!root) return [];

    const walker = document.createTreeWalker(
      root,
      NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT,
      {
        acceptNode(node) {
          if (node.nodeType === Node.ELEMENT_NODE) {
            return shouldRejectElement(node) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_SKIP;
          }
          const text = node.nodeValue || "";
          return isEligibleText(text) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
        }
      }
    );

    const nodes = [];
    while (walker.nextNode() && nodes.length < MAX_TEXT_NODES) {
      nodes.push(walker.currentNode);
    }
    return nodes;
  }

  function isNodeInViewport(node) {
    const el = node.parentElement;
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return r.bottom > 0 && r.top < window.innerHeight && r.right > 0 && r.left < window.innerWidth;
  }

  async function restoreOriginals() {
    if (state.busy && state.abortController) {
      state.abortController.abort();
    }
    state.busy = false;

    let restored = 0;
    for (const [node, original] of state.originals.entries()) {
      if (node?.isConnected && node.nodeValue !== original) {
        node.nodeValue = original;
        restored++;
      }
    }
    const count = state.originals.size;
    state.originals.clear();
    state.lastStats = null;
    return { ok: true, restored: restored || count };
  }

  async function translatePage() {
    if (state.busy) return { ok: false, error: "A translation is already running." };

    if (state.originals.size > 0) {
      await restoreOriginals();
    }

    state.busy = true;
    const abortController = new AbortController();
    state.abortController = abortController;
    const signal = abortController.signal;

    try {
      const nodes = collectTextNodes();
      if (!nodes.length) {
        return { ok: false, error: "No translatable page text was found." };
      }

      const uniqueMap = new Map();
      for (const node of nodes) {
        const original = node.nodeValue || "";
        const { leading, core, trailing } = splitWhitespace(original);
        if (!core || !isEligibleText(core)) continue;

        state.originals.set(node, original);

        let group = uniqueMap.get(core);
        if (!group) {
          group = { core, inViewport: false, entries: [] };
          uniqueMap.set(core, group);
        }
        group.entries.push({ node, leading, trailing });
        if (!group.inViewport && isNodeInViewport(node)) {
          group.inViewport = true;
        }
      }

      if (!uniqueMap.size) {
        return { ok: false, error: "No translatable page text was found." };
      }

      // Prioritize viewport-visible groups first so visible text is rendered immediately
      const groups = Array.from(uniqueMap.values()).sort(
        (a, b) => (b.inViewport ? 1 : 0) - (a.inViewport ? 1 : 0)
      );

      const batches = [];
      for (let offset = 0; offset < groups.length; offset += BATCH_SIZE) {
        batches.push(groups.slice(offset, offset + BATCH_SIZE));
      }

      let nextBatchIndex = 0;
      let completedUnique = 0;
      let updatedNodesCount = 0;
      let firstError = null;

      async function processBatches() {
        while (!signal.aborted && !firstError) {
          const batchIndex = nextBatchIndex++;
          if (batchIndex >= batches.length) return;
          const batch = batches[batchIndex];

          try {
            const result = await chrome.runtime.sendMessage({
              action: "translateBatch",
              texts: batch.map((group) => group.core)
            });

            if (signal.aborted) return;

            if (!result?.ok) {
              firstError ||= result?.error || "Translation request failed.";
              return;
            }

            if (!Array.isArray(result.translations) || result.translations.length !== batch.length) {
              firstError ||= "Server returned a count mismatch in translations.";
              return;
            }

            // Synchronously update DOM nodes for this batch
            let batchNodeCount = 0;
            batch.forEach((group, index) => {
              const translated = result.translations[index];
              if (typeof translated === "string") {
                for (const entry of group.entries) {
                  if (entry.node.isConnected && !signal.aborted) {
                    entry.node.nodeValue = `${entry.leading}${translated}${entry.trailing}`;
                    batchNodeCount++;
                  }
                }
              }
            });

            updatedNodesCount += batchNodeCount;
            completedUnique += batch.length;

            reportProgress(
              Math.min(completedUnique, groups.length),
              groups.length,
              updatedNodesCount,
              nodes.length
            );

            // Yield to idle loop between off-screen batches to preserve responsiveness
            if (!batch[0]?.inViewport && !signal.aborted) {
              await new Promise((resolve) => runIdle(resolve));
            }
          } catch (error) {
            if (signal.aborted) return;
            firstError ||= error?.message || String(error);
            return;
          }
        }
      }

      const workerCount = Math.min(MAX_CONCURRENT_BATCHES, batches.length);
      await Promise.all(Array.from({ length: workerCount }, () => processBatches()));

      if (signal.aborted) {
        return { ok: false, aborted: true, error: "Translation was cancelled." };
      }

      if (firstError) {
        return {
          ok: false,
          partial: updatedNodesCount > 0,
          error: firstError,
          translatedCount: updatedNodesCount,
          total: nodes.length
        };
      }

      const resultStats = {
        ok: true,
        translatedCount: updatedNodesCount,
        uniqueCount: groups.length,
        totalNodes: nodes.length,
        savedByDedup: Math.max(0, updatedNodesCount - groups.length)
      };
      state.lastStats = resultStats;
      return resultStats;
    } finally {
      state.busy = false;
      state.abortController = null;
    }
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.action === "translatePage") {
      sendResponseAsync(sendResponse, translatePage());
      return true;
    }
    if (message?.action === "restoreOriginals") {
      sendResponseAsync(sendResponse, restoreOriginals());
      return true;
    }
    if (message?.action === "getState") {
      sendResponse({
        ok: true,
        busy: state.busy,
        translatedCount: state.originals.size,
        lastStats: state.lastStats
      });
      return false;
    }
    return false;
  });
})();
