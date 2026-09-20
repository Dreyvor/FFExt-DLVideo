"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const VideoDL = require("../src/shared.js");

test("recognises common media URLs", () => {
  assert.equal(VideoDL.isMediaUrl("https://cdn.example/video.mp4?token=1"), true);
  assert.equal(VideoDL.isMediaUrl("https://cdn.example/manifest.m3u8"), true);
  assert.equal(VideoDL.isMediaUrl("https://cdn.example/audio.mp3"), false);
  assert.equal(VideoDL.isMediaUrl("https://example.com/page.html"), false);
});

test("recognises WebVTT URLs separately", () => {
  assert.equal(VideoDL.isVttUrl("https://cdn.example/subtitles.vtt?lang=en"), true);
  assert.equal(VideoDL.isVttUrl("https://cdn.example/video.mp4"), false);
  assert.equal(VideoDL.isMediaUrl("https://cdn.example/subtitles.vtt"), false);
});

test("recognises DRM licence and key-system request URLs", () => {
  assert.equal(VideoDL.isDrmSignalUrl("https://license.example/widevine?token=1"), true);
  assert.equal(VideoDL.isDrmSignalUrl("https://cdn.example/playready/license"), true);
  assert.equal(VideoDL.isDrmSignalUrl("https://cdn.example/video.mp4"), false);
});

test("creates safe download names", () => {
  assert.equal(VideoDL.safeFilename("Lecture: week/one?"), "Lecture_ week_one_");
  assert.equal(VideoDL.safeFilename("   "), "video");
});

test("formats available metadata and omits unknown values", () => {
  assert.equal(VideoDL.formatBytes(1536), "1.5 KB");
  assert.equal(VideoDL.formatDuration(3723), "1:02:03");
  assert.deepEqual(VideoDL.metadataLabels({
    kind: "video",
    width: 1920,
    height: 1080,
    durationSeconds: 65,
    byteLength: 1048576,
    type: "video/mp4; charset=binary"
  }), ["1920×1080", "1:05", "1 MB", "video/mp4"]);
  assert.deepEqual(VideoDL.metadataLabels({ kind: "vtt", language: "de" }), ["de"]);
});

test("extracts suggested filenames from content-disposition", () => {
  assert.equal(
    VideoDL.filenameFromContentDisposition("attachment; filename*=UTF-8''Lecture%20One.mp4"),
    "Lecture One.mp4"
  );
  assert.equal(VideoDL.filenameFromContentDisposition('attachment; filename="captions.vtt"'), "captions.vtt");
});

test("builds a consistently named video and caption set", () => {
  const video = { url: "https://cdn.example/source", title: "Lecture: One", kind: "video", type: "video/webm" };
  const captions = [
    { url: "https://cdn.example/en.vtt", kind: "vtt", language: "en" },
    { url: "https://cdn.example/en-2.vtt", kind: "vtt", language: "en" },
    { url: "https://cdn.example/unknown.vtt", kind: "vtt" }
  ];
  assert.deepEqual(VideoDL.buildDownloadPlan(video, captions), [
    {
      url: video.url,
      kind: "video",
      filename: "VideoDL/Lecture_ One/Lecture_ One.webm"
    },
    {
      url: captions[0].url,
      kind: "vtt",
      filename: "VideoDL/Lecture_ One/Lecture_ One.en.vtt"
    },
    {
      url: captions[1].url,
      kind: "vtt",
      filename: "VideoDL/Lecture_ One/Lecture_ One.en-2.vtt"
    },
    {
      url: captions[2].url,
      kind: "vtt",
      filename: "VideoDL/Lecture_ One/Lecture_ One.3.vtt"
    }
  ]);
});

test("validates one video and de-duplicates caption selections", () => {
  const video = { url: "https://cdn.example/video.mp4", kind: "video" };
  const caption = { url: "https://cdn.example/en.vtt", kind: "vtt" };
  const candidates = new Map([[video.url, video], [caption.url, caption]]);
  const valid = VideoDL.validateDownloadSet(candidates, video.url, [caption.url, caption.url]);
  assert.equal(valid.video, video);
  assert.deepEqual(valid.captions, [caption]);
  assert.deepEqual(valid.errors, []);
  assert.match(VideoDL.validateDownloadSet(candidates, caption.url, []).error, /video/i);
});

test("selection model auto-selects one video and preserves caption choices", () => {
  const media = [
    { url: "video", kind: "video" },
    { url: "en", kind: "vtt" },
    { url: "de", kind: "vtt", downloaded: true }
  ];
  const selected = VideoDL.reconcileSelection(media, { videoUrl: null, vttUrls: new Set(["en", "de"]) }, true);
  assert.equal(selected.videoUrl, "video");
  assert.deepEqual([...selected.vttUrls], ["en"]);

  const multipleVideos = [...media, { url: "video-2", kind: "video" }];
  assert.equal(VideoDL.reconcileSelection(multipleVideos, { vttUrls: [] }, true).videoUrl, null);
  assert.equal(VideoDL.reconcileSelection([], selected, false).videoUrl, null);
});
