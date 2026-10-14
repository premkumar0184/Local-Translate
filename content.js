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

  const DEFAULT_BATCH_SIZE = 20;
  const DEFAULT_MAX_CONCURRENCY = 2;
  const BATCH_SIZE = DEFAULT_BATCH_SIZE;
  const MAX_CONCURRENT_BATCHES = DEFAULT_MAX_CONCURRENCY;
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

  function getNodePriority(node, winHeight, winWidth) {
    if (!node) return 3;
    const el = node.nodeType === 1 ? node : (node.parentElement || node.parentNode);
    if (!el) return 3;

    // Direct mock property overrides for test and headless environments
    if (typeof node.priority === "number") return node.priority;
    if (typeof el.priority === "number") return el.priority;
    if (node.viewport === true || el.viewport === true || node.inViewport === true || el.inViewport === true) return 1;

    if (typeof el.getBoundingClientRect !== "function") return 3;
    try {
      const r = el.getBoundingClientRect();
      const winH = winHeight || (typeof window !== "undefined" && window.innerHeight > 0 ? window.innerHeight : 1000);
      const winW = winWidth || (typeof window !== "undefined" && window.innerWidth > 0 ? window.innerWidth : 1000);

      // Priority 1: Elements currently in active viewport
      if (r.bottom > 0 && r.top < winH && r.right > 0 && r.left < winW) {
        return 1;
      }

      // Priority 2: Elements within 1 screen height below the viewport (prefetch buffer)
      if (r.bottom > winH && r.top < winH * 2 && r.right > 0 && r.left < winW) {
        return 2;
      }

      // Priority 3: The remainder of the document
      return 3;
    } catch {
      return 3;
    }
  }

  function isNodeInViewport(node) {
    return getNodePriority(node) === 1;
  }

  function getElementProminence(node) {
    if (!node) return 0;
    let el = node.nodeType === 1 ? node : (node.parentElement || node.parentNode);
    if (!el) return 0;

    let score = 20;
    let curr = el;
    let depth = 0;

    while (curr && depth < 5) {
      const tag = curr.tagName?.toUpperCase() || "";
      if (tag === "H1") { score = Math.max(score, 100); break; }
      if (tag === "H2") { score = Math.max(score, 90); break; }
      if (tag === "H3") { score = Math.max(score, 80); break; }
      if (tag === "H4") { score = Math.max(score, 70); break; }
      if (tag === "H5") { score = Math.max(score, 60); break; }
      if (tag === "H6") { score = Math.max(score, 50); break; }
      if (tag === "TITLE") { score = Math.max(score, 95); break; }
      if (tag === "HEADER") { score = Math.max(score, 75); }
      if (tag === "NAV") { score = Math.max(score, 70); }
      if (tag === "P") { score = Math.max(score, 40); }

      const role = curr.getAttribute?.("role")?.toLowerCase();
      if (role === "heading") score = Math.max(score, 80);
      if (role === "banner" || role === "navigation") score = Math.max(score, 70);

      curr = curr.parentNode || curr.parentElement;
      depth++;
    }

    if (typeof el.getBoundingClientRect === "function") {
      try {
        const r = el.getBoundingClientRect();
        if (r.top < 1000 && r.bottom > 0) {
          const effectiveTop = Math.max(0, r.top);
          const posBonus = Math.max(0, 20 - Math.floor(effectiveTop / 40));
          score += posBonus;
        }
      } catch {}
    }

    return score;
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

    function getItemPriorityAndProminence(nodeOrEl) {
      let p = 3;
      if (typeof isNodeInViewportFn === "function") {
        const res = isNodeInViewportFn(nodeOrEl);
        if (typeof res === "number") {
          p = res;
        } else if (typeof res === "boolean") {
          p = res ? 1 : 3;
        } else {
          p = getNodePriority(nodeOrEl);
        }
      } else {
        p = getNodePriority(nodeOrEl);
      }
      const prom = getElementProminence(nodeOrEl);
      return { priority: p, prominence: prom };
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
              const { priority, prominence } = getItemPriorityAndProminence(el);
              items.push({
                type: "attribute",
                element: el,
                attribute: attr,
                original: val,
                leading,
                core,
                trailing,
                priority,
                prominence,
                inViewport: priority === 1
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
              let segmentPriority = 3;
              let segmentProminence = 0;
              for (const c of run) {
                const { priority: cp, prominence: cprom } = getItemPriorityAndProminence(c);
                if (cp < segmentPriority) segmentPriority = cp;
                if (cprom > segmentProminence) segmentProminence = cprom;
              }

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
                priority: segmentPriority,
                prominence: segmentProminence,
                inViewport: segmentPriority === 1
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
                  const { priority, prominence } = getItemPriorityAndProminence(c);
                  items.push({
                    type: "text",
                    node: c,
                    element: node,
                    original: text,
                    leading,
                    core,
                    trailing,
                    priority,
                    prominence,
                    inViewport: priority === 1
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
          const { priority, prominence } = getItemPriorityAndProminence(node);
          items.push({
            type: "text",
            node,
            element: node.parentElement || node.parentNode,
            original: text,
            leading,
            core,
            trailing,
            priority,
            prominence,
            inViewport: priority === 1
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

  // --- Requirement: Micro Hero First Batch & Viewport Priority Queue ---

  function extractHeroBatch(groups, maxHero = 8) {
    if (!Array.isArray(groups) || groups.length === 0) {
      return { heroBatch: [], remainingGroups: [] };
    }

    const viewportGroups = groups.filter((g) => g.priority === 1 || g.inViewport);
    if (viewportGroups.length === 0) {
      return { heroBatch: [], remainingGroups: [...groups] };
    }

    // Sort viewport groups by prominence descending, then domOrder ascending
    viewportGroups.sort((a, b) => {
      const promDiff = (b.prominence ?? 0) - (a.prominence ?? 0);
      if (promDiff !== 0) return promDiff;
      return (a.domOrder ?? 0) - (b.domOrder ?? 0);
    });

    const heroCount = Math.min(maxHero, viewportGroups.length);
    const heroBatch = viewportGroups.slice(0, heroCount);
    const heroSet = new Set(heroBatch);

    const remainingGroups = groups.filter((g) => !heroSet.has(g));
    return { heroBatch, remainingGroups };
  }

  class ActivePriorityQueue {
    constructor(groups = [], options = {}) {
      this.signal = options.signal || null;
      this.priorityFn = options.priorityFn || null;
      this.winHeight = typeof window !== "undefined" && window.innerHeight > 0 ? window.innerHeight : 1000;
      this.winWidth = typeof window !== "undefined" && window.innerWidth > 0 ? window.innerWidth : 1000;

      this.pending = [...groups];
      this.observer = null;
      this.scrollListener = null;
      this.isListening = false;
      this.scrollThrottled = false;

      this.sortQueue();
    }

    hasPending() {
      return this.pending.length > 0;
    }

    get length() {
      return this.pending.length;
    }

    sortQueue() {
      this.pending.sort((a, b) => {
        const pA = a.priority ?? 3;
        const pB = b.priority ?? 3;
        if (pA !== pB) return pA - pB;

        if (pA === 1) {
          const promDiff = (b.prominence ?? 0) - (a.prominence ?? 0);
          if (promDiff !== 0) return promDiff;
        }
        return (a.domOrder ?? 0) - (b.domOrder ?? 0);
      });
    }

    reprioritize() {
      if (!this.pending.length) return;
      const winH = typeof window !== "undefined" && window.innerHeight > 0 ? window.innerHeight : this.winHeight;
      const winW = typeof window !== "undefined" && window.innerWidth > 0 ? window.innerWidth : this.winWidth;

      let changed = false;
      for (const group of this.pending) {
        const oldPriority = group.priority;
        let newPriority = 3;

        for (const entry of group.entries) {
          const target = entry.element || entry.node || entry.parent;
          let p = 3;
          if (typeof this.priorityFn === "function") {
            const res = this.priorityFn(target);
            if (typeof res === "number") p = res;
            else if (typeof res === "boolean") p = res ? 1 : 3;
            else p = getNodePriority(target, winH, winW);
          } else {
            p = getNodePriority(target, winH, winW);
          }
          entry.priority = p;
          if (p < newPriority) newPriority = p;
          if (newPriority === 1) break;
        }

        if (newPriority !== oldPriority) {
          group.priority = newPriority;
          group.inViewport = newPriority === 1;
          changed = true;
        }
      }

      if (changed) {
        this.sortQueue();
      }
    }

    dequeueBatch(batchSize) {
      if (!this.pending.length) return [];
      const batch = this.pending.splice(0, batchSize);
      if (this.observer && typeof this.observer.unobserve === "function") {
        for (const group of batch) {
          for (const entry of group.entries) {
            const el = entry.element || (entry.node?.nodeType === 1 ? entry.node : (entry.node?.parentElement || entry.node?.parentNode)) || entry.parent;
            if (el && el.nodeType === 1) {
              try {
                this.observer.unobserve(el);
              } catch {}
            }
          }
        }
      }
      return batch;
    }

    attachListeners() {
      if (this.isListening) return;
      this.isListening = true;

      if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
        this.scrollListener = () => {
          if (this.scrollThrottled) return;
          this.scrollThrottled = true;
          if (typeof requestAnimationFrame === "function") {
            requestAnimationFrame(() => {
              this.scrollThrottled = false;
              this.reprioritize();
            });
          } else {
            setTimeout(() => {
              this.scrollThrottled = false;
              this.reprioritize();
            }, 30);
          }
        };
        window.addEventListener("scroll", this.scrollListener, { passive: true, capture: true });
        window.addEventListener("resize", this.scrollListener, { passive: true, capture: true });
      }

      if (typeof IntersectionObserver !== "undefined") {
        try {
          this.observer = new IntersectionObserver((entries) => {
            let hasIntersection = false;
            for (const entry of entries) {
              if (entry.isIntersecting) {
                hasIntersection = true;
                break;
              }
            }
            if (hasIntersection) {
              this.reprioritize();
            }
          }, {
            rootMargin: "0px 0px 100% 0px",
            threshold: 0
          });

          const observedElements = new Set();
          for (const group of this.pending) {
            for (const entry of group.entries) {
              const el = entry.element || (entry.node?.nodeType === 1 ? entry.node : (entry.node?.parentElement || entry.node?.parentNode)) || entry.parent;
              if (el && el.nodeType === 1 && !observedElements.has(el) && typeof this.observer.observe === "function") {
                observedElements.add(el);
                this.observer.observe(el);
              }
            }
          }
        } catch {}
      }
    }

    detachListeners() {
      this.isListening = false;
      if (this.scrollListener && typeof window !== "undefined" && typeof window.removeEventListener === "function") {
        window.removeEventListener("scroll", this.scrollListener, { capture: true });
        window.removeEventListener("resize", this.scrollListener, { capture: true });
        this.scrollListener = null;
      }
      if (this.observer) {
        if (typeof this.observer.disconnect === "function") {
          this.observer.disconnect();
        }
        this.observer = null;
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
    const activeBatchSize = Math.max(1, Math.min(500, Number(tuning?.batchSize) || DEFAULT_BATCH_SIZE));
    const activeThreads = Math.max(1, Math.min(32, Number(tuning?.threads) || DEFAULT_MAX_CONCURRENCY));

    if (!items.length) {
      return { ok: false, error: "No translatable page text was found." };
    }

    const uniqueMap = new Map();
    let groupIndex = 0;
    for (const item of items) {
      let group = uniqueMap.get(item.core);
      if (!group) {
        group = {
          core: item.core,
          inViewport: false,
          priority: item.priority ?? 3,
          prominence: item.prominence ?? 0,
          domOrder: groupIndex++,
          entries: []
        };
        uniqueMap.set(item.core, group);
      }
      group.entries.push(item);
      const itemP = item.priority ?? 3;
      if (itemP < group.priority) {
        group.priority = itemP;
      }
      if (group.priority === 1) {
        group.inViewport = true;
      }
      const itemProm = item.prominence ?? 0;
      if (itemProm > group.prominence) {
        group.prominence = itemProm;
      }
    }

    if (!uniqueMap.size) {
      return { ok: false, error: "No translatable page text was found." };
    }

    const allGroups = Array.from(uniqueMap.values());
    const totalUniqueCount = allGroups.length;

    let completedUnique = 0;
    let updatedNodesCount = 0;
    let firstError = null;
    const signal = state.abortController?.signal;

    function applyBatchTranslations(batch, translations) {
      state.isApplyingTranslation = true;
      let batchNodeCount = 0;

      try {
        batch.forEach((group, index) => {
          const translated = translations[index];
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
                const doc = entry.parent.ownerDocument || (typeof document !== "undefined" ? document : null);
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

      return batchNodeCount;
    }

    async function executeBatch(batch) {
      if (!batch || batch.length === 0 || signal?.aborted || firstError) return false;

      try {
        const result = await chrome.runtime.sendMessage({
          action: "translateBatch",
          texts: batch.map((group) => group.core),
          format: "html"
        });

        if (signal?.aborted) return false;

        if (!result?.ok) {
          firstError ||= result?.error || "Translation request failed.";
          return false;
        }

        if (!Array.isArray(result.translations) || result.translations.length !== batch.length) {
          firstError ||= "Server returned a count mismatch in translations.";
          return false;
        }

        const batchNodes = applyBatchTranslations(batch, result.translations);
        updatedNodesCount += batchNodes;
        completedUnique += batch.length;

        if (!isDynamic) {
          reportProgress(
            Math.min(completedUnique, totalUniqueCount),
            totalUniqueCount,
            updatedNodesCount,
            items.length
          );
        }

        return true;
      } catch (error) {
        if (signal?.aborted) return false;
        firstError ||= error?.message || String(error);
        return false;
      }
    }

    // --- Step 1: Micro "Hero" First Batch (Standalone, Concurrency = 1) ---
    const { heroBatch, remainingGroups } = extractHeroBatch(
      allGroups,
      Math.min(8, activeBatchSize)
    );

    if (heroBatch.length > 0) {
      await executeBatch(heroBatch);
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
      if (typeof requestAnimationFrame === "function") {
        await new Promise((r) => requestAnimationFrame(r));
      }
    }

    // --- Step 2 & 3: Staged Concurrency & Dynamic Scroll Priority Queue ---
    if (remainingGroups.length > 0 && !signal?.aborted && !firstError) {
      const queue = new ActivePriorityQueue(remainingGroups, { signal });
      queue.attachListeners();

      try {
        const workerCount = Math.min(activeThreads, Math.max(1, Math.ceil(remainingGroups.length / activeBatchSize)));

        async function workerLoop() {
          while (!signal?.aborted && !firstError && queue.hasPending()) {
            const batch = queue.dequeueBatch(activeBatchSize);
            if (!batch || batch.length === 0) break;

            const success = await executeBatch(batch);
            if (!success) break;

            if (batch[0]?.priority === 3 && !signal?.aborted) {
              await new Promise((resolve) => runIdle(resolve));
            }
          }
        }

        await Promise.all(Array.from({ length: workerCount }, () => workerLoop()));
      } finally {
        queue.detachListeners();
      }
    }

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
      uniqueCount: totalUniqueCount,
      totalNodes: items.length,
      savedByDedup: Math.max(0, updatedNodesCount - totalUniqueCount)
    };
    if (isDynamic && state.lastStats) {
      state.lastStats.translatedCount += updatedNodesCount;
      state.lastStats.uniqueCount += totalUniqueCount;
      state.lastStats.totalNodes += items.length;
      state.lastStats.savedByDedup += Math.max(0, updatedNodesCount - totalUniqueCount);
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
    } else if (!state.settings && typeof chrome !== "undefined" && chrome?.storage?.local?.get) {
      try {
        const stored = await chrome.storage.local.get(["translatorSettings"]);
        if (stored?.translatorSettings) {
          state.settings = stored.translatorSettings;
        }
      } catch {}
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
    getNodePriority,
    isNodeInViewport,
    getElementProminence,
    extractHeroBatch,
    ActivePriorityQueue,
    DEFAULT_BATCH_SIZE,
    DEFAULT_MAX_CONCURRENCY,
    BATCH_SIZE,
    MAX_CONCURRENT_BATCHES,
    state,
    SKIP_TAGS,
    INLINE_TAGS,
    BLOCK_TAGS,
    TRANSLATABLE_ATTRIBUTES
  };
  globalThis.__libreLocalTranslatorCore = globalThis.__heliumLocalTranslatorCore;
})();
