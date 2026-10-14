(() => {
  const STATE_KEY = "__heliumLocalTranslatorState";
  const state = (globalThis[STATE_KEY] ||= {
    installed: false,
    busy: false,
    abortController: null,
    originals: new Map(),
    lastStats: null,
    isApplyingTranslation: false,
    observerActive: false,
    processedNodes: new WeakSet(),
    processedAttributes: new WeakMap(),
    settings: null
  });

  if (state.installed) return;
  state.installed = true;

  const BATCH_SIZE = 40;
  const MAX_CONCURRENT_BATCHES = Math.min(6, Math.max(2, (navigator.hardwareConcurrency || 4) - 1));
  const MAX_TEXT_NODES = 10000;

  if (typeof chrome !== "undefined" && chrome?.storage?.local?.get) {
    try {
      chrome.storage.local.get(["translatorSettings"], (data) => {
        if (data?.translatorSettings) {
          state.settings = data.translatorSettings;
        }
      });
    } catch {}
  }

  const SKIP_TAGS = new Set([
    "SCRIPT", "STYLE", "NOSCRIPT", "TEXTAREA", "INPUT", "SELECT", "OPTION",
    "CODE", "PRE", "KBD", "SAMP", "SVG", "MATH", "CANVAS", "AUDIO", "VIDEO",
    "IFRAME", "OBJECT", "TEMPLATE"
  ]);

  const INLINE_TAGS = new Set([
    "A", "SPAN", "STRONG", "EM", "CODE",
    "B", "I", "U", "S", "STRIKE", "DEL", "INS", "MARK",
    "SMALL", "SUB", "SUP", "ABBR", "CITE", "Q", "TIME",
    "BDO", "BDI", "DFN", "VAR", "KBD", "SAMP", "NOBR", "WBR",
    "LABEL", "FONT", "IMG"
  ]);

  const BLOCK_TAGS = new Set([
    "ADDRESS", "ARTICLE", "ASIDE", "BLOCKQUOTE", "CANVAS", "DD", "DIV",
    "DL", "DT", "FIELDSET", "FIGCAPTION", "FIGURE", "FOOTER", "FORM",
    "H1", "H2", "H3", "H4", "H5", "H6", "HEADER", "HR", "LI", "MAIN",
    "NAV", "NOSCRIPT", "OL", "P", "PRE", "SECTION", "TABLE", "TBODY",
    "TD", "TFOOT", "TH", "THEAD", "TR", "UL", "VIDEO", "DETAILS", "SUMMARY", "BR"
  ]);

  const TRANSLATABLE_ATTRIBUTES = ["placeholder", "title", "alt", "aria-label"];

  const runIdle = typeof requestIdleCallback === "function"
    ? (fn) => requestIdleCallback(fn, { timeout: 500 })
    : (fn) => setTimeout(fn, 0);

  function reportProgress(doneUnique, totalUnique, updatedNodes, totalNodes) {
    if (typeof chrome !== "undefined" && chrome?.runtime?.sendMessage) {
      chrome.runtime.sendMessage({
        type: "translatorProgress",
        doneUnique,
        totalUnique,
        updatedNodes,
        totalNodes
      }).catch(() => {});
    }
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
    const tagName = node.tagName?.toUpperCase();
    return (
      (tagName && SKIP_TAGS.has(tagName)) ||
      Boolean(node.hidden) ||
      Boolean(node.hasAttribute?.("hidden")) ||
      Boolean(node.isContentEditable) ||
      node.getAttribute?.("aria-hidden") === "true"
    );
  }

  function isNodeInViewport(node) {
    if (!node) return false;
    const el = node.nodeType === 1 ? node : node.parentElement;
    if (!el || typeof el.getBoundingClientRect !== "function") return false;
    try {
      const r = el.getBoundingClientRect();
      const winHeight = typeof window !== "undefined" ? window.innerHeight : 1000;
      const winWidth = typeof window !== "undefined" ? window.innerWidth : 1000;
      return r.bottom > 0 && r.top < winHeight && r.right > 0 && r.left < winWidth;
    } catch {
      return false;
    }
  }

  function isInlineElement(node) {
    if (!node || node.nodeType !== 1) return false;
    const tag = node.tagName?.toUpperCase() || "";
    return INLINE_TAGS.has(tag);
  }

  function isBlockElement(node) {
    if (!node || node.nodeType !== 1) return false;
    const tag = node.tagName?.toUpperCase() || "";
    return BLOCK_TAGS.has(tag);
  }

  // --- Requirement A: Masking and Reconstruction ---

  function decodeHtmlEntities(str) {
    if (!str || typeof str !== "string" || !str.includes("&")) return str;
    return str
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;|&apos;/g, "'")
      .replace(/&nbsp;/g, "\u00a0");
  }

  function maskSegment(nodes, onElement) {
    let nextId = 0;
    const elementMap = new Map();
    const originalTextMap = new Map();
    const originalChildrenMap = new Map();

    function serializeNode(node) {
      if (!node) return "";
      if (node.nodeType === 3 /* TEXT_NODE */) {
        originalTextMap.set(node, node.nodeValue || "");
        return node.nodeValue || "";
      }
      if (node.nodeType === 1 /* ELEMENT_NODE */) {
        if (typeof onElement === "function") {
          onElement(node);
        }
        const id = nextId++;
        elementMap.set(id, node);
        originalChildrenMap.set(node, Array.from(node.childNodes || []));

        const childParts = [];
        for (const child of node.childNodes || []) {
          childParts.push(serializeNode(child));
        }
        const innerText = childParts.join("");
        if (innerText.length === 0) {
          return `<x id="${id}"/>`;
        }
        return `<x id="${id}">${innerText}</x>`;
      }
      return "";
    }

    const parts = [];
    for (const node of nodes) {
      parts.push(serializeNode(node));
    }

    return {
      maskedText: parts.join(""),
      elementMap,
      originalTextMap,
      originalChildrenMap
    };
  }

  const TAG_REGEX = /<\/?x(?:\s+(?:id\s*=\s*)?(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?\s*(\/?)>/gi;

  function parseTranslatedMarkup(text, elementMap, doc = (typeof document !== "undefined" ? document : null)) {
    const createText = (str) => {
      const decoded = decodeHtmlEntities(str);
      if (doc && typeof doc.createTextNode === "function") {
        return doc.createTextNode(decoded);
      }
      return { nodeType: 3, nodeValue: decoded };
    };

    const clearEl = (el) => {
      if (typeof el.replaceChildren === "function") {
        el.replaceChildren();
      } else {
        while (el.childNodes && el.childNodes.length > 0) el.removeChild(el.childNodes[0]);
      }
    };

    const appendChild = (parent, child) => {
      if (typeof parent.appendChild === "function") {
        parent.appendChild(child);
      } else if (Array.isArray(parent.children)) {
        parent.children.push(child);
      }
    };

    const cloneElement = (el) => {
      if (typeof el.cloneNode === "function") {
        return el.cloneNode(false);
      }
      const clone = Object.assign(Object.create(Object.getPrototypeOf(el)), el);
      clone.childNodes = [];
      if (el.attributes instanceof Map) {
        clone.attributes = new Map(el.attributes);
      }
      return clone;
    };

    const root = { type: "root", children: [], appendChild(c) { this.children.push(c); } };
    const stack = [{ frameEl: root, id: -1 }];
    const usedElements = new Set();
    let lastIndex = 0;
    let match;

    TAG_REGEX.lastIndex = 0;
    while ((match = TAG_REGEX.exec(text)) !== null) {
      if (match.index > lastIndex) {
        const textChunk = text.slice(lastIndex, match.index);
        if (textChunk.length > 0) {
          appendChild(stack[stack.length - 1].frameEl, createText(textChunk));
        }
      }
      lastIndex = TAG_REGEX.lastIndex;

      const isClose = match[0].startsWith("</");
      const idStr = match[1] || match[2] || match[3];
      const isSelfClose = match[4] === "/";

      if (isClose) {
        const closeId = idStr !== undefined ? parseInt(idStr.trim(), 10) : NaN;
        if (!isNaN(closeId)) {
          const idx = stack.findLastIndex((frame) => frame.id === closeId);
          if (idx > 0) {
            stack.splice(idx, 1);
          }
        } else if (stack.length > 1) {
          stack.pop();
        }
      } else {
        const id = idStr !== undefined ? parseInt(idStr.trim(), 10) : NaN;
        let el = !isNaN(id) ? elementMap.get(id) : null;
        if (el) {
          if (usedElements.has(el)) {
            el = cloneElement(el);
          } else {
            usedElements.add(el);
            clearEl(el);
          }
          appendChild(stack[stack.length - 1].frameEl, el);
          if (!isSelfClose) {
            stack.push({ frameEl: el, id });
          }
        } else {
          appendChild(stack[stack.length - 1].frameEl, createText(match[0]));
        }
      }
    }

    if (lastIndex < text.length) {
      const textChunk = text.slice(lastIndex);
      if (textChunk.length > 0) {
        appendChild(stack[stack.length - 1].frameEl, createText(textChunk));
      }
    }

    // Safety: ensure any element not referenced in the translation output is safely preserved
    for (const [id, el] of elementMap.entries()) {
      if (!usedElements.has(el)) {
        appendChild(root, el);
      }
    }

    return root.children;
  }

  function replaceSegmentNodes(parent, oldNodes, newNodes) {
    if (!parent || !oldNodes || oldNodes.length === 0 || !newNodes || newNodes.length === 0) return;
    const doc = parent.ownerDocument || (typeof document !== "undefined" ? document : null);
    const marker = doc && typeof doc.createTextNode === "function"
      ? doc.createTextNode("")
      : { nodeType: 3, nodeValue: "", parentNode: null };

    parent.insertBefore(marker, oldNodes[0]);
    const newSet = new Set(newNodes);

    for (const oldNode of oldNodes) {
      if (!newSet.has(oldNode) && oldNode.parentNode === parent) {
        parent.removeChild(oldNode);
      }
    }

    for (const newNode of newNodes) {
      parent.insertBefore(newNode, marker);
    }

    if (marker.parentNode === parent) {
      parent.removeChild(marker);
    }
  }

  function restoreSegmentNodes(parent, originalNodes, currentNodes) {
    if (!parent || !originalNodes || originalNodes.length === 0) return;
    const doc = parent.ownerDocument || (typeof document !== "undefined" ? document : null);
    const marker = doc && typeof doc.createTextNode === "function"
      ? doc.createTextNode("")
      : { nodeType: 3, nodeValue: "", parentNode: null };

    const ref = (currentNodes && currentNodes.find((n) => n.parentNode === parent)) || null;
    parent.insertBefore(marker, ref);
    const originalSet = new Set(originalNodes);

    if (currentNodes) {
      for (const node of currentNodes) {
        if (!originalSet.has(node) && node.parentNode === parent) {
          parent.removeChild(node);
        }
      }
    }

    for (const node of originalNodes) {
      parent.insertBefore(node, marker);
    }

    if (marker.parentNode === parent) {
      parent.removeChild(marker);
    }
  }

  // --- Requirement C & A: Translatable Items Collection ---

  function collectTranslatableItems(root, items = [], isNodeInViewportFn = isNodeInViewport) {
    if (!root) return items;

    const IGNORED_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE"]);

    function isHidden(el) {
      return (
        Boolean(el.hidden) ||
        Boolean(el.hasAttribute?.("hidden")) ||
        el.getAttribute?.("aria-hidden") === "true"
      );
    }

    function collectAttributes(el) {
      if (!el || el.nodeType !== 1) return;
      if (items.length >= MAX_TEXT_NODES) return;
      const tagName = el.tagName?.toUpperCase() || "";

      if (IGNORED_TAGS.has(tagName)) return;
      if (isHidden(el) || Boolean(el.isContentEditable)) return;

      for (const attr of TRANSLATABLE_ATTRIBUTES) {
        if (attr === "alt" && tagName !== "IMG" && tagName !== "AREA" && tagName !== "INPUT") continue;
        if (attr === "placeholder" && tagName !== "INPUT" && tagName !== "TEXTAREA") continue;

        if (el.hasAttribute?.(attr)) {
          const val = el.getAttribute(attr);
          if (val && isEligibleText(val)) {
            const { leading, core, trailing } = splitWhitespace(val);
            if (core && isEligibleText(core)) {
              items.push({
                type: "attribute",
                element: el,
                attribute: attr,
                original: val,
                leading,
                core,
                trailing,
                inViewport: isNodeInViewportFn(el)
              });
            }
          }
        }
      }
    }

    function walk(node) {
      if (!node) return;
      if (items.length >= MAX_TEXT_NODES) return;

      if (node.nodeType === 1 /* ELEMENT_NODE */) {
        const tagName = node.tagName?.toUpperCase() || "";

        if (IGNORED_TAGS.has(tagName)) return;
        if (isHidden(node) || Boolean(node.isContentEditable)) return;

        // Requirement C: Attribute Translation
        collectAttributes(node);

        // Child text walking is skipped for inputs, selects, media and code-block tags
        if (
          tagName === "INPUT" || tagName === "TEXTAREA" || tagName === "SELECT" ||
          tagName === "PRE" || tagName === "SVG" || tagName === "CANVAS" ||
          tagName === "AUDIO" || tagName === "VIDEO" || tagName === "IFRAME"
        ) {
          return;
        }

        // Requirement A: Partition childNodes into inline runs separated by block elements
        const childNodes = Array.from(node.childNodes || []);
        let currentRun = [];

        function flushRun() {
          if (currentRun.length === 0) return;
          const run = currentRun;
          currentRun = [];

          const hasInlineTag = run.some(
            (c) => c.nodeType === 1 && INLINE_TAGS.has(c.tagName?.toUpperCase())
          );

          if (hasInlineTag) {
            const { maskedText, elementMap, originalTextMap, originalChildrenMap } = maskSegment(run, collectAttributes);
            const { leading, core, trailing } = splitWhitespace(maskedText);
            const humanText = core.replace(/<\/?[a-zA-Z][^>]*>/g, "");
            if (core && isEligibleText(humanText)) {
              items.push({
                type: "segment",
                parent: node,
                nodes: run,
                elementMap,
                originalTextMap,
                originalChildrenMap,
                originalText: maskedText,
                leading,
                core,
                trailing,
                inViewport: run.some((c) => isNodeInViewportFn(c))
              });
            }
          } else {
            for (const c of run) {
              if (c.nodeType === 1) {
                collectAttributes(c);
              } else if (c.nodeType === 3 /* TEXT_NODE */) {
                const text = c.nodeValue || "";
                const { leading, core, trailing } = splitWhitespace(text);
                if (core && isEligibleText(core)) {
                  items.push({
                    type: "text",
                    node: c,
                    original: text,
                    leading,
                    core,
                    trailing,
                    inViewport: isNodeInViewportFn(c)
                  });
                }
              }
            }
          }
        }

        for (const child of childNodes) {
          if (child.nodeType === 1) {
            const childTag = child.tagName?.toUpperCase() || "";
            if (isBlockElement(child)) {
              flushRun();
              walk(child);
            } else if (INLINE_TAGS.has(childTag)) {
              currentRun.push(child);
            } else {
              flushRun();
              walk(child);
            }
          } else if (child.nodeType === 3) {
            currentRun.push(child);
          }
        }
        flushRun();

      } else if (node.nodeType === 3) {
        const text = node.nodeValue || "";
        const { leading, core, trailing } = splitWhitespace(text);
        if (core && isEligibleText(core)) {
          items.push({
            type: "text",
            node,
            original: text,
            leading,
            core,
            trailing,
            inViewport: isNodeInViewportFn(node)
          });
        }
      }
    }

    walk(root);
    return items;
  }

  function markSubtreeProcessed(node) {
    if (!node) return;
    state.processedNodes.add(node);
    if (node.childNodes) {
      for (const child of node.childNodes) {
        markSubtreeProcessed(child);
      }
    }
  }

  // --- Translation Pipeline ---

  async function translateItems(items, options = {}) {
    const { isDynamic = false } = options;
    if (options.settings) {
      state.settings = options.settings;
    }
    const tuning = options.settings || state.settings;
    const activeBatchSize = Math.max(1, Math.min(500, Number(tuning?.batchSize) || BATCH_SIZE));
    const activeThreads = Math.max(1, Math.min(32, Number(tuning?.threads) || MAX_CONCURRENT_BATCHES));

    if (!items.length) {
      return { ok: false, error: "No translatable page text was found." };
    }

    const uniqueMap = new Map();
    for (const item of items) {
      let group = uniqueMap.get(item.core);
      if (!group) {
        group = { core: item.core, inViewport: false, entries: [] };
        uniqueMap.set(item.core, group);
      }
      group.entries.push(item);
      if (!group.inViewport && item.inViewport) {
        group.inViewport = true;
      }
    }

    if (!uniqueMap.size) {
      return { ok: false, error: "No translatable page text was found." };
    }

    const groups = Array.from(uniqueMap.values()).sort(
      (a, b) => (b.inViewport ? 1 : 0) - (a.inViewport ? 1 : 0)
    );

    const batches = [];
    for (let offset = 0; offset < groups.length; offset += activeBatchSize) {
      batches.push(groups.slice(offset, offset + activeBatchSize));
    }

    let nextBatchIndex = 0;
    let completedUnique = 0;
    let updatedNodesCount = 0;
    let firstError = null;

    const signal = state.abortController?.signal;

    async function processBatches() {
      while (!signal?.aborted && !firstError) {
        const batchIndex = nextBatchIndex++;
        if (batchIndex >= batches.length) return;
        const batch = batches[batchIndex];

        try {
          const result = await chrome.runtime.sendMessage({
            action: "translateBatch",
            texts: batch.map((group) => group.core),
            format: "html"
          });

          if (signal?.aborted) return;

          if (!result?.ok) {
            firstError ||= result?.error || "Translation request failed.";
            return;
          }

          if (!Array.isArray(result.translations) || result.translations.length !== batch.length) {
            firstError ||= "Server returned a count mismatch in translations.";
            return;
          }

          state.isApplyingTranslation = true;
          let batchNodeCount = 0;

          try {
            batch.forEach((group, index) => {
              const translated = result.translations[index];
              if (typeof translated !== "string") return;

              for (const entry of group.entries) {
                if (signal?.aborted) return;

                if (entry.type === "text") {
                  if (entry.node.isConnected) {
                    state.originals.set(entry.node, entry.original);
                    markSubtreeProcessed(entry.node);
                    entry.node.nodeValue = `${entry.leading}${decodeHtmlEntities(translated)}${entry.trailing}`;
                    batchNodeCount++;
                  }
                } else if (entry.type === "attribute") {
                  if (entry.element.isConnected) {
                    const attrKey = {
                      type: "attribute",
                      element: entry.element,
                      attribute: entry.attribute
                    };
                    state.originals.set(attrKey, entry.original);
                    let attrSet = state.processedAttributes.get(entry.element);
                    if (!attrSet) {
                      attrSet = new Set();
                      state.processedAttributes.set(entry.element, attrSet);
                    }
                    attrSet.add(entry.attribute);

                    const translatedVal = `${entry.leading}${decodeHtmlEntities(translated)}${entry.trailing}`;
                    entry.element.setAttribute(entry.attribute, translatedVal);
                    if (entry.attribute === "placeholder" && "placeholder" in entry.element) {
                      entry.element.placeholder = translatedVal;
                    }
                    batchNodeCount++;
                  }
                } else if (entry.type === "segment") {
                  if (entry.parent.isConnected) {
                    const translatedSentence = `${entry.leading}${translated}${entry.trailing}`;
                    const doc = entry.parent.ownerDocument || document;
                    const reconstructedNodes = parseTranslatedMarkup(
                      translatedSentence,
                      entry.elementMap,
                      doc
                    );

                    const segKey = {
                      type: "segment",
                      parent: entry.parent,
                      originalNodes: entry.nodes,
                      originalTextMap: entry.originalTextMap,
                      originalChildrenMap: entry.originalChildrenMap,
                      currentNodes: reconstructedNodes
                    };
                    state.originals.set(segKey, entry.originalText);
                    for (const n of entry.nodes) markSubtreeProcessed(n);
                    for (const n of reconstructedNodes) markSubtreeProcessed(n);

                    replaceSegmentNodes(entry.parent, entry.nodes, reconstructedNodes);
                    batchNodeCount++;
                  }
                }
              }
            });
          } finally {
            if (mutationObserver && typeof mutationObserver.takeRecords === "function") {
              mutationObserver.takeRecords();
            }
            state.isApplyingTranslation = false;
          }

          updatedNodesCount += batchNodeCount;
          completedUnique += batch.length;

          if (!isDynamic) {
            reportProgress(
              Math.min(completedUnique, groups.length),
              groups.length,
              updatedNodesCount,
              items.length
            );
          }

          if (!batch[0]?.inViewport && !signal?.aborted) {
            await new Promise((resolve) => runIdle(resolve));
          }
        } catch (error) {
          if (signal?.aborted) return;
          firstError ||= error?.message || String(error);
          return;
        }
      }
    }

    const workerCount = Math.min(activeThreads, batches.length);
    await Promise.all(Array.from({ length: workerCount }, () => processBatches()));

    if (signal?.aborted) {
      return { ok: false, aborted: true, error: "Translation was cancelled." };
    }

    if (firstError) {
      return {
        ok: false,
        partial: updatedNodesCount > 0,
        error: firstError,
        translatedCount: updatedNodesCount,
        total: items.length
      };
    }

    const resultStats = {
      ok: true,
      translatedCount: updatedNodesCount,
      uniqueCount: groups.length,
      totalNodes: items.length,
      savedByDedup: Math.max(0, updatedNodesCount - groups.length)
    };
    if (isDynamic && state.lastStats) {
      state.lastStats.translatedCount += updatedNodesCount;
      state.lastStats.uniqueCount += groups.length;
      state.lastStats.totalNodes += items.length;
      state.lastStats.savedByDedup += Math.max(0, updatedNodesCount - groups.length);
    } else {
      state.lastStats = resultStats;
    }
    return resultStats;
  }

  // --- Requirement B: Dynamic Content & SPAs (MutationObserver) ---

  let mutationObserver = null;
  let mutationDebounceTimer = null;
  const pendingAddedSubtrees = new Set();

  function startMutationObserver() {
    if (mutationObserver || typeof MutationObserver === "undefined") return;

    mutationObserver = new MutationObserver((mutations) => {
      if (state.isApplyingTranslation) return;

      let hasNewNodes = false;
      for (const m of mutations) {
        if (m.type === "childList" && m.addedNodes?.length > 0) {
          for (const node of m.addedNodes) {
            if (node.nodeType === 1 || (node.nodeType === 3 && node.nodeValue?.trim())) {
              pendingAddedSubtrees.add(node);
              hasNewNodes = true;
            }
          }
        }
      }

      if (hasNewNodes) {
        if (mutationDebounceTimer) clearTimeout(mutationDebounceTimer);
        mutationDebounceTimer = setTimeout(() => {
          mutationDebounceTimer = null;
          flushDynamicMutations();
        }, 250);
      }
    });

    const target = document.body || document.documentElement;
    if (target) {
      mutationObserver.observe(target, { childList: true, subtree: true });
      state.observerActive = true;
    }
  }

  function stopMutationObserver() {
    if (mutationDebounceTimer) {
      clearTimeout(mutationDebounceTimer);
      mutationDebounceTimer = null;
    }
    pendingAddedSubtrees.clear();
    if (mutationObserver) {
      mutationObserver.disconnect();
      mutationObserver = null;
    }
    state.observerActive = false;
  }

  function isItemAlreadyProcessed(item) {
    if (item.type === "text") {
      return state.originals.has(item.node) || state.processedNodes.has(item.node);
    }
    if (item.type === "attribute") {
      return Boolean(state.processedAttributes?.get(item.element)?.has(item.attribute));
    }
    if (item.type === "segment") {
      return item.nodes.some((n) => state.processedNodes.has(n));
    }
    return false;
  }

  async function flushDynamicMutations() {
    if (!pendingAddedSubtrees.size) return;
    if (state.isApplyingTranslation) return;

    if (state.busy) {
      if (!mutationDebounceTimer) {
        mutationDebounceTimer = setTimeout(flushDynamicMutations, 300);
      }
      return;
    }

    const subtrees = Array.from(pendingAddedSubtrees);
    pendingAddedSubtrees.clear();

    const newItems = [];
    for (const root of subtrees) {
      if (!root.isConnected) continue;
      collectTranslatableItems(root, newItems);
    }

    const unprocessedItems = newItems.filter((item) => !isItemAlreadyProcessed(item));
    if (!unprocessedItems.length) return;

    state.busy = true;
    const abortController = new AbortController();
    state.abortController = abortController;

    try {
      await translateItems(unprocessedItems, { isDynamic: true });
    } catch (err) {
      console.warn("Dynamic translation failed:", err);
    } finally {
      state.busy = false;
      state.abortController = null;
    }
  }

  // --- Page Translation & Restoration ---

  async function restoreOriginals() {
    if (state.busy && state.abortController) {
      state.abortController.abort();
    }
    state.busy = false;

    stopMutationObserver();

    state.isApplyingTranslation = true;
    let restored = 0;

    try {
      for (const [target, original] of state.originals.entries()) {
        try {
          if (target?.type === "segment") {
            if (target.parent?.isConnected) {
              if (target.originalChildrenMap) {
                for (const [el, children] of target.originalChildrenMap.entries()) {
                  if (typeof el.replaceChildren === "function") {
                    el.replaceChildren(...children);
                  } else {
                    while (el.childNodes && el.childNodes.length > 0) el.removeChild(el.childNodes[0]);
                    for (const c of children) el.appendChild(c);
                  }
                }
              }
              if (target.originalTextMap) {
                for (const [tNode, textVal] of target.originalTextMap.entries()) {
                  if (tNode) tNode.nodeValue = textVal;
                }
              }
              restoreSegmentNodes(target.parent, target.originalNodes, target.currentNodes);
              restored++;
            }
          } else if (target?.type === "attribute") {
            if (target.element?.isConnected) {
              if (original === null) {
                target.element.removeAttribute(target.attribute);
              } else {
                target.element.setAttribute(target.attribute, original);
                if (target.attribute === "placeholder" && "placeholder" in target.element) {
                  target.element.placeholder = original;
                }
              }
              restored++;
            }
          } else if (target?.nodeType === 3 || typeof target?.nodeValue === "string") {
            if (target.isConnected && target.nodeValue !== original) {
              target.nodeValue = original;
              restored++;
            }
          }
        } catch (err) {
          console.warn("Could not restore item:", err);
        }
      }
    } finally {
      state.isApplyingTranslation = false;
    }

    const count = state.originals.size;
    state.originals.clear();
    state.processedNodes = new WeakSet();
    state.processedAttributes = new WeakMap();
    state.lastStats = null;
    return { ok: true, restored: restored || count };
  }

  async function translatePage(customSettings = null) {
    if (customSettings) {
      state.settings = customSettings;
    }
    if (state.busy) return { ok: false, error: "A translation is already running." };

    if (state.originals.size > 0) {
      await restoreOriginals();
    }

    state.busy = true;
    const abortController = new AbortController();
    state.abortController = abortController;

    try {
      const root = document.body || document.documentElement;
      if (!root) {
        return { ok: false, error: "No translatable page text was found." };
      }

      const items = collectTranslatableItems(root);
      if (!items.length) {
        return { ok: false, error: "No translatable page text was found." };
      }

      startMutationObserver();

      const result = await translateItems(items, { isDynamic: false, settings: state.settings });
      return result;
    } finally {
      state.busy = false;
      state.abortController = null;
    }
  }

  if (typeof chrome !== "undefined" && chrome?.runtime?.onMessage) {
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (message?.action === "translatePage") {
        sendResponseAsync(sendResponse, translatePage(message.settings));
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
          lastStats: state.lastStats,
          observerActive: state.observerActive
        });
        return false;
      }
      return false;
    });
  }

  // Expose core for test suite and external inspection
  globalThis.__heliumLocalTranslatorCore = {
    splitWhitespace,
    decodeHtmlEntities,
    isEligibleText,
    shouldRejectElement,
    isInlineElement,
    isBlockElement,
    maskSegment,
    parseTranslatedMarkup,
    replaceSegmentNodes,
    restoreSegmentNodes,
    collectTranslatableItems,
    startMutationObserver,
    stopMutationObserver,
    flushDynamicMutations,
    translateItems,
    translatePage,
    restoreOriginals,
    state,
    SKIP_TAGS,
    INLINE_TAGS,
    BLOCK_TAGS,
    TRANSLATABLE_ATTRIBUTES
  };
  globalThis.__libreLocalTranslatorCore = globalThis.__heliumLocalTranslatorCore;
})();
