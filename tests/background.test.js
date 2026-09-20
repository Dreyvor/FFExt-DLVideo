"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

global.VideoDL = require("../src/shared.js");

const listeners = {};
const downloadCalls = [];
const runtimeMessages = [];
const failedUrls = new Set();
let nextDownloadId = 1;

global.browser = {
  runtime: {
    onMessage: { addListener(listener) { listeners.message = listener; } },
    sendMessage(message) {
      runtimeMessages.push(message);
      return Promise.resolve();
    }
  },
  tabs: {
    sendMessage() { return Promise.resolve(null); },
    onRemoved: { addListener(listener) { listeners.tabRemoved = listener; } },
    onUpdated: { addListener(listener) { listeners.tabUpdated = listener; } }
  },
  downloads: {
    download(options) {
      downloadCalls.push(options);
      if (failedUrls.has(options.url)) {
        return Promise.reject(new Error("Mock download failure"));
      }
      return Promise.resolve(nextDownloadId++);
    },
    search() { return Promise.resolve([{ state: "in_progress" }]); },
    onChanged: { addListener(listener) { listeners.downloadChanged = listener; } }
  },
  webRequest: {
    onHeadersReceived: { addListener(listener) { listeners.headersReceived = listener; } }
  }
};

require("../src/background.js");

function send(message, tabId) {
  return listeners.message(message, tabId === undefined ? {} : { tab: { id: tabId } });
}

function addCandidates(tabId, media) {
  return send({ type: "mediaFound", media, drmProtected: false }, tabId);
}

test("starts a validated set without prompts and tracks completion", async () => {
  const tabId = 101;
  const video = { url: "https://cdn.example/lecture.mp4", kind: "video", title: "Lecture" };
  const caption = { url: "https://cdn.example/en.vtt", kind: "vtt", language: "en" };
  await addCandidates(tabId, [video, caption]);

  const result = await send({
    type: "downloadSet",
    tabId,
    videoUrl: video.url,
    vttUrls: [caption.url, caption.url]
  });
  assert.equal(result.results.length, 2);
  const calls = downloadCalls.slice(-2);
  assert.deepEqual(calls.map((call) => ({
    saveAs: call.saveAs,
    conflictAction: call.conflictAction,
    filename: call.filename
  })), [
    {
      saveAs: false,
      conflictAction: "uniquify",
      filename: "VideoDL/Lecture/Lecture.mp4"
    },
    {
      saveAs: false,
      conflictAction: "uniquify",
      filename: "VideoDL/Lecture/Lecture.en.vtt"
    }
  ]);

  listeners.downloadChanged({ id: result.results[0].downloadId, state: { current: "complete" } });
  const state = await send({ type: "getState", tabId });
  assert.equal(state.media.find((item) => item.url === video.url).downloaded, true);
  assert.equal(state.media.find((item) => item.url === caption.url).downloading, true);
});

test("returns partial failures and retries the failed file", async () => {
  const tabId = 102;
  const video = { url: "https://cdn.example/partial.mp4", kind: "video", title: "Partial" };
  const caption = { url: "https://cdn.example/fail.vtt", kind: "vtt", language: "en" };
  await addCandidates(tabId, [video, caption]);
  failedUrls.add(caption.url);

  const result = await send({ type: "downloadSet", tabId, videoUrl: video.url, vttUrls: [caption.url] });
  assert.equal(result.results.find((item) => item.url === caption.url).error, "Mock download failure");
  let state = await send({ type: "getState", tabId });
  assert.equal(state.media.find((item) => item.url === caption.url).error, "Mock download failure");

  failedUrls.delete(caption.url);
  const retry = await send({ type: "retryDownload", tabId, url: caption.url });
  assert.equal(Number.isInteger(retry.downloadId), true);
  state = await send({ type: "getState", tabId });
  assert.equal(state.media.find((item) => item.url === caption.url).downloading, true);
});

test("captures response metadata and clears tab state on navigation", async () => {
  const tabId = 103;
  listeners.headersReceived({
    tabId,
    url: "https://cdn.example/captions.vtt",
    responseHeaders: [
      { name: "Content-Type", value: "text/vtt; charset=utf-8" },
      { name: "Content-Length", value: "2048" },
      { name: "Content-Disposition", value: 'attachment; filename="english.vtt"' }
    ]
  });
  let state = await send({ type: "getState", tabId });
  assert.equal(state.media[0].byteLength, 2048);
  assert.equal(state.media[0].suggestedName, "english.vtt");

  listeners.tabUpdated(tabId, { status: "loading" });
  state = await send({ type: "getState", tabId });
  assert.deepEqual(state.media, []);
});

test("rejects sets after DRM is detected", async () => {
  const tabId = 104;
  const video = { url: "https://cdn.example/protected.mp4", kind: "video" };
  await addCandidates(tabId, [video]);
  await send({ type: "drmDetected" }, tabId);
  const result = await send({ type: "downloadSet", tabId, videoUrl: video.url, vttUrls: [] });
  assert.match(result.error, /DRM/i);
  assert.deepEqual(result.results, []);
});

test("reports interrupted downloads and makes them retryable", async () => {
  const tabId = 105;
  const video = { url: "https://cdn.example/interrupted.mp4", kind: "video", title: "Interrupted" };
  await addCandidates(tabId, [video]);
  const result = await send({ type: "downloadSet", tabId, videoUrl: video.url, vttUrls: [] });
  const downloadId = result.results[0].downloadId;
  listeners.downloadChanged({
    id: downloadId,
    state: { current: "interrupted" },
    error: { current: "NETWORK_FAILED" }
  });
  const state = await send({ type: "getState", tabId });
  assert.equal(state.media[0].error, "NETWORK_FAILED");
  assert.equal(runtimeMessages.some((message) => message.type === "downloadFailed" && message.url === video.url), true);
});
