/**
 * Browser-tab helpers: normalization, URL extraction from real backend text,
 * pins/history. openExternal itself needs a DOM, so it is not tested here.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { normalizeUrl, extractUrls } from "@/lib/browser";

test("normalizeUrl adds scheme for bare hosts", () => {
  assert.equal(normalizeUrl("localhost:3000"), "http://localhost:3000/");
  assert.equal(normalizeUrl("127.0.0.1:9090/x"), "http://127.0.0.1:9090/x");
  assert.equal(normalizeUrl("example.com"), "https://example.com/");
  assert.equal(normalizeUrl("https://a.b/c?d=1"), "https://a.b/c?d=1");
});

test("normalizeUrl rejects junk", () => {
  assert.equal(normalizeUrl(""), null);
  assert.equal(normalizeUrl("not a url at all"), null);
  assert.equal(normalizeUrl("javascript:alert(1)"), null);
});

test("normalizeUrl strips trailing punctuation from log text", () => {
  assert.equal(normalizeUrl("http://localhost:3000)."), "http://localhost:3000/");
});

test("extractUrls finds and dedupes URLs in agent log text", () => {
  const text = "dev server http://localhost:3000 çalışıyor,また http://localhost:3000 ve https://x.io/a";
  const urls = extractUrls(text);
  assert.deepEqual(urls, ["http://localhost:3000/", "https://x.io/a"]);
});

test("extractUrls ignores non-http schemes", () => {
  assert.deepEqual(extractUrls("dosya file:///tmp/x ve ws://127.0.0.1:9"), []);
});
