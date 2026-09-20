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
