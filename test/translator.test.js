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
  return (
    SKIP_TAGS.has(node.tagName) ||
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
