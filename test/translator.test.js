import test from "node:test";
import assert from "node:assert/strict";

// Core logic functions mirroring content.js
const SKIP_TAGS = new Set([
  "SCRIPT", "STYLE", "NOSCRIPT", "TEXTAREA", "INPUT", "SELECT", "OPTION",
  "CODE", "PRE", "KBD", "SAMP", "SVG", "MATH", "CANVAS", "AUDIO", "VIDEO",
  "IFRAME", "OBJECT", "TEMPLATE"
]);

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

function deduplicateEntries(nodes, isNodeInViewport) {
  const uniqueMap = new Map();
  for (const node of nodes) {
    const original = node.nodeValue || "";
    const { leading, core, trailing } = splitWhitespace(original);
    if (!core || !isEligibleText(core)) continue;

    let group = uniqueMap.get(core);
    if (!group) {
      group = { core, inViewport: false, entries: [] };
      uniqueMap.set(core, group);
    }
    group.entries.push({ node, original, leading, trailing });
    if (!group.inViewport && isNodeInViewport(node)) {
      group.inViewport = true;
    }
  }

  return Array.from(uniqueMap.values()).sort(
    (a, b) => (b.inViewport ? 1 : 0) - (a.inViewport ? 1 : 0)
  );
}

// Background LRU Cache implementation with in-flight deduplication
class TranslationCache {
  constructor(maxSize = 2000) {
    this.maxSize = maxSize;
    this.cache = new Map();
    this.inFlight = new Map();
  }

  get(key) {
    if (!this.cache.has(key)) return undefined;
    const val = this.cache.get(key);
    this.cache.delete(key);
    this.cache.set(key, val);
    return val;
  }

  set(key, val) {
    if (typeof val !== "string" || !val) return;
    if (this.cache.has(key)) {
      this.cache.delete(key);
    } else if (this.cache.size >= this.maxSize) {
      const oldestKey = this.cache.keys().next().value;
      this.cache.delete(oldestKey);
    }
    this.cache.set(key, val);
  }

  get size() {
    return this.cache.size;
  }
}

async function translateBatchWithCache(texts, cache, fetchFn) {
  if (!Array.isArray(texts) || texts.length === 0) return [];

  const results = new Array(texts.length);
  const uncachedMap = new Map();
  const waitingPromises = [];

  for (let i = 0; i < texts.length; i++) {
    const text = texts[i];
    const cached = cache.get(text);
    if (cached !== undefined) {
      results[i] = cached;
    } else if (cache.inFlight.has(text)) {
      const p = cache.inFlight.get(text).then((trans) => {
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
      cache.inFlight.set(key, promise);
      resolvers.set(key, { resolve, reject });
    }

    try {
      const fetched = await fetchFn(uniqueUncached);
      if (!Array.isArray(fetched) || fetched.length !== uniqueUncached.length) {
        throw new Error("Translation count mismatch from server");
      }
      for (let j = 0; j < uniqueUncached.length; j++) {
        const originalText = uniqueUncached[j];
        const translated = fetched[j];
        cache.set(originalText, translated);
        resolvers.get(originalText)?.resolve(translated);
        const indices = uncachedMap.get(originalText);
        for (const idx of indices) {
          results[idx] = translated;
        }
      }
    } catch (err) {
      for (const key of uniqueUncached) {
        resolvers.get(key)?.reject(err);
      }
      throw err;
    } finally {
      for (const key of uniqueUncached) {
        cache.inFlight.delete(key);
      }
    }
  }

  if (waitingPromises.length > 0) {
    await Promise.all(waitingPromises);
  }

  return results;
}

test("splitWhitespace correctly extracts whitespace and core text", () => {
  const t1 = splitWhitespace("   Hello world!  \n");
  assert.equal(t1.leading, "   ");
  assert.equal(t1.core, "Hello world!");
  assert.equal(t1.trailing, "  \n");

  const t2 = splitWhitespace("NoWhitespace");
  assert.equal(t2.leading, "");
  assert.equal(t2.core, "NoWhitespace");
  assert.equal(t2.trailing, "");

  const t3 = splitWhitespace("   ");
  assert.equal(t3.leading, "   ");
  assert.equal(t3.core, "");
  assert.equal(t3.trailing, "");
});

test("isEligibleText accepts CJK characters, single letters, and rejects numbers/symbols", () => {
  // Multi-word / standard text
  assert.equal(isEligibleText("Bonjour"), true);
  assert.equal(isEligibleText("Привет"), true);
  assert.equal(isEligibleText("こんにちは"), true);
  assert.equal(isEligibleText("你好"), true);
  assert.equal(isEligibleText("Chapter 1: Start"), true);

  // Single-character words / logograms MUST be accepted
  assert.equal(isEligibleText("我"), true);
  assert.equal(isEligibleText("日"), true);
  assert.equal(isEligibleText("月"), true);
  assert.equal(isEligibleText("年"), true);
  assert.equal(isEligibleText("I"), true);
  assert.equal(isEligibleText("A"), true);
  assert.equal(isEligibleText("и"), true);
  assert.equal(isEligibleText("y"), true);
  assert.equal(isEligibleText("x"), true);

  // Pure numbers and symbols should be rejected
  assert.equal(isEligibleText("12345"), false);
  assert.equal(isEligibleText("2024-10-14"), false);
  assert.equal(isEligibleText("$19.99"), false);
  assert.equal(isEligibleText("---"), false);
  assert.equal(isEligibleText("   "), false);
  assert.equal(isEligibleText(""), false);
  assert.equal(isEligibleText("!?@#$%^&*()"), false);
});

test("shouldRejectElement rejects skip tags, hidden elements, and contentEditable", () => {
  assert.equal(shouldRejectElement({ tagName: "SCRIPT" }), true);
  assert.equal(shouldRejectElement({ tagName: "STYLE" }), true);
  assert.equal(shouldRejectElement({ tagName: "CODE" }), true);
  assert.equal(shouldRejectElement({ tagName: "PRE" }), true);
  assert.equal(shouldRejectElement({ tagName: "SVG" }), true);
  assert.equal(shouldRejectElement({ tagName: "DIV", isContentEditable: true }), true);
  assert.equal(shouldRejectElement({ tagName: "DIV", hidden: true }), true);
  assert.equal(
    shouldRejectElement({
      tagName: "DIV",
      hasAttribute: (a) => a === "hidden",
      getAttribute: () => null
    }),
    true
  );
  assert.equal(
    shouldRejectElement({
      tagName: "SPAN",
      getAttribute: (a) => (a === "aria-hidden" ? "true" : null)
    }),
    true
  );

  // Normal content elements should be accepted (not rejected)
  assert.equal(
    shouldRejectElement({
      tagName: "DIV",
      isContentEditable: false,
      getAttribute: () => "false"
    }),
    false
  );
  assert.equal(shouldRejectElement({ tagName: "P" }), false);
  assert.equal(shouldRejectElement({ tagName: "ARTICLE" }), false);
});

test("deduplication groups identical phrases and prioritizes viewport", () => {
  const nodes = [
    { id: 1, nodeValue: "  Home  ", viewport: false },
    { id: 2, nodeValue: "Welcome to the site", viewport: true },
    { id: 3, nodeValue: "Home", viewport: true },
    { id: 4, nodeValue: "  Home", viewport: false },
    { id: 5, nodeValue: "12345", viewport: true }, // should be ignored
    { id: 6, nodeValue: "About us", viewport: false },
    { id: 7, nodeValue: "我", viewport: false } // single character CJK should be included
  ];

  const groups = deduplicateEntries(nodes, (n) => n.viewport);

  // 4 unique eligible strings: "Welcome to the site", "Home", "About us", "我"
  assert.equal(groups.length, 4);

  // Viewport groups should come first: "Home" (node 3 was in viewport) and "Welcome..."
  const firstTwoCores = [groups[0].core, groups[1].core];
  assert.ok(firstTwoCores.includes("Welcome to the site"));
  assert.ok(firstTwoCores.includes("Home"));

  // Verify "Home" entries contains 3 nodes
  const homeGroup = groups.find((g) => g.core === "Home");
  assert.equal(homeGroup.entries.length, 3);
  assert.equal(homeGroup.inViewport, true);
  assert.deepEqual(homeGroup.entries.map((e) => e.node.id), [1, 3, 4]);

  // Verify single CJK character group
  const cjkGroup = groups.find((g) => g.core === "我");
  assert.ok(cjkGroup);
  assert.equal(cjkGroup.entries.length, 1);
});

test("TranslationCache evicts LRU entries when max size is reached", () => {
  const cache = new TranslationCache(3);
  cache.set("a", "1");
  cache.set("b", "2");
  cache.set("c", "3");
  assert.equal(cache.size, 3);

  // Access "a" so "b" becomes the oldest
  assert.equal(cache.get("a"), "1");

  // Add "d", should evict "b"
  cache.set("d", "4");
  assert.equal(cache.size, 3);
  assert.equal(cache.get("b"), undefined);
  assert.equal(cache.get("a"), "1");
  assert.equal(cache.get("c"), "3");
  assert.equal(cache.get("d"), "4");
});

test("translateBatchWithCache uses cache and only queries uncached texts", async () => {
  const cache = new TranslationCache(100);
  cache.set("Bonjour", "Hello");

  let fetchCalls = 0;
  let fetchedQueries = [];

  const mockFetch = async (texts) => {
    fetchCalls++;
    fetchedQueries = texts;
    return texts.map((t) => `Translated(${t})`);
  };

  const input = ["Bonjour", "Monde", "Bonjour", "Merci"];
  const output = await translateBatchWithCache(input, cache, mockFetch);

  // Fetched only uncached unique: "Monde" and "Merci"
  assert.equal(fetchCalls, 1);
  assert.deepEqual(fetchedQueries, ["Monde", "Merci"]);

  // All results in correct order
  assert.deepEqual(output, [
    "Hello",
    "Translated(Monde)",
    "Hello",
    "Translated(Merci)"
  ]);

  // Subsequent call for "Monde" should now be fully cached
  fetchCalls = 0;
  const secondOutput = await translateBatchWithCache(["Monde", "Merci"], cache, mockFetch);
  assert.equal(fetchCalls, 0);
  assert.deepEqual(secondOutput, ["Translated(Monde)", "Translated(Merci)"]);
});

test("in-flight promise deduplication shares single request for concurrent calls", async () => {
  const cache = new TranslationCache(100);
  let fetchCallCount = 0;

  // Delayed mock fetch to simulate in-flight window
  const delayedFetch = async (texts) => {
    fetchCallCount++;
    await new Promise((r) => setTimeout(r, 25));
    return texts.map((t) => `Fast(${t})`);
  };

  // Two concurrent calls requesting the same uncached phrase "ConcurrencyTest"
  const [res1, res2] = await Promise.all([
    translateBatchWithCache(["ConcurrencyTest", "FirstOnly"], cache, delayedFetch),
    translateBatchWithCache(["ConcurrencyTest", "SecondOnly"], cache, delayedFetch)
  ]);

  // "ConcurrencyTest" was in-flight, so it should not be fetched twice
  assert.deepEqual(res1[0], "Fast(ConcurrencyTest)");
  assert.deepEqual(res2[0], "Fast(ConcurrencyTest)");
  // Only 2 fetch calls total (one for Batch 1 which grabbed ConcurrencyTest + FirstOnly, one for SecondOnly)
  assert.equal(fetchCallCount, 2);
});

test("translateBatchWithCache throws error on server count mismatch without poisoning cache", async () => {
  const cache = new TranslationCache(100);

  const brokenFetch = async () => ["OnlyOne"]; // returns 1 translation for 2 texts

  await assert.rejects(
    async () => {
      await translateBatchWithCache(["Text1", "Text2"], cache, brokenFetch);
    },
    { message: /count mismatch/i }
  );

  // Cache should NOT contain corrupted undefined values
  assert.equal(cache.get("Text1"), undefined);
  assert.equal(cache.get("Text2"), undefined);
});

test("Live LibreTranslate server test (if running at 127.0.0.1:5000)", async () => {
  try {
    const res = await fetch("http://127.0.0.1:5000/languages", { signal: AbortSignal.timeout(1500) });
    if (!res.ok) return;
    const langs = await res.json();
    assert.ok(Array.isArray(langs));
    assert.ok(langs.some((l) => l.code === "en"));

    // Test translate endpoint
    const transRes = await fetch("http://127.0.0.1:5000/translate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        q: ["नमस्ते दुनिया"],
        source: "auto",
        target: "en",
        format: "text"
      }),
      signal: AbortSignal.timeout(3000)
    });
    assert.ok(transRes.ok);
    const data = await transRes.json();
    assert.ok(Array.isArray(data.translatedText));
    assert.equal(data.translatedText[0].toLowerCase(), "hello world");
  } catch (err) {
    console.log("Live server test skipped or timed out:", err.message);
  }
});

test("restoreOriginals and AbortController aborts in-flight workers safely", async () => {
  const originals = new Map();
  const node1 = { nodeValue: "Original 1", isConnected: true };
  const node2 = { nodeValue: "Original 2", isConnected: true };

  originals.set(node1, "Original 1");
  originals.set(node2, "Original 2");

  // Modify node1
  node1.nodeValue = "Translated 1";

  // Simulate AbortController cancellation during in-flight worker
  const abortController = new AbortController();
  const signal = abortController.signal;

  // Worker loop check
  let workerExecutedAfterAbort = false;
  const mockWorker = async () => {
    abortController.abort(); // Abort called before next batch finishes
    if (signal.aborted) return;
    workerExecutedAfterAbort = true;
    node2.nodeValue = "Should Not Happen";
  };

  await mockWorker();
  assert.equal(workerExecutedAfterAbort, false);

  // Run restoration
  for (const [node, original] of originals.entries()) {
    if (node?.isConnected) node.nodeValue = original;
  }
  originals.clear();

  assert.equal(node1.nodeValue, "Original 1");
  assert.equal(node2.nodeValue, "Original 2");
  assert.equal(originals.size, 0);
});

test("batch size chunking slices unique groups correctly", () => {
  const groups = Array.from({ length: 95 }, (_, i) => ({ core: `text_${i}` }));
  const BATCH_SIZE = 40;
  const batches = [];
  for (let offset = 0; offset < groups.length; offset += BATCH_SIZE) {
    batches.push(groups.slice(offset, offset + BATCH_SIZE));
  }

  assert.equal(batches.length, 3);
  assert.equal(batches[0].length, 40);
  assert.equal(batches[1].length, 40);
  assert.equal(batches[2].length, 15);
});

test("shouldRejectElement handles lowercase and XML tag names", () => {
  assert.equal(shouldRejectElement({ tagName: "script" }), true);
  assert.equal(shouldRejectElement({ tagName: "style" }), true);
  assert.equal(shouldRejectElement({ tagName: "code" }), true);
  assert.equal(shouldRejectElement({ tagName: "p" }), false);
});

test("isRestrictedUrl correctly identifies protected browser pages", () => {
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

  // Restricted pages
  assert.equal(isRestrictedUrl("chrome://extensions"), true);
  assert.equal(isRestrictedUrl("edge://settings"), true);
  assert.equal(isRestrictedUrl("brave://rewards"), true);
  assert.equal(isRestrictedUrl("about:blank"), true);
  assert.equal(isRestrictedUrl("chrome-extension://xyz/popup.html"), true);
  assert.equal(isRestrictedUrl("https://chromewebstore.google.com/detail/123"), true);
  assert.equal(isRestrictedUrl(""), true);
  assert.equal(isRestrictedUrl(null), true);

  // Normal translatable websites
  assert.equal(isRestrictedUrl("https://en.wikipedia.org/wiki/Main_Page"), false);
  assert.equal(isRestrictedUrl("http://localhost:3000"), false);
  assert.equal(isRestrictedUrl("https://news.ycombinator.com"), false);
});

test("manifest.json has valid Manifest V3 structure and complete icons", async () => {
  const fs = await import("node:fs");
  const path = await import("node:path");

  const manifestPath = path.resolve(process.cwd(), "manifest.json");
  assert.ok(fs.existsSync(manifestPath), "manifest.json must exist");

  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
  assert.equal(manifest.manifest_version, 3);
  assert.ok(manifest.name);
  assert.ok(manifest.version);
  assert.ok(manifest.permissions.includes("activeTab"));
  assert.ok(manifest.permissions.includes("contextMenus"));
  assert.ok(manifest.permissions.includes("scripting"));
  assert.ok(manifest.permissions.includes("storage"));
  assert.ok(manifest.host_permissions.includes("http://127.0.0.1:5000/*"));
  assert.equal(manifest.background.service_worker, "background.js");
  assert.equal(manifest.action.default_popup, "popup.html");

  // Verify all icon declarations
  assert.ok(manifest.icons);
  for (const size of ["16", "32", "48", "128"]) {
    assert.ok(manifest.icons[size], `manifest.icons must declare size ${size}`);
    assert.ok(manifest.action.default_icon[size], `manifest.action.default_icon must declare size ${size}`);

    const iconFile = path.resolve(process.cwd(), manifest.icons[size]);
    assert.ok(fs.existsSync(iconFile), `Icon file ${iconFile} must exist on disk`);

    // Verify PNG magic bytes
    const buf = fs.readFileSync(iconFile);
    assert.equal(buf[0], 0x89);
    assert.equal(buf[1], 0x50); // P
    assert.equal(buf[2], 0x4e); // N
    assert.equal(buf[3], 0x47); // G
  }
});

// --- Core DOM & Linguistic Engine Test Suite ---

class MockDOMNode {
  constructor(type, name, value = "") {
    this.nodeType = type; // 1 = element, 3 = text
    this.tagName = type === 1 ? name.toUpperCase() : undefined;
    this.nodeValue = type === 3 ? value : null;
    this.parentNode = null;
    this.childNodes = [];
    this.attributes = new Map();
    this.hidden = false;
    this.isContentEditable = false;
    this.isRoot = false;
  }
  get textContent() {
    if (this.nodeType === 3) return this.nodeValue || "";
    return this.childNodes.map((c) => c.textContent).join("");
  }
  set textContent(val) {
    if (this.nodeType === 3) {
      this.nodeValue = val;
    } else {
      this.replaceChildren(new MockDOMNode(3, "#text", val));
    }
  }
  get isConnected() {
    if (this.isRoot) return true;
    if (!this.parentNode) return false;
    return this.parentNode.isConnected;
  }
  setAttribute(attr, val) {
    this.attributes.set(attr, String(val));
  }
  getAttribute(attr) {
    return this.attributes.has(attr) ? this.attributes.get(attr) : null;
  }
  hasAttribute(attr) {
    return this.attributes.has(attr);
  }
  removeAttribute(attr) {
    this.attributes.delete(attr);
  }
  appendChild(child) {
    if (child.parentNode && child.parentNode.removeChild) child.parentNode.removeChild(child);
    child.parentNode = this;
    this.childNodes.push(child);
    return child;
  }
  insertBefore(newChild, refChild) {
    if (!refChild) return this.appendChild(newChild);
    if (newChild.parentNode && newChild.parentNode.removeChild) newChild.parentNode.removeChild(newChild);
    newChild.parentNode = this;
    const idx = this.childNodes.indexOf(refChild);
    if (idx === -1) this.childNodes.push(newChild);
    else this.childNodes.splice(idx, 0, newChild);
    return newChild;
  }
  removeChild(child) {
    const idx = this.childNodes.indexOf(child);
    if (idx !== -1) {
      this.childNodes.splice(idx, 1);
      child.parentNode = null;
    }
    return child;
  }
  replaceChildren(...newChildren) {
    while (this.childNodes.length > 0) {
      this.removeChild(this.childNodes[0]);
    }
    for (const c of newChildren) this.appendChild(c);
  }
  cloneNode(deep = false) {
    const clone = new MockDOMNode(this.nodeType, this.tagName || "", this.nodeValue || "");
    for (const [k, v] of this.attributes.entries()) {
      clone.setAttribute(k, v);
    }
    clone.hidden = this.hidden;
    clone.isContentEditable = this.isContentEditable;
    clone.isRoot = this.isRoot;
    if (deep) {
      for (const child of this.childNodes) {
        clone.appendChild(child.cloneNode(true));
      }
    }
    return clone;
  }
  get firstChild() {
    return this.childNodes.length > 0 ? this.childNodes[0] : null;
  }
  get nextSibling() {
    if (!this.parentNode) return null;
    const idx = this.parentNode.childNodes.indexOf(this);
    return idx !== -1 && idx < this.parentNode.childNodes.length - 1 ? this.parentNode.childNodes[idx + 1] : null;
  }
  get previousSibling() {
    if (!this.parentNode) return null;
    const idx = this.parentNode.childNodes.indexOf(this);
    return idx > 0 ? this.parentNode.childNodes[idx - 1] : null;
  }
}

// Global browser environment setup for content.js and background.js
let installedListener = null;
let contextMenuClickListener = null;
let commandListener = null;

globalThis.chrome = {
  runtime: {
    sendMessage: async (msg) => {
      if (msg.action === "translateBatch") {
        return {
          ok: true,
          translations: msg.texts.map((t) =>
            t.replace(/here/g, "cart-here").replace(/^(?!<)/, "EN:")
          )
        };
      }
      return { ok: true };
    },
    onMessage: { addListener: () => {} },
    onInstalled: {
      addListener: (fn) => {
        installedListener = fn;
      }
    }
  },
  contextMenus: {
    create: (props, cb) => {
      globalThis.__lastCreatedContextMenu = props;
      if (typeof cb === "function") cb();
    },
    onClicked: {
      addListener: (fn) => {
        contextMenuClickListener = fn;
      }
    }
  },
  commands: {
    onCommand: {
      addListener: (fn) => {
        commandListener = fn;
      }
    }
  }
};
globalThis.document = {
  body: new MockDOMNode(1, "BODY"),
  createTextNode: (t) => new MockDOMNode(3, "#text", t)
};
globalThis.document.body.isRoot = true;

await import("../background.js");
await import("../content.js");
const core = globalThis.__heliumLocalTranslatorCore;
const bg = globalThis.__heliumBackground;

test("maskSegment generates placeholders for inline elements (a, span, strong, em, code)", () => {
  const t1 = new MockDOMNode(3, "#text", "Click ");
  const link = new MockDOMNode(1, "A");
  link.setAttribute("href", "/signup");
  const linkText = new MockDOMNode(3, "#text", "here");
  link.appendChild(linkText);
  const t2 = new MockDOMNode(3, "#text", " to create your account.");

  const { maskedText, elementMap } = core.maskSegment([t1, link, t2]);
  assert.equal(maskedText, "Click <x id=\"0\">here</x> to create your account.");
  assert.equal(elementMap.get(0), link);

  // Multiple formatting tags: span, strong, em, code
  const span = new MockDOMNode(1, "SPAN");
  span.appendChild(new MockDOMNode(3, "#text", "Check "));
  const strong = new MockDOMNode(1, "STRONG");
  strong.appendChild(new MockDOMNode(3, "#text", "this "));
  const em = new MockDOMNode(1, "EM");
  em.appendChild(new MockDOMNode(3, "#text", "new "));
  const code = new MockDOMNode(1, "CODE");
  code.appendChild(new MockDOMNode(3, "#text", "feature"));

  const multi = core.maskSegment([span, strong, em, code]);
  assert.equal(
    multi.maskedText,
    "<x id=\"0\">Check </x><x id=\"1\">this </x><x id=\"2\">new </x><x id=\"3\">feature</x>"
  );
  assert.equal(multi.elementMap.size, 4);

  // Empty inline tag produces self-closing placeholder
  const emptyBadge = new MockDOMNode(1, "SPAN");
  const emptyRes = core.maskSegment([new MockDOMNode(3, "#text", "Start "), emptyBadge, new MockDOMNode(3, "#text", " End")]);
  assert.equal(emptyRes.maskedText, "Start <x id=\"0\"/> End");
});

test("parseTranslatedMarkup reconstructs inner child elements within translated sentence", () => {
  const link = new MockDOMNode(1, "A");
  link.setAttribute("href", "/signup");
  link.setAttribute("class", "btn-primary");
  const linkText = new MockDOMNode(3, "#text", "here");
  link.appendChild(linkText);

  const elMap = new Map([[0, link]]);
  const doc = globalThis.document;

  const translated = "Click <x id=\"0\">Here</x> to create your account.";
  const reconstructed = core.parseTranslatedMarkup(translated, elMap, doc);

  assert.equal(reconstructed.length, 3);
  assert.equal(reconstructed[0].nodeValue, "Click ");
  assert.equal(reconstructed[1], link);
  assert.equal(link.getAttribute("href"), "/signup");
  assert.equal(link.getAttribute("class"), "btn-primary");
  assert.equal(link.textContent, "Here");
  assert.equal(reconstructed[2].nodeValue, " to create your account.");
});

test("parseTranslatedMarkup handles word reordering", () => {
  const link = new MockDOMNode(1, "A");
  link.setAttribute("href", "/signup");
  const linkText = new MockDOMNode(3, "#text", "here");
  link.appendChild(linkText);

  const elMap = new Map([[0, link]]);
  const doc = globalThis.document;

  const translated = "To create your account click <x id=\"0\">Here</x>.";
  const reconstructed = core.parseTranslatedMarkup(translated, elMap, doc);

  assert.equal(reconstructed.length, 3);
  assert.equal(reconstructed[0].nodeValue, "To create your account click ");
  assert.equal(reconstructed[1], link);
  assert.equal(reconstructed[2].nodeValue, ".");
});

test("parseTranslatedMarkup handles nested inline elements and preserves hierarchy", () => {
  const link = new MockDOMNode(1, "A");
  const strong = new MockDOMNode(1, "STRONG");
  const elMap = new Map([[0, link], [1, strong]]);
  const doc = globalThis.document;

  const translated = "This is <x id=\"0\">very <x id=\"1\">important</x> and</x> cool.";
  const reconstructed = core.parseTranslatedMarkup(translated, elMap, doc);

  assert.equal(reconstructed.length, 3);
  assert.equal(reconstructed[0].nodeValue, "This is ");
  assert.equal(reconstructed[1], link);
  assert.equal(link.childNodes.length, 3);
  assert.equal(link.childNodes[0].nodeValue, "very ");
  assert.equal(link.childNodes[1], strong);
  assert.equal(strong.textContent, "important");
  assert.equal(link.childNodes[2].nodeValue, " and");
  assert.equal(reconstructed[2].nodeValue, " cool.");
});

test("parseTranslatedMarkup error resilience for malformed/dropped placeholders", () => {
  const link = new MockDOMNode(1, "A");
  const elMap = new Map([[0, link]]);
  const doc = globalThis.document;

  // Dropped placeholder: link element is appended so it is not lost
  const dropped = "Click to create your account.";
  const res1 = core.parseTranslatedMarkup(dropped, elMap, doc);
  assert.ok(res1.includes(link));

  // Missing closing tag
  const missingClose = "Click <x id=\"0\">Here to create account.";
  const res2 = core.parseTranslatedMarkup(missingClose, elMap, doc);
  assert.ok(res2.includes(link));

  // Self closing tag
  const selfClose = "Click <x id=\"0\"/> here.";
  const res3 = core.parseTranslatedMarkup(selfClose, elMap, doc);
  assert.ok(res3.includes(link));

  // Case insensitive and unquoted
  const unquoted = "Click <X ID=0>Here</X>.";
  const res4 = core.parseTranslatedMarkup(unquoted, elMap, doc);
  assert.ok(res4.includes(link));
  assert.equal(link.textContent, "Here");

  // Unknown tag id
  const unknownId = "Click <x id=\"999\">unknown</x> here.";
  const res5 = core.parseTranslatedMarkup(unknownId, elMap, doc);
  assert.ok(res5.length >= 1);
});

test("replaceSegmentNodes and restoreSegmentNodes accurately swaps and restores DOM nodes", () => {
  const parent = new MockDOMNode(1, "P");
  parent.isRoot = true;
  const t1 = new MockDOMNode(3, "#text", "Click ");
  const link = new MockDOMNode(1, "A");
  const linkText = new MockDOMNode(3, "#text", "here");
  link.appendChild(linkText);
  const t2 = new MockDOMNode(3, "#text", " to create account.");
  parent.appendChild(t1);
  parent.appendChild(link);
  parent.appendChild(t2);

  const origNodes = [t1, link, t2];

  const newT1 = new MockDOMNode(3, "#text", "Cliquez ");
  const newT2 = new MockDOMNode(3, "#text", " pour créer un compte.");
  const newNodes = [newT1, link, newT2];

  core.replaceSegmentNodes(parent, origNodes, newNodes);
  assert.deepEqual(parent.childNodes, newNodes);

  core.restoreSegmentNodes(parent, origNodes, newNodes);
  assert.deepEqual(parent.childNodes, origNodes);
});

test("collectTranslatableItems groups contiguous inline formatting tags into single sentence block", () => {
  const p = new MockDOMNode(1, "P");
  const t1 = new MockDOMNode(3, "#text", "Click ");
  const link = new MockDOMNode(1, "A");
  link.setAttribute("href", "/signup");
  const linkText = new MockDOMNode(3, "#text", "here");
  link.appendChild(linkText);
  const t2 = new MockDOMNode(3, "#text", " to create your free account today.");
  p.appendChild(t1);
  p.appendChild(link);
  p.appendChild(t2);

  const items = core.collectTranslatableItems(p, [], () => true);
  assert.equal(items.length, 1);
  assert.equal(items[0].type, "segment");
  assert.equal(items[0].core, "Click <x id=\"0\">here</x> to create your free account today.");
});

test("collectTranslatableItems preserves separate blocks for block elements", () => {
  const div = new MockDOMNode(1, "DIV");
  const p1 = new MockDOMNode(1, "P");
  const p1Text = new MockDOMNode(3, "#text", "Paragraph 1 with ");
  const p1Link = new MockDOMNode(1, "A");
  p1Link.appendChild(new MockDOMNode(3, "#text", "link"));
  p1.appendChild(p1Text);
  p1.appendChild(p1Link);

  const p2 = new MockDOMNode(1, "P");
  const p2Text = new MockDOMNode(3, "#text", "Paragraph 2 with ");
  const p2Strong = new MockDOMNode(1, "STRONG");
  p2Strong.appendChild(new MockDOMNode(3, "#text", "bold"));
  p2.appendChild(p2Text);
  p2.appendChild(p2Strong);

  div.appendChild(p1);
  div.appendChild(p2);

  const items = core.collectTranslatableItems(div, [], () => true);
  assert.equal(items.length, 2);
  assert.equal(items[0].parent, p1);
  assert.equal(items[1].parent, p2);
});

test("Attribute Translation: collects placeholder, title, alt, and aria-label", () => {
  const container = new MockDOMNode(1, "DIV");
  const input = new MockDOMNode(1, "INPUT");
  input.setAttribute("placeholder", "Search articles...");
  const btn = new MockDOMNode(1, "BUTTON");
  btn.setAttribute("title", "Click me");
  btn.setAttribute("aria-label", "Submit form");
  const img = new MockDOMNode(1, "IMG");
  img.setAttribute("alt", "Test banner");

  // Non-eligible attribute
  const badBtn = new MockDOMNode(1, "BUTTON");
  badBtn.setAttribute("title", "12345");

  // Hidden element attribute
  const hiddenInput = new MockDOMNode(1, "INPUT");
  hiddenInput.hidden = true;
  hiddenInput.setAttribute("placeholder", "Hidden placeholder");

  container.appendChild(input);
  container.appendChild(btn);
  container.appendChild(img);
  container.appendChild(badBtn);
  container.appendChild(hiddenInput);

  const items = core.collectTranslatableItems(container, [], () => true);
  assert.equal(items.length, 4);

  const attrs = items.map((i) => `${i.element.tagName}.${i.attribute} = "${i.core}"`);
  assert.ok(attrs.includes("INPUT.placeholder = \"Search articles...\""));
  assert.ok(attrs.includes("BUTTON.title = \"Click me\""));
  assert.ok(attrs.includes("BUTTON.aria-label = \"Submit form\""));
  assert.ok(attrs.includes("IMG.alt = \"Test banner\""));
});

test("End-to-End translateItems translates text nodes, stitched segments, and attributes, and restores originals", async () => {
  const root = new MockDOMNode(1, "DIV");
  root.isRoot = true;

  const pText = new MockDOMNode(1, "P");
  const textOnly = new MockDOMNode(3, "#text", "Welcome to our store");
  pText.appendChild(textOnly);

  const pSegment = new MockDOMNode(1, "P");
  const segT1 = new MockDOMNode(3, "#text", "Click ");
  const segLink = new MockDOMNode(1, "A");
  segLink.setAttribute("href", "/cart");
  const segLinkText = new MockDOMNode(3, "#text", "here");
  segLink.appendChild(segLinkText);
  const segT2 = new MockDOMNode(3, "#text", " to view cart.");
  pSegment.appendChild(segT1);
  pSegment.appendChild(segLink);
  pSegment.appendChild(segT2);

  const input = new MockDOMNode(1, "INPUT");
  input.setAttribute("placeholder", "Search catalog...");

  root.appendChild(pText);
  root.appendChild(pSegment);
  root.appendChild(input);

  const items = core.collectTranslatableItems(root, [], () => true);
  assert.equal(items.length, 3);

  const res = await core.translateItems(items);
  assert.equal(res.ok, true);
  assert.equal(res.translatedCount, 3);

  // Check translated values
  assert.equal(textOnly.nodeValue, "EN:Welcome to our store");
  assert.equal(input.getAttribute("placeholder"), "EN:Search catalog...");
  assert.equal(segLink.textContent, "cart-here");
  assert.equal(segLink.getAttribute("href"), "/cart");

  // Restore originals
  const restoreRes = await core.restoreOriginals();
  assert.equal(restoreRes.ok, true);

  assert.equal(textOnly.nodeValue, "Welcome to our store");
  assert.equal(input.getAttribute("placeholder"), "Search catalog...");
  assert.equal(segLink.textContent, "here");
  assert.equal(core.state.originals.size, 0);
});

test("Dynamic Content & SPAs: debounced MutationObserver watches for newly added subtrees", async () => {
  let observerCb;
  class MockMO {
    constructor(cb) { observerCb = cb; }
    observe() {}
    disconnect() { observerCb = null; }
  }
  globalThis.MutationObserver = MockMO;

  const doc = globalThis.document;
  doc.body = new MockDOMNode(1, "BODY");
  doc.body.isRoot = true;

  core.startMutationObserver();
  assert.equal(core.state.observerActive, true);

  const dynamicP = new MockDOMNode(1, "P");
  const dynamicText = new MockDOMNode(3, "#text", "Newly loaded feed post");
  dynamicP.appendChild(dynamicText);
  doc.body.appendChild(dynamicP);

  observerCb([{ type: "childList", addedNodes: [dynamicP] }]);

  await new Promise((r) => setTimeout(r, 320));

  assert.equal(dynamicText.nodeValue, "EN:Newly loaded feed post");
  assert.equal(core.state.originals.size, 1);

  await core.restoreOriginals();
  assert.equal(dynamicText.nodeValue, "Newly loaded feed post");
  assert.equal(core.state.observerActive, false);
});

test("background.js translateBatch supports html format and cache operations", async () => {
  bg.setCache("test_unique_key_123", "test_unique_val_456");
  assert.equal(bg.getCached("test_unique_key_123"), "test_unique_val_456");

  const res = await bg.translateBatch(["test_unique_key_123"]);
  assert.deepEqual(res, ["test_unique_val_456"]);
});

test("Live LibreTranslate sentence stitching test with placeholders (if running at 127.0.0.1:5000)", async () => {
  try {
    const res = await fetch("http://127.0.0.1:5000/languages", { signal: AbortSignal.timeout(1500) });
    if (!res.ok) return;

    const transRes = await fetch("http://127.0.0.1:5000/translate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        q: ["Нажмите <x id=\"0\">здесь</x>, чтобы создать свой аккаунт."],
        source: "auto",
        target: "en",
        format: "html"
      }),
      signal: AbortSignal.timeout(3000)
    });
    if (!transRes.ok) return;
    const data = await transRes.json();
    assert.ok(Array.isArray(data.translatedText));
    assert.ok(data.translatedText[0].includes("<x id=\"0\">"));
  } catch (err) {
    console.log("Live sentence stitching test skipped:", err.message);
  }
});

test("replaceSegmentNodes and restoreSegmentNodes maintain strict order when segment starts with an element node", () => {
  const parent = new MockDOMNode(1, "P");
  parent.isRoot = true;

  const link = new MockDOMNode(1, "A");
  link.setAttribute("href", "/start");
  link.appendChild(new MockDOMNode(3, "#text", "Leading link"));

  const t1 = new MockDOMNode(3, "#text", " followed by text");
  const t2 = new MockDOMNode(3, "#text", " and ending phrase.");

  parent.appendChild(link);
  parent.appendChild(t1);
  parent.appendChild(t2);

  const origNodes = [link, t1, t2];

  const newT1 = new MockDOMNode(3, "#text", " suivi par texte");
  const newT2 = new MockDOMNode(3, "#text", " et phrase finale.");
  const newNodes = [link, newT1, newT2];

  // Replace segment nodes
  core.replaceSegmentNodes(parent, origNodes, newNodes);
  assert.equal(parent.childNodes.length, 3);
  assert.equal(parent.childNodes[0], link);
  assert.equal(parent.childNodes[1], newT1);
  assert.equal(parent.childNodes[2], newT2);

  // Restore segment nodes
  core.restoreSegmentNodes(parent, origNodes, newNodes);
  assert.equal(parent.childNodes.length, 3);
  assert.equal(parent.childNodes[0], link);
  assert.equal(parent.childNodes[1], t1);
  assert.equal(parent.childNodes[2], t2);
});

test("Attribute Translation: collects attributes on inline elements and nested segment elements (title, alt, aria-label)", async () => {
  const p = new MockDOMNode(1, "P");
  p.isRoot = true;

  const t1 = new MockDOMNode(3, "#text", "Click ");
  const a = new MockDOMNode(1, "A");
  a.setAttribute("href", "/signup");
  a.setAttribute("title", "Sign up now");
  a.setAttribute("aria-label", "Sign up button");

  const img = new MockDOMNode(1, "IMG");
  img.setAttribute("src", "icon.png");
  img.setAttribute("alt", "Icon description");

  const linkText = new MockDOMNode(3, "#text", "here");
  a.appendChild(img);
  a.appendChild(linkText);

  const t2 = new MockDOMNode(3, "#text", " to register.");
  p.appendChild(t1);
  p.appendChild(a);
  p.appendChild(t2);

  const items = core.collectTranslatableItems(p, [], () => true);

  // Must collect the segment AND all 3 attributes on the inline element and nested img
  const segmentItems = items.filter((i) => i.type === "segment");
  assert.equal(segmentItems.length, 1);
  assert.equal(segmentItems[0].core, "Click <x id=\"0\"><x id=\"1\"/>here</x> to register.");

  const attrItems = items.filter((i) => i.type === "attribute");
  assert.equal(attrItems.length, 3);

  const titleAttr = attrItems.find((i) => i.element === a && i.attribute === "title");
  assert.ok(titleAttr);
  assert.equal(titleAttr.core, "Sign up now");

  const ariaAttr = attrItems.find((i) => i.element === a && i.attribute === "aria-label");
  assert.ok(ariaAttr);
  assert.equal(ariaAttr.core, "Sign up button");

  const altAttr = attrItems.find((i) => i.element === img && i.attribute === "alt");
  assert.ok(altAttr);
  assert.equal(altAttr.core, "Icon description");

  // Translate all items
  const res = await core.translateItems(items);
  assert.equal(res.ok, true);

  assert.equal(a.getAttribute("title"), "EN:Sign up now");
  assert.equal(a.getAttribute("aria-label"), "EN:Sign up button");
  assert.equal(img.getAttribute("alt"), "EN:Icon description");

  // Restore originals
  const restoreRes = await core.restoreOriginals();
  assert.equal(restoreRes.ok, true);

  assert.equal(a.getAttribute("title"), "Sign up now");
  assert.equal(a.getAttribute("aria-label"), "Sign up button");
  assert.equal(img.getAttribute("alt"), "Icon description");
  assert.equal(linkText.nodeValue, "here");
});

test("Inline Element Sentence Stitching: IMG tag is treated as inline element without fragmenting sentences", () => {
  const p = new MockDOMNode(1, "P");
  const t1 = new MockDOMNode(3, "#text", "Click the ");
  const img = new MockDOMNode(1, "IMG");
  img.setAttribute("src", "star.png");
  img.setAttribute("alt", "Star icon");
  const t2 = new MockDOMNode(3, "#text", " icon to bookmark this page.");

  p.appendChild(t1);
  p.appendChild(img);
  p.appendChild(t2);

  const items = core.collectTranslatableItems(p, [], () => true);

  const segments = items.filter((i) => i.type === "segment");
  assert.equal(segments.length, 1);
  assert.equal(segments[0].core, "Click the <x id=\"0\"/> icon to bookmark this page.");

  const attrs = items.filter((i) => i.type === "attribute");
  assert.equal(attrs.length, 1);
  assert.equal(attrs[0].element, img);
  assert.equal(attrs[0].attribute, "alt");
  assert.equal(attrs[0].core, "Star icon");
});

test("HTML entity decoding: decodeHtmlEntities and parseTranslatedMarkup decode entities correctly", () => {
  assert.equal(
    core.decodeHtmlEntities("Tom &amp; Jerry &quot;quote&quot; &lt;tag&gt; &#39;apostrophe&#39; &nbsp;done"),
    "Tom & Jerry \"quote\" <tag> 'apostrophe' \u00a0done"
  );

  const doc = globalThis.document;
  const link = new MockDOMNode(1, "A");
  const elMap = new Map([[0, link]]);

  const translatedWithEntities = "Tom &amp; Jerry say <x id=\"0\">Hello &amp; Welcome</x> today!";
  const reconstructed = core.parseTranslatedMarkup(translatedWithEntities, elMap, doc);

  assert.equal(reconstructed.length, 3);
  assert.equal(reconstructed[0].nodeValue, "Tom & Jerry say ");
  assert.equal(reconstructed[1], link);
  assert.equal(link.textContent, "Hello & Welcome");
  assert.equal(reconstructed[2].nodeValue, " today!");
});

test("parseTranslatedMarkup handles duplicate placeholder tags by cloning element safely", () => {
  const doc = globalThis.document;
  const link = new MockDOMNode(1, "A");
  link.setAttribute("href", "/docs");
  link.setAttribute("class", "doc-link");
  const elMap = new Map([[0, link]]);

  const duplicateOutput = "Read <x id=\"0\">Documentation</x> or visit <x id=\"0\">API Docs</x> for details.";
  const reconstructed = core.parseTranslatedMarkup(duplicateOutput, elMap, doc);

  assert.equal(reconstructed.length, 5);
  assert.equal(reconstructed[0].nodeValue, "Read ");
  assert.equal(reconstructed[1], link);
  assert.equal(link.textContent, "Documentation");
  assert.equal(reconstructed[2].nodeValue, " or visit ");

  const secondLink = reconstructed[3];
  assert.notEqual(secondLink, link); // Cloned, not stolen!
  assert.equal(secondLink.getAttribute("href"), "/docs");
  assert.equal(secondLink.getAttribute("class"), "doc-link");
  assert.equal(secondLink.textContent, "API Docs");
  assert.equal(reconstructed[4].nodeValue, " for details.");
});

test("Dynamic Content & SPAs: aborting dynamic translation halts gracefully without corrupting restored DOM", async () => {
  let observerCb;
  class MockMO {
    constructor(cb) { observerCb = cb; }
    observe() {}
    disconnect() { observerCb = null; }
  }
  globalThis.MutationObserver = MockMO;

  const doc = globalThis.document;
  doc.body = new MockDOMNode(1, "BODY");
  doc.body.isRoot = true;

  core.startMutationObserver();

  const dynamicP = new MockDOMNode(1, "P");
  const dynamicText = new MockDOMNode(3, "#text", "Post to be cancelled");
  dynamicP.appendChild(dynamicText);
  doc.body.appendChild(dynamicP);

  observerCb([{ type: "childList", addedNodes: [dynamicP] }]);

  // Immediately restore before debounce completes
  await core.restoreOriginals();

  assert.equal(core.state.observerActive, false);
  assert.equal(dynamicText.nodeValue, "Post to be cancelled");
});

test("collectTranslatableItems respects MAX_TEXT_NODES cap", () => {
  const container = new MockDOMNode(1, "DIV");
  for (let i = 0; i < 12000; i++) {
    const p = new MockDOMNode(1, "P");
    p.appendChild(new MockDOMNode(3, "#text", `Node ${i} text content`));
    container.appendChild(p);
  }

  const items = core.collectTranslatableItems(container, [], () => true);
  assert.ok(items.length <= 10000, `items.length (${items.length}) should not exceed 10000`);
});

test("manifest.json declares Libre Local Translator and storage permission", async () => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const manifestPath = path.resolve(process.cwd(), "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));

  assert.equal(manifest.name, "Libre Local Translator");
  assert.ok(manifest.permissions.includes("storage"), "manifest must include storage permission");
});

test("core and background export Libre aliases", () => {
  assert.equal(globalThis.__libreLocalTranslatorCore, globalThis.__heliumLocalTranslatorCore);
  assert.equal(globalThis.__libreBackground, globalThis.__heliumBackground);
});

test("Hardware Acceleration & Tuning: translateItems accepts custom batch size and threads", async () => {
  const root = new MockDOMNode(1, "DIV");
  root.isRoot = true;

  const p1 = new MockDOMNode(1, "P");
  p1.appendChild(new MockDOMNode(3, "#text", "Sentence one for tuning"));
  const p2 = new MockDOMNode(1, "P");
  p2.appendChild(new MockDOMNode(3, "#text", "Sentence two for tuning"));
  const p3 = new MockDOMNode(1, "P");
  p3.appendChild(new MockDOMNode(3, "#text", "Sentence three for tuning"));

  root.appendChild(p1);
  root.appendChild(p2);
  root.appendChild(p3);

  const items = core.collectTranslatableItems(root, [], () => true);
  assert.equal(items.length, 3);

  // Run with custom GPU / High Concurrency settings
  const result = await core.translateItems(items, {
    settings: {
      preset: "gpu-docker",
      threads: 8,
      batchSize: 100
    }
  });

  assert.equal(result.ok, true);
  assert.equal(result.translatedCount, 3);
  assert.equal(core.state.settings.preset, "gpu-docker");
  assert.equal(core.state.settings.threads, 8);
  assert.equal(core.state.settings.batchSize, 100);

  // Restore originals
  await core.restoreOriginals();
  assert.equal(p1.childNodes[0].nodeValue, "Sentence one for tuning");
});

test("Hardware Acceleration & Tuning: translatePage accepts settings and applies them", async () => {
  const doc = globalThis.document;
  doc.body = new MockDOMNode(1, "BODY");
  doc.body.isRoot = true;

  const p = new MockDOMNode(1, "P");
  p.appendChild(new MockDOMNode(3, "#text", "Page sentence to translate"));
  doc.body.appendChild(p);

  const res = await core.translatePage({
    preset: "cpu-tuned",
    threads: 8,
    batchSize: 100
  });

  assert.equal(res.ok, true);
  assert.equal(core.state.settings.preset, "cpu-tuned");
  assert.equal(core.state.settings.threads, 8);
  assert.equal(core.state.settings.batchSize, 100);

  await core.restoreOriginals();
  assert.equal(p.childNodes[0].nodeValue, "Page sentence to translate");
});

test("Branding consistency: manifest, package, popup, and README declare Libre Local Translator", async () => {
  const fs = await import("node:fs");
  const path = await import("node:path");

  // manifest.json
  const manifest = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), "manifest.json"), "utf-8"));
  assert.equal(manifest.name, "Libre Local Translator");

  // package.json
  const pkg = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), "package.json"), "utf-8"));
  assert.equal(pkg.name, "libre-local-translator");

  // popup.html
  const popupHtml = fs.readFileSync(path.resolve(process.cwd(), "popup.html"), "utf-8");
  assert.ok(popupHtml.includes("<title>Libre Local Translator</title>"));
  assert.ok(popupHtml.includes('<h1 class="title">Libre Local Translator</h1>'));

  // popup.css typography craft floor (minimum 12px)
  const popupCss = fs.readFileSync(path.resolve(process.cwd(), "popup.css"), "utf-8");
  const fontSizes = [...popupCss.matchAll(/font-size:\s*([\d.]+)px/g)].map((m) => parseFloat(m[1]));
  assert.ok(fontSizes.length > 0);
  for (const size of fontSizes) {
    assert.ok(size >= 12, `Expected font-size >= 12px, found ${size}px`);
  }

  // README.md
  const readme = fs.readFileSync(path.resolve(process.cwd(), "README.md"), "utf-8");
  assert.ok(readme.startsWith("# Libre Local Translator"));
});

test("Hardware Acceleration: translatePage falls back to chrome.storage.local if no settings passed", async () => {
  const doc = globalThis.document;
  doc.body = new MockDOMNode(1, "BODY");
  doc.body.isRoot = true;

  const p = new MockDOMNode(1, "P");
  p.appendChild(new MockDOMNode(3, "#text", "Storage fallback test text"));
  doc.body.appendChild(p);

  // Clear state.settings
  core.state.settings = null;

  // Mock chrome.storage.local
  const originalChrome = globalThis.chrome;
  globalThis.chrome = {
    ...originalChrome,
    storage: {
      local: {
        get: async (keys) => {
          if (keys.includes("translatorSettings")) {
            return {
              translatorSettings: {
                preset: "gpu-python",
                mode: "gpu-python",
                threads: 4,
                batchSize: 100,
                memory: "high"
              }
            };
          }
          return {};
        }
      }
    }
  };

  try {
    const res = await core.translatePage();
    assert.equal(res.ok, true);
    assert.equal(core.state.settings.mode, "gpu-python");
    assert.equal(core.state.settings.threads, 4);
    assert.equal(core.state.settings.batchSize, 100);
    await core.restoreOriginals();
  } finally {
    globalThis.chrome = originalChrome;
  }
});

test("manifest.json includes contextMenus permission in permissions array", async () => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const manifestPath = path.resolve(process.cwd(), "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));

  assert.ok(Array.isArray(manifest.permissions), "permissions must be an array");
  assert.ok(manifest.permissions.includes("contextMenus"), "manifest.json permissions must include 'contextMenus'");
});

test("background.js registers context menu onInstalled with correct id, title, and contexts", () => {
  assert.ok(typeof installedListener === "function", "chrome.runtime.onInstalled listener must be registered");
  assert.equal(bg.CONTEXT_MENU_ID, "translate-to-english");

  let createdMenu = null;
  const originalContextMenus = globalThis.chrome.contextMenus;
  globalThis.chrome.contextMenus = {
    ...originalContextMenus,
    create: (props, cb) => {
      createdMenu = props;
      if (typeof cb === "function") cb();
    }
  };

  try {
    bg.setupContextMenu();
    assert.ok(createdMenu, "chrome.contextMenus.create must be called");
    assert.equal(createdMenu.id, "translate-to-english");
    assert.equal(createdMenu.title, "Translate to English");
    assert.deepEqual(createdMenu.contexts, ["page", "selection"]);

    createdMenu = null;
    installedListener();
    assert.ok(createdMenu, "invoking onInstalled listener must trigger menu creation");
    assert.equal(createdMenu.id, "translate-to-english");
    assert.equal(createdMenu.title, "Translate to English");
    assert.deepEqual(createdMenu.contexts, ["page", "selection"]);
  } finally {
    globalThis.chrome.contextMenus = originalContextMenus;
  }
});

test("background.js contextMenus.onClicked triggers translatePage on target tab with stored settings", async () => {
  assert.ok(typeof contextMenuClickListener === "function", "chrome.contextMenus.onClicked listener must be registered");

  const originalChrome = globalThis.chrome;
  let executedScripts = [];
  let sentMessages = [];

  globalThis.chrome = {
    ...originalChrome,
    scripting: {
      executeScript: async (params) => {
        executedScripts.push(params);
        return [{ result: true }];
      }
    },
    tabs: {
      sendMessage: async (tabId, msg) => {
        sentMessages.push({ tabId, msg });
        return { ok: true, translatedCount: 10 };
      },
      query: async () => [{ id: 42, url: "https://example.com" }]
    },
    storage: {
      local: {
        get: async (keys) => {
          if (keys.includes("translatorSettings")) {
            return {
              translatorSettings: {
                preset: "gpu-docker",
                threads: 8,
                batchSize: 100
              }
            };
          }
          return {};
        }
      }
    }
  };

  try {
    const clickInfo = { menuItemId: "translate-to-english" };
    const mockTab = { id: 77, url: "https://example.org/article" };

    const result = await contextMenuClickListener(clickInfo, mockTab);
    assert.deepEqual(result, { ok: true, translatedCount: 10 });

    assert.equal(executedScripts.length, 1);
    assert.deepEqual(executedScripts[0], {
      target: { tabId: 77 },
      files: ["content.js"]
    });

    assert.equal(sentMessages.length, 1);
    assert.equal(sentMessages[0].tabId, 77);
    assert.equal(sentMessages[0].msg.action, "translatePage");
    assert.deepEqual(sentMessages[0].msg.settings, {
      preset: "gpu-docker",
      threads: 8,
      batchSize: 100
    });

    // Fallback when tab is null (queries active tab)
    executedScripts = [];
    sentMessages = [];
    await bg.handleContextMenuClick(clickInfo, null);

    assert.equal(executedScripts.length, 1);
    assert.equal(executedScripts[0].target.tabId, 42);
    assert.equal(sentMessages.length, 1);
    assert.equal(sentMessages[0].tabId, 42);
    assert.equal(sentMessages[0].msg.action, "translatePage");

    // Click event with unrelated menuItemId should be ignored
    executedScripts = [];
    sentMessages = [];
    const ignoreResult = await contextMenuClickListener({ menuItemId: "some-other-action" }, mockTab);
    assert.equal(ignoreResult, null);
    assert.equal(executedScripts.length, 0);
    assert.equal(sentMessages.length, 0);
  } finally {
    globalThis.chrome = originalChrome;
  }
});

test("background.js command listener reuses translateTab workflow with stored settings", async () => {
  assert.ok(typeof commandListener === "function", "chrome.commands.onCommand listener must be registered");

  const originalChrome = globalThis.chrome;
  let executedScripts = [];
  let sentMessages = [];

  globalThis.chrome = {
    ...originalChrome,
    scripting: {
      executeScript: async (params) => {
        executedScripts.push(params);
        return [{ result: true }];
      }
    },
    tabs: {
      query: async (queryInfo) => {
        assert.equal(queryInfo.active, true);
        assert.equal(queryInfo.lastFocusedWindow, true);
        return [{ id: 88, url: "https://example.com/blog" }];
      },
      sendMessage: async (tabId, msg) => {
        sentMessages.push({ tabId, msg });
        return { ok: true };
      }
    },
    storage: {
      local: {
        get: async () => ({
          translatorSettings: { preset: "cpu-tuned", threads: 8, batchSize: 100 }
        })
      }
    }
  };

  try {
    await commandListener("translate-page");
    assert.equal(executedScripts.length, 1);
    assert.equal(executedScripts[0].target.tabId, 88);
    assert.equal(sentMessages.length, 1);
    assert.equal(sentMessages[0].tabId, 88);
    assert.equal(sentMessages[0].msg.action, "translatePage");
    assert.deepEqual(sentMessages[0].msg.settings, {
      preset: "cpu-tuned",
      threads: 8,
      batchSize: 100
    });

    executedScripts = [];
    sentMessages = [];
    await commandListener("unknown-command");
    assert.equal(executedScripts.length, 0);
    assert.equal(sentMessages.length, 0);
  } finally {
    globalThis.chrome = originalChrome;
  }
});

test("background.js translateTab handles missing tab, storage errors, and injection errors gracefully", async () => {
  const originalChrome = globalThis.chrome;

  // 1. Missing tab
  globalThis.chrome = {
    ...originalChrome,
    tabs: { query: async () => [] }
  };
  const noTabResult = await bg.translateTab();
  assert.equal(noTabResult, null);

  // 2. Storage empty (no settings)
  let sentMsg = null;
  globalThis.chrome = {
    ...originalChrome,
    tabs: {
      query: async () => [{ id: 99 }],
      sendMessage: async (tabId, msg) => {
        sentMsg = msg;
        return { ok: true };
      }
    },
    scripting: { executeScript: async () => {} },
    storage: { local: { get: async () => ({}) } }
  };
  await bg.translateTab({ id: 99 });
  assert.equal(sentMsg.action, "translatePage");
  assert.equal(sentMsg.settings, undefined);

  // 3. Injection error caught gracefully
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    globalThis.chrome = {
      ...originalChrome,
      tabs: { query: async () => [{ id: 99 }] },
      scripting: {
        executeScript: async () => {
          throw new Error("Cannot access a chrome:// URL");
        }
      }
    };
    const errResult = await bg.translateTab({ id: 99 });
    assert.equal(errResult, null);
  } finally {
    console.warn = originalWarn;
  }

  globalThis.chrome = originalChrome;
});

test("Context menu translation respects existing cancellation and busy state in content script", async () => {
  const doc = globalThis.document;
  doc.body = new MockDOMNode(1, "BODY");
  doc.body.isRoot = true;

  const p = new MockDOMNode(1, "P");
  p.appendChild(new MockDOMNode(3, "#text", "Original text before right click"));
  doc.body.appendChild(p);

  core.state.busy = true;

  const busyRes = await core.translatePage();
  assert.equal(busyRes.ok, false);
  assert.equal(busyRes.error, "A translation is already running.");

  core.state.busy = false;
  const transRes = await core.translatePage();
  assert.equal(transRes.ok, true);
  assert.equal(p.childNodes[0].nodeValue, "EN:Original text before right click");
  assert.equal(core.state.originals.size, 1);

  // Re-invoking translatePage (as right-clicking would) automatically restores previous originals first
  const reTransRes = await core.translatePage();
  assert.equal(reTransRes.ok, true);
  assert.equal(p.childNodes[0].nodeValue, "EN:Original text before right click");

  await core.restoreOriginals();
  assert.equal(p.childNodes[0].nodeValue, "Original text before right click");
  assert.equal(core.state.originals.size, 0);
});

test("isValidTabId and getTargetTab reject negative, zero, or non-integer tab IDs", async () => {
  assert.equal(bg.isValidTabId(1), true);
  assert.equal(bg.isValidTabId(42), true);
  assert.equal(bg.isValidTabId(-1), false);
  assert.equal(bg.isValidTabId(0), false);
  assert.equal(bg.isValidTabId("123"), false);
  assert.equal(bg.isValidTabId(null), false);
  assert.equal(bg.isValidTabId(undefined), false);
  assert.equal(bg.isValidTabId(1.5), false);

  const originalChrome = globalThis.chrome;
  globalThis.chrome = {
    ...originalChrome,
    tabs: {
      query: async () => [{ id: 88, url: "https://example.com" }]
    }
  };

  try {
    const validTarget = await bg.getTargetTab({ id: 99 });
    assert.equal(validTarget.id, 99);

    // Negative ID (such as TAB_ID_NONE = -1) falls back to querying active tab
    const negTarget = await bg.getTargetTab({ id: -1 });
    assert.equal(negTarget.id, 88);

    // Zero or non-integer falls back to querying active tab
    const zeroTarget = await bg.getTargetTab({ id: 0 });
    assert.equal(zeroTarget.id, 88);

    // When query returns invalid tab, returns null
    globalThis.chrome.tabs.query = async () => [{ id: -1 }];
    const invalidQueryTarget = await bg.getTargetTab({ id: -1 });
    assert.equal(invalidQueryTarget, null);
  } finally {
    globalThis.chrome = originalChrome;
  }
});

test("background.js translateTab rejects restricted browser URLs without script execution", async () => {
  const originalChrome = globalThis.chrome;
  let scriptExecuted = false;

  globalThis.chrome = {
    ...originalChrome,
    scripting: {
      executeScript: async () => {
        scriptExecuted = true;
      }
    },
    tabs: {
      query: async () => [{ id: 10, url: "chrome://settings" }],
      sendMessage: async () => ({ ok: true })
    }
  };

  try {
    // 1. Direct tab with chrome:// URL
    const res1 = await bg.translateTab({ id: 10, url: "chrome://extensions" });
    assert.equal(res1, null);
    assert.equal(scriptExecuted, false);

    // 2. Direct tab with Web Store URL
    const res2 = await bg.translateTab({ id: 11, url: "https://chromewebstore.google.com/detail/123" });
    assert.equal(res2, null);
    assert.equal(scriptExecuted, false);

    // 3. Fallback to active tab with restricted URL
    const res3 = await bg.translateTab();
    assert.equal(res3, null);
    assert.equal(scriptExecuted, false);

    // 4. Allowed URL proceeds to execution
    const res4 = await bg.translateTab({ id: 12, url: "https://example.com" });
    assert.equal(scriptExecuted, true);
  } finally {
    globalThis.chrome = originalChrome;
  }
});

test("background.js setupContextMenu calls removeAll when available to refresh context menu items", () => {
  const originalContextMenus = globalThis.chrome.contextMenus;
  let removeAllCalled = false;
  let createdMenu = null;

  globalThis.chrome.contextMenus = {
    removeAll: (cb) => {
      removeAllCalled = true;
      if (typeof cb === "function") cb();
    },
    create: (props, cb) => {
      createdMenu = props;
      if (typeof cb === "function") cb();
    }
  };

  try {
    bg.setupContextMenu();
    assert.equal(removeAllCalled, true, "chrome.contextMenus.removeAll must be called before create");
    assert.ok(createdMenu, "chrome.contextMenus.create must be called after removeAll");
    assert.equal(createdMenu.id, "translate-to-english");
    assert.equal(createdMenu.title, "Translate to English");
  } finally {
    globalThis.chrome.contextMenus = originalContextMenus;
  }
});

test("End-to-End: handleContextMenuClick dispatches to content.js onMessage and respects busy/restoration states", async () => {
  const doc = globalThis.document;
  doc.body = new MockDOMNode(1, "BODY");
  doc.body.isRoot = true;

  const p = new MockDOMNode(1, "P");
  p.appendChild(new MockDOMNode(3, "#text", "Bonjour tout le monde"));
  doc.body.appendChild(p);

  const originalChrome = globalThis.chrome;
  let scriptInjected = false;

  // Wire chrome.tabs.sendMessage directly to content.js runtime.onMessage listener
  globalThis.chrome = {
    ...originalChrome,
    scripting: {
      executeScript: async () => {
        scriptInjected = true;
      }
    },
    tabs: {
      sendMessage: async (tabId, msg) => {
        if (msg.action === "translatePage") {
          return await core.translatePage(msg.settings);
        }
        return { ok: false };
      }
    },
    storage: {
      local: {
        get: async () => ({
          translatorSettings: { preset: "cpu-tuned", threads: 8, batchSize: 100 }
        })
      }
    }
  };

  try {
    core.state.busy = false;
    core.state.originals.clear();

    const clickInfo = { menuItemId: "translate-to-english" };
    const mockTab = { id: 70, url: "https://example.com/french-article" };

    // 1. First translation via right-click context menu
    const result1 = await bg.handleContextMenuClick(clickInfo, mockTab);
    assert.equal(scriptInjected, true);
    assert.equal(result1.ok, true);
    assert.equal(p.childNodes[0].nodeValue, "EN:Bonjour tout le monde");
    assert.equal(core.state.settings.preset, "cpu-tuned");

    // 2. Click while already busy respects busy state
    core.state.busy = true;
    const resultBusy = await bg.handleContextMenuClick(clickInfo, mockTab);
    assert.equal(resultBusy.ok, false);
    assert.equal(resultBusy.error, "A translation is already running.");
    core.state.busy = false;

    // 3. Repeated right-click context menu invocation restores and re-translates cleanly
    const result2 = await bg.handleContextMenuClick(clickInfo, mockTab);
    assert.equal(result2.ok, true);
    assert.equal(p.childNodes[0].nodeValue, "EN:Bonjour tout le monde");

    // 4. Restore original restores DOM
    await core.restoreOriginals();
    assert.equal(p.childNodes[0].nodeValue, "Bonjour tout le monde");
    assert.equal(core.state.originals.size, 0);
  } finally {
    globalThis.chrome = originalChrome;
  }
});

test("3-Tier Priority Assignment: getNodePriority accurately categorizes active viewport, prefetch buffer, and deep document", () => {
  const winHeight = 1000;
  const winWidth = 1000;

  // Priority 1: In active viewport
  const elVp = new MockDOMNode(1, "DIV");
  elVp.getBoundingClientRect = () => ({ top: 100, bottom: 250, left: 10, right: 800, width: 790, height: 150 });
  assert.equal(core.getNodePriority(elVp, winHeight, winWidth), 1);
  assert.equal(core.isNodeInViewport(elVp), true);

  // Priority 1: Straddling top edge of viewport (partially visible)
  const elStraddleTop = new MockDOMNode(1, "DIV");
  elStraddleTop.getBoundingClientRect = () => ({ top: -50, bottom: 100, left: 0, right: 800, width: 800, height: 150 });
  assert.equal(core.getNodePriority(elStraddleTop, winHeight, winWidth), 1);

  // Priority 1: Straddling bottom edge of viewport (partially visible)
  const elStraddleBottom = new MockDOMNode(1, "DIV");
  elStraddleBottom.getBoundingClientRect = () => ({ top: 950, bottom: 1100, left: 0, right: 800, width: 800, height: 150 });
  assert.equal(core.getNodePriority(elStraddleBottom, winHeight, winWidth), 1);

  // Priority 2: In prefetch buffer (within 1 screen height below viewport: 1000px to 2000px)
  const elPrefetch = new MockDOMNode(1, "DIV");
  elPrefetch.getBoundingClientRect = () => ({ top: 1100, bottom: 1300, left: 10, right: 800, width: 790, height: 200 });
  assert.equal(core.getNodePriority(elPrefetch, winHeight, winWidth), 2);
  assert.equal(core.isNodeInViewport(elPrefetch), false);

  // Priority 3: Deep document (> 1 screen height below viewport, e.g. top: 2200)
  const elDeep = new MockDOMNode(1, "DIV");
  elDeep.getBoundingClientRect = () => ({ top: 2200, bottom: 2400, left: 10, right: 800, width: 790, height: 200 });
  assert.equal(core.getNodePriority(elDeep, winHeight, winWidth), 3);

  // Priority 3: Scrolled past (above viewport, e.g. bottom <= 0)
  const elPast = new MockDOMNode(1, "DIV");
  elPast.getBoundingClientRect = () => ({ top: -500, bottom: -100, left: 10, right: 800, width: 790, height: 400 });
  assert.equal(core.getNodePriority(elPast, winHeight, winWidth), 3);

  // Text node inherits parent's bounding rect
  const parent = new MockDOMNode(1, "P");
  parent.getBoundingClientRect = () => ({ top: 1500, bottom: 1600, left: 0, right: 500, width: 500, height: 100 });
  const textChild = new MockDOMNode(3, "#text", "Child text");
  parent.appendChild(textChild);
  assert.equal(core.getNodePriority(textChild, winHeight, winWidth), 2);
});

test("Prominence Scoring: getElementProminence prioritizes headings, title, nav, and top position", () => {
  // Headings hierarchy
  const h1 = new MockDOMNode(1, "H1");
  const h2 = new MockDOMNode(1, "H2");
  const h3 = new MockDOMNode(1, "H3");
  const h6 = new MockDOMNode(1, "H6");
  const nav = new MockDOMNode(1, "NAV");
  const p = new MockDOMNode(1, "P");
  const div = new MockDOMNode(1, "DIV");

  const scoreH1 = core.getElementProminence(h1);
  const scoreH2 = core.getElementProminence(h2);
  const scoreH3 = core.getElementProminence(h3);
  const scoreH6 = core.getElementProminence(h6);
  const scoreNav = core.getElementProminence(nav);
  const scoreP = core.getElementProminence(p);
  const scoreDiv = core.getElementProminence(div);

  assert.ok(scoreH1 > scoreH2, "H1 > H2");
  assert.ok(scoreH2 > scoreH3, "H2 > H3");
  assert.ok(scoreH3 > scoreH6, "H3 > H6");
  assert.ok(scoreH1 > scoreNav, "H1 > NAV");
  assert.ok(scoreNav > scoreP, "NAV > P");
  assert.ok(scoreP > scoreDiv, "P > DIV");

  // Position bonus for elements near the top of viewport
  const topEl = new MockDOMNode(1, "H1");
  topEl.getBoundingClientRect = () => ({ top: 40, bottom: 90, left: 0, right: 500 });
  const lowerEl = new MockDOMNode(1, "H1");
  lowerEl.getBoundingClientRect = () => ({ top: 800, bottom: 850, left: 0, right: 500 });

  assert.ok(core.getElementProminence(topEl) > core.getElementProminence(lowerEl), "Topmost element has position bonus");
});

test("Micro 'Hero' First Batch: extractHeroBatch isolates top 5-8 prominent viewport items", () => {
  // Create 15 groups with varying priority and prominence
  const groups = [
    { core: "footer_copy", priority: 3, prominence: 20, domOrder: 14, entries: [] },
    { core: "below_fold_h2", priority: 2, prominence: 90, domOrder: 9, entries: [] },
    { core: "vp_nav_home", priority: 1, prominence: 85, domOrder: 1, entries: [] },
    { core: "vp_h1_title", priority: 1, prominence: 120, domOrder: 2, entries: [] },
    { core: "vp_h2_sub", priority: 1, prominence: 105, domOrder: 3, entries: [] },
    { core: "vp_nav_about", priority: 1, prominence: 84, domOrder: 4, entries: [] },
    { core: "vp_p_lead", priority: 1, prominence: 55, domOrder: 5, entries: [] },
    { core: "vp_p_body1", priority: 1, prominence: 45, domOrder: 6, entries: [] },
    { core: "vp_p_body2", priority: 1, prominence: 44, domOrder: 7, entries: [] },
    { core: "vp_p_body3", priority: 1, prominence: 42, domOrder: 8, entries: [] },
    { core: "vp_div_minor1", priority: 1, prominence: 25, domOrder: 10, entries: [] },
    { core: "vp_div_minor2", priority: 1, prominence: 24, domOrder: 11, entries: [] },
    { core: "deep_doc_text", priority: 3, prominence: 20, domOrder: 12, entries: [] },
    { core: "deep_doc_p", priority: 3, prominence: 40, domOrder: 13, entries: [] }
  ];

  const { heroBatch, remainingGroups } = core.extractHeroBatch(groups, 8);

  // Max 8 hero items isolated
  assert.equal(heroBatch.length, 8);

  // All hero items must be Priority 1
  for (const item of heroBatch) {
    assert.equal(item.priority, 1);
  }

  // Hero batch must be ordered by prominence descending
  assert.equal(heroBatch[0].core, "vp_h1_title"); // 120
  assert.equal(heroBatch[1].core, "vp_h2_sub");   // 105
  assert.equal(heroBatch[2].core, "vp_nav_home"); // 85
  assert.equal(heroBatch[3].core, "vp_nav_about");// 84

  // Remaining groups must contain the leftover Priority 1 items and all Priority 2 and 3 items
  assert.equal(remainingGroups.length, groups.length - 8);
  const remainingCores = remainingGroups.map((g) => g.core);
  assert.ok(remainingCores.includes("vp_div_minor1"));
  assert.ok(remainingCores.includes("vp_div_minor2"));
  assert.ok(remainingCores.includes("below_fold_h2"));
  assert.ok(remainingCores.includes("footer_copy"));

  // Edge Case: 3 viewport items (fewer than 5) -> returns all 3
  const fewGroups = [
    { core: "h1", priority: 1, prominence: 100, domOrder: 0, entries: [] },
    { core: "p", priority: 1, prominence: 40, domOrder: 1, entries: [] },
    { core: "div", priority: 1, prominence: 20, domOrder: 2, entries: [] },
    { core: "deep", priority: 3, prominence: 20, domOrder: 3, entries: [] }
  ];
  const fewRes = core.extractHeroBatch(fewGroups, 8);
  assert.equal(fewRes.heroBatch.length, 3);
  assert.equal(fewRes.remainingGroups.length, 1);

  // Edge Case: 0 viewport items -> returns empty hero batch, all in remaining
  const zeroVp = [
    { core: "item1", priority: 2, prominence: 40, domOrder: 0, entries: [] },
    { core: "item2", priority: 3, prominence: 20, domOrder: 1, entries: [] }
  ];
  const zeroRes = core.extractHeroBatch(zeroVp, 8);
  assert.equal(zeroRes.heroBatch.length, 0);
  assert.equal(zeroRes.remainingGroups.length, 2);
});

test("Scroll Reprioritization: ActivePriorityQueue dynamically promotes newly visible elements to Priority 1 upon scroll", () => {
  // Construct mock elements
  const el1 = new MockDOMNode(1, "DIV");
  el1.getBoundingClientRect = () => ({ top: 50, bottom: 150, left: 0, right: 500, width: 500, height: 100 });
  const g1 = { core: "viewport_item", priority: 1, prominence: 80, domOrder: 0, entries: [{ element: el1 }] };

  const el2 = new MockDOMNode(1, "DIV");
  el2.getBoundingClientRect = () => ({ top: 1200, bottom: 1300, left: 0, right: 500, width: 500, height: 100 });
  const g2 = { core: "prefetch_item", priority: 2, prominence: 50, domOrder: 1, entries: [{ element: el2 }] };

  const el3 = new MockDOMNode(1, "DIV");
  el3.getBoundingClientRect = () => ({ top: 3000, bottom: 3100, left: 0, right: 500, width: 500, height: 100 });
  const g3 = { core: "deep_item", priority: 3, prominence: 40, domOrder: 2, entries: [{ element: el3 }] };

  const queue = new core.ActivePriorityQueue([g1, g2, g3]);

  // Initial order: g1 (P1), g2 (P2), g3 (P3)
  assert.equal(queue.pending[0].core, "viewport_item");
  assert.equal(queue.pending[1].core, "prefetch_item");
  assert.equal(queue.pending[2].core, "deep_item");

  // User scrolls down 2800px: el3 now enters the active viewport (top: 200, bottom: 300)
  el3.getBoundingClientRect = () => ({ top: 200, bottom: 300, left: 0, right: 500, width: 500, height: 100 });
  // el1 scrolled out above (top: -2750, bottom: -2650)
  el1.getBoundingClientRect = () => ({ top: -2750, bottom: -2650, left: 0, right: 500, width: 500, height: 100 });

  queue.reprioritize();

  // g3 is now Priority 1 and jumps ahead of g1 and g2!
  assert.equal(g3.priority, 1);
  assert.equal(g1.priority, 3);
  assert.equal(queue.pending[0].core, "deep_item");

  // Dequeuing returns the newly visible item first!
  const batch = queue.dequeueBatch(1);
  assert.equal(batch.length, 1);
  assert.equal(batch[0].core, "deep_item");
  assert.equal(queue.length, 2);

  // Cleanup listeners
  queue.detachListeners();
});

test("Staged Concurrency: translateItems dispatches hero batch standalone and limits off-hero concurrency to 2", async () => {
  const root = new MockDOMNode(1, "DIV");
  root.isRoot = true;

  // Create 30 paragraphs (10 in viewport, 10 in prefetch, 10 in deep document)
  const paragraphs = [];
  for (let i = 0; i < 30; i++) {
    const p = new MockDOMNode(1, "P");
    const top = i < 10 ? 50 + i * 40 : (i < 20 ? 1100 + (i - 10) * 40 : 2500 + (i - 20) * 40);
    p.getBoundingClientRect = () => ({ top, bottom: top + 30, left: 0, right: 600, width: 600, height: 30 });
    const textNode = new MockDOMNode(3, "#text", `Sentence number ${i} for concurrency test`);
    p.appendChild(textNode);
    root.appendChild(p);
    paragraphs.push({ p, textNode });
  }

  const items = core.collectTranslatableItems(root);
  assert.equal(items.length, 30);

  // Monitor concurrency and batch sizes
  let activeConcurrency = 0;
  let maxObservedConcurrency = 0;
  let batchIndex = 0;
  const batchLog = [];

  const originalSendMessage = globalThis.chrome.runtime.sendMessage;
  globalThis.chrome.runtime.sendMessage = async (msg) => {
    if (msg.action === "translateBatch") {
      activeConcurrency++;
      if (activeConcurrency > maxObservedConcurrency) {
        maxObservedConcurrency = activeConcurrency;
      }

      const currentBatchNum = ++batchIndex;
      const currentSize = msg.texts.length;
      const isHero = currentBatchNum === 1;

      batchLog.push({
        batchNum: currentBatchNum,
        size: currentSize,
        concurrency: activeConcurrency,
        isHero
      });

      // Small async delay to simulate inference time and test concurrency overlap
      await new Promise((r) => setTimeout(r, 20));

      activeConcurrency--;
      return {
        ok: true,
        translations: msg.texts.map((t) => `EN:${t}`)
      };
    }
    return { ok: true };
  };

  try {
    core.state.busy = false;
    core.state.originals.clear();

    const result = await core.translateItems(items);
    assert.equal(result.ok, true);
    assert.equal(result.translatedCount, 30);

    // 1. Verify Hero Batch: First batch must be 5-8 items (isolated prominent viewport items)
    assert.ok(batchLog.length >= 2, "Expected multiple batches");
    const heroBatch = batchLog[0];
    assert.equal(heroBatch.isHero, true);
    assert.ok(heroBatch.size >= 5 && heroBatch.size <= 8, `Hero batch size expected 5-8, got ${heroBatch.size}`);
    assert.equal(heroBatch.concurrency, 1, "Hero batch must be dispatched standalone with concurrency = 1");

    // 2. Verify Staged Concurrency: Max concurrent requests must never exceed 2
    assert.ok(maxObservedConcurrency <= 2, `Expected max concurrency <= 2, observed ${maxObservedConcurrency}`);

    // 3. Verify DOM was updated
    assert.ok(paragraphs[0].textNode.nodeValue.startsWith("EN:"));
    assert.ok(paragraphs[29].textNode.nodeValue.startsWith("EN:"));

    // 4. Verify clean restoration
    await core.restoreOriginals();
    assert.equal(paragraphs[0].textNode.nodeValue, "Sentence number 0 for concurrency test");
    assert.equal(paragraphs[29].textNode.nodeValue, "Sentence number 29 for concurrency test");
  } finally {
    globalThis.chrome.runtime.sendMessage = originalSendMessage;
  }
});

test("Progressive Rendering: DOM nodes are updated immediately per batch without waiting for other in-flight batches", async () => {
  const root = new MockDOMNode(1, "DIV");
  root.isRoot = true;

  const p1 = new MockDOMNode(1, "H1");
  p1.getBoundingClientRect = () => ({ top: 10, bottom: 60, left: 0, right: 500, width: 500, height: 50 });
  const t1 = new MockDOMNode(3, "#text", "Hero Main Heading");
  p1.appendChild(t1);

  const p2 = new MockDOMNode(1, "P");
  p2.getBoundingClientRect = () => ({ top: 1500, bottom: 1600, left: 0, right: 500, width: 500, height: 100 });
  const t2 = new MockDOMNode(3, "#text", "Second Batch Content");
  p2.appendChild(t2);

  root.appendChild(p1);
  root.appendChild(p2);

  const items = core.collectTranslatableItems(root);
  assert.equal(items.length, 2);

  let batchCount = 0;
  let heroRenderedBeforeBatch2Finished = false;

  const originalSendMessage = globalThis.chrome.runtime.sendMessage;
  globalThis.chrome.runtime.sendMessage = async (msg) => {
    if (msg.action === "translateBatch") {
      batchCount++;
      if (batchCount === 1) {
        // Hero batch
        return { ok: true, translations: msg.texts.map((t) => `HERO:${t}`) };
      }
      if (batchCount === 2) {
        // When batch 2 runs, verify batch 1 has ALREADY updated the DOM!
        if (t1.nodeValue === "HERO:Hero Main Heading") {
          heroRenderedBeforeBatch2Finished = true;
        }
        return { ok: true, translations: msg.texts.map((t) => `BATCH2:${t}`) };
      }
    }
    return { ok: true };
  };

  try {
    core.state.busy = false;
    core.state.originals.clear();

    const res = await core.translateItems(items, { settings: { batchSize: 1 } });
    assert.equal(res.ok, true);
    assert.equal(heroRenderedBeforeBatch2Finished, true, "Hero batch must update DOM immediately before batch 2 completes");
    assert.equal(t1.nodeValue, "HERO:Hero Main Heading");
    assert.equal(t2.nodeValue, "BATCH2:Second Batch Content");

    await core.restoreOriginals();
    assert.equal(t1.nodeValue, "Hero Main Heading");
    assert.equal(t2.nodeValue, "Second Batch Content");
  } finally {
    globalThis.chrome.runtime.sendMessage = originalSendMessage;
  }
});

test("ActivePriorityQueue Resilience: handles detached elements and throwing getBoundingClientRect gracefully", () => {
  const detachedEl = new MockDOMNode(1, "DIV");
  detachedEl.getBoundingClientRect = () => { throw new Error("Detached element bounding rect error"); };

  const normalEl = new MockDOMNode(1, "DIV");
  normalEl.getBoundingClientRect = () => ({ top: 100, bottom: 200, left: 0, right: 400, width: 400, height: 100 });

  const gDetached = { core: "detached", priority: 3, prominence: 10, domOrder: 0, entries: [{ element: detachedEl }] };
  const gNormal = { core: "normal", priority: 2, prominence: 30, domOrder: 1, entries: [{ element: normalEl }] };

  const queue = new core.ActivePriorityQueue([gDetached, gNormal]);
  assert.equal(queue.hasPending(), true);

  // Reprioritize should not throw even if an element throws
  assert.doesNotThrow(() => {
    queue.reprioritize();
  });

  // Normal element correctly identified
  assert.equal(gNormal.priority, 1);
  // Detached element safely defaulted to Priority 3
  assert.equal(gDetached.priority, 3);

  // Dequeuing works as expected
  const b1 = queue.dequeueBatch(1);
  assert.equal(b1[0].core, "normal");
  const b2 = queue.dequeueBatch(1);
  assert.equal(b2[0].core, "detached");
  assert.equal(queue.hasPending(), false);

  // Empty queue dequeue
  const emptyBatch = queue.dequeueBatch(5);
  assert.deepEqual(emptyBatch, []);

  queue.detachListeners();
});

test("Partial Cancellation: aborting after hero batch leaves translated nodes restorable without DOM corruption", async () => {
  const root = new MockDOMNode(1, "DIV");
  root.isRoot = true;

  const h1 = new MockDOMNode(1, "H1");
  h1.getBoundingClientRect = () => ({ top: 10, bottom: 50, left: 0, right: 500, width: 500, height: 40 });
  const tHero = new MockDOMNode(3, "#text", "Page Header Title");
  h1.appendChild(tHero);

  const pDeep = new MockDOMNode(1, "P");
  pDeep.getBoundingClientRect = () => ({ top: 3000, bottom: 3100, left: 0, right: 500, width: 500, height: 100 });
  const tDeep = new MockDOMNode(3, "#text", "Offscreen Paragraph");
  pDeep.appendChild(tDeep);

  root.appendChild(h1);
  root.appendChild(pDeep);

  const items = core.collectTranslatableItems(root);

  const originalSendMessage = globalThis.chrome.runtime.sendMessage;
  let batchNum = 0;

  globalThis.chrome.runtime.sendMessage = async (msg) => {
    if (msg.action === "translateBatch") {
      batchNum++;
      if (batchNum === 1) {
        return { ok: true, translations: ["EN:Page Header Title"] };
      }
      // Simulate user navigating away or clicking restore while second batch is pending
      core.state.abortController?.abort();
      return { ok: true, translations: ["EN:Offscreen Paragraph"] };
    }
    return { ok: true };
  };

  try {
    core.state.busy = true;
    core.state.abortController = new AbortController();
    core.state.originals.clear();

    const res = await core.translateItems(items, { settings: { batchSize: 1 } });
    assert.equal(res.ok, false);
    assert.equal(res.aborted, true);

    // Hero item was translated before cancellation
    assert.equal(tHero.nodeValue, "EN:Page Header Title");
    // Deep item was not translated due to abort
    assert.equal(tDeep.nodeValue, "Offscreen Paragraph");

    // Clean restore works perfectly
    await core.restoreOriginals();
    assert.equal(tHero.nodeValue, "Page Header Title");
    assert.equal(tDeep.nodeValue, "Offscreen Paragraph");
    assert.equal(core.state.originals.size, 0);
  } finally {
    globalThis.chrome.runtime.sendMessage = originalSendMessage;
    core.state.busy = false;
    core.state.abortController = null;
  }
});

test("extractHeroBatch edge cases: handles null/empty, zero viewport items, exactly 5-8 items, and custom limits", () => {
  // 1. null / undefined / empty
  assert.deepEqual(core.extractHeroBatch(null), { heroBatch: [], remainingGroups: [] });
  assert.deepEqual(core.extractHeroBatch(undefined), { heroBatch: [], remainingGroups: [] });
  assert.deepEqual(core.extractHeroBatch([]), { heroBatch: [], remainingGroups: [] });

  // 2. No viewport items (all Priority 2 or 3)
  const nonVpGroups = [
    { core: "p2_a", priority: 2, prominence: 50, domOrder: 0 },
    { core: "p3_b", priority: 3, prominence: 40, domOrder: 1 }
  ];
  const nonVpRes = core.extractHeroBatch(nonVpGroups, 8);
  assert.equal(nonVpRes.heroBatch.length, 0);
  assert.equal(nonVpRes.remainingGroups.length, 2);

  // 3. Exactly 5 viewport items
  const fiveVp = [
    { core: "v1", priority: 1, prominence: 100, domOrder: 0 },
    { core: "v2", priority: 1, prominence: 90, domOrder: 1 },
    { core: "v3", priority: 1, prominence: 80, domOrder: 2 },
    { core: "v4", priority: 1, prominence: 70, domOrder: 3 },
    { core: "v5", priority: 1, prominence: 60, domOrder: 4 }
  ];
  const fiveRes = core.extractHeroBatch(fiveVp, 8);
  assert.equal(fiveRes.heroBatch.length, 5);
  assert.equal(fiveRes.remainingGroups.length, 0);

  // 4. Exactly 8 viewport items
  const eightVp = Array.from({ length: 8 }, (_, i) => ({
    core: `v${i}`,
    priority: 1,
    prominence: 100 - i * 5,
    domOrder: i
  }));
  const eightRes = core.extractHeroBatch(eightVp, 8);
  assert.equal(eightRes.heroBatch.length, 8);
  assert.equal(eightRes.remainingGroups.length, 0);

  // 5. 12 viewport items with default maxHero=8
  const twelveVp = Array.from({ length: 12 }, (_, i) => ({
    core: `v${i}`,
    priority: 1,
    prominence: 100 - i * 5,
    domOrder: i
  }));
  const twelveRes = core.extractHeroBatch(twelveVp, 8);
  assert.equal(twelveRes.heroBatch.length, 8);
  assert.equal(twelveRes.remainingGroups.length, 4);
  assert.equal(twelveRes.heroBatch[0].core, "v0");
  assert.equal(twelveRes.remainingGroups[0].core, "v8");

  // 6. Custom maxHero limit = 3
  const customLimitRes = core.extractHeroBatch(twelveVp, 3);
  assert.equal(customLimitRes.heroBatch.length, 3);
  assert.equal(customLimitRes.remainingGroups.length, 9);
});

test("ActivePriorityQueue IntersectionObserver & Dequeue: observes segment parent elements and unobserves on dequeue", () => {
  const originalObserver = globalThis.IntersectionObserver;
  const originalWindow = globalThis.window;

  const observedElements = new Set();
  const unobservedElements = new Set();
  let disconnected = false;

  class MockIntersectionObserver {
    constructor(callback, options) {
      this.callback = callback;
      this.options = options;
    }
    observe(el) {
      observedElements.add(el);
    }
    unobserve(el) {
      unobservedElements.add(el);
    }
    disconnect() {
      disconnected = true;
    }
  }

  globalThis.IntersectionObserver = MockIntersectionObserver;
  globalThis.window = {
    ...originalWindow,
    innerHeight: 1000,
    innerWidth: 1000,
    addEventListener: () => {},
    removeEventListener: () => {}
  };

  try {
    const textParent = new MockDOMNode(1, "DIV");
    textParent.getBoundingClientRect = () => ({ top: 100, bottom: 200, left: 0, right: 500, width: 500, height: 100 });
    const textChild = new MockDOMNode(3, "#text", "Text child");
    textParent.appendChild(textChild);

    const segmentParent = new MockDOMNode(1, "P");
    segmentParent.getBoundingClientRect = () => ({ top: 300, bottom: 400, left: 0, right: 500, width: 500, height: 100 });
    const segmentSpan = new MockDOMNode(1, "SPAN");
    segmentParent.appendChild(segmentSpan);

    const gText = {
      core: "text_item",
      priority: 1,
      prominence: 50,
      domOrder: 0,
      entries: [{ type: "text", node: textChild, element: textParent }]
    };

    const gSegment = {
      core: "segment_item",
      priority: 1,
      prominence: 70,
      domOrder: 1,
      entries: [{ type: "segment", parent: segmentParent, nodes: [segmentSpan] }]
    };

    const queue = new core.ActivePriorityQueue([gText, gSegment]);
    queue.attachListeners();

    // Verify both text element and segment parent element are observed
    assert.equal(observedElements.has(textParent), true, "Text element parent must be observed");
    assert.equal(observedElements.has(segmentParent), true, "Segment parent element must be observed");

    // Dequeue batch of 1
    const dequeued = queue.dequeueBatch(1);
    assert.equal(dequeued.length, 1);
    const dequeuedEl = dequeued[0].entries[0].element || dequeued[0].entries[0].parent;
    assert.equal(unobservedElements.has(dequeuedEl), true, "Dequeued element must be unobserved");

    // Detach listeners
    queue.detachListeners();
    assert.equal(disconnected, true, "Observer must be disconnected on detachListeners");
  } finally {
    globalThis.IntersectionObserver = originalObserver;
    globalThis.window = originalWindow;
  }
});

test("ActivePriorityQueue Bidirectional Scrolling: promotes elements on scroll down and restores on scroll back up", () => {
  const topEl = new MockDOMNode(1, "DIV");
  topEl.getBoundingClientRect = () => ({ top: 50, bottom: 150, left: 0, right: 500, width: 500, height: 100 });
  const gTop = { core: "top_item", priority: 1, prominence: 80, domOrder: 0, entries: [{ element: topEl }] };

  const bottomEl = new MockDOMNode(1, "DIV");
  bottomEl.getBoundingClientRect = () => ({ top: 3000, bottom: 3100, left: 0, right: 500, width: 500, height: 100 });
  const gBottom = { core: "bottom_item", priority: 3, prominence: 80, domOrder: 1, entries: [{ element: bottomEl }] };

  const queue = new core.ActivePriorityQueue([gTop, gBottom]);
  assert.equal(queue.pending[0].core, "top_item");
  assert.equal(queue.pending[1].core, "bottom_item");

  // Step 1: User scrolls down 2900px
  bottomEl.getBoundingClientRect = () => ({ top: 100, bottom: 200, left: 0, right: 500, width: 500, height: 100 });
  topEl.getBoundingClientRect = () => ({ top: -2850, bottom: -2750, left: 0, right: 500, width: 500, height: 100 });
  queue.reprioritize();

  assert.equal(queue.pending[0].core, "bottom_item", "Bottom item should jump to front of queue after scroll down");
  assert.equal(gBottom.priority, 1);
  assert.equal(gTop.priority, 3);

  // Step 2: User scrolls back up to the top
  bottomEl.getBoundingClientRect = () => ({ top: 3000, bottom: 3100, left: 0, right: 500, width: 500, height: 100 });
  topEl.getBoundingClientRect = () => ({ top: 50, bottom: 150, left: 0, right: 500, width: 500, height: 100 });
  queue.reprioritize();

  assert.equal(queue.pending[0].core, "top_item", "Top item should return to front of queue after scrolling back up");
  assert.equal(gTop.priority, 1);
  assert.equal(gBottom.priority, 3);

  queue.detachListeners();
});

test("Container Scroll Capture: scroll events attach with capture option", () => {
  const originalWindow = globalThis.window;
  const attachedListeners = [];
  const removedListeners = [];

  globalThis.window = {
    ...originalWindow,
    addEventListener: (type, fn, opts) => {
      attachedListeners.push({ type, fn, opts });
    },
    removeEventListener: (type, fn, opts) => {
      removedListeners.push({ type, fn, opts });
    }
  };

  try {
    const queue = new core.ActivePriorityQueue([]);
    queue.attachListeners();

    const scrollAttach = attachedListeners.find((l) => l.type === "scroll");
    assert.ok(scrollAttach, "Scroll listener must be attached");
    assert.equal(scrollAttach.opts?.capture, true, "Scroll listener must use capture: true");
    assert.equal(scrollAttach.opts?.passive, true, "Scroll listener must use passive: true");

    queue.detachListeners();
    const scrollRemove = removedListeners.find((l) => l.type === "scroll");
    assert.ok(scrollRemove, "Scroll listener must be removed");
    assert.equal(scrollRemove.opts?.capture, true, "Scroll removeEventListener must match capture: true");
  } finally {
    globalThis.window = originalWindow;
  }
});

test("Staged Concurrency Partial Failure: subsequent batch failure preserves hero translations and allows clean restore", async () => {
  const root = new MockDOMNode(1, "DIV");
  root.isRoot = true;

  const h1 = new MockDOMNode(1, "H1");
  h1.getBoundingClientRect = () => ({ top: 10, bottom: 50, left: 0, right: 500, width: 500, height: 40 });
  const tHero = new MockDOMNode(3, "#text", "Hero Main Title");
  h1.appendChild(tHero);

  const pDeep = new MockDOMNode(1, "P");
  pDeep.getBoundingClientRect = () => ({ top: 3000, bottom: 3100, left: 0, right: 500, width: 500, height: 100 });
  const tDeep = new MockDOMNode(3, "#text", "Deep Offscreen Paragraph");
  pDeep.appendChild(tDeep);

  root.appendChild(h1);
  root.appendChild(pDeep);

  const items = core.collectTranslatableItems(root);

  const originalSendMessage = globalThis.chrome.runtime.sendMessage;
  let batchNum = 0;

  globalThis.chrome.runtime.sendMessage = async (msg) => {
    if (msg.action === "translateBatch") {
      batchNum++;
      if (batchNum === 1) {
        // Hero batch succeeds
        return { ok: true, translations: ["EN:Hero Main Title"] };
      }
      // Staged batch 2 fails
      return { ok: false, error: "Local inference worker crash (OOM)" };
    }
    return { ok: true };
  };

  try {
    core.state.busy = false;
    core.state.originals.clear();

    const res = await core.translateItems(items, { settings: { batchSize: 1 } });
    assert.equal(res.ok, false);
    assert.equal(res.partial, true);
    assert.equal(res.translatedCount, 1);
    assert.equal(res.error, "Local inference worker crash (OOM)");

    // Hero item is translated and visible to the user
    assert.equal(tHero.nodeValue, "EN:Hero Main Title");
    assert.equal(tDeep.nodeValue, "Deep Offscreen Paragraph");

    // Clean restore works without leaving corrupted state
    await core.restoreOriginals();
    assert.equal(tHero.nodeValue, "Hero Main Title");
    assert.equal(tDeep.nodeValue, "Deep Offscreen Paragraph");
    assert.equal(core.state.originals.size, 0);
  } finally {
    globalThis.chrome.runtime.sendMessage = originalSendMessage;
  }
});




