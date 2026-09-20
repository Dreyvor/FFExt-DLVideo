(function initialiseVideoDL(global) {
  "use strict";

  const MEDIA_EXTENSION_PATTERN = /\.(?:mp4|m4v|webm|mov|mkv|avi|m3u8|mpd|ogv)(?:$|[?#])/i;
  const VTT_EXTENSION_PATTERN = /\.vtt(?:$|[?#])/i;
  const DRM_SIGNAL_PATTERN = /(?:^|[./_?&=-])(?:widevine|playready|fairplay|drm|license|licence|mediakeys?|encrypted-media)(?:$|[./_?&=-])/i;

  function isMediaUrl(url) {
    return typeof url === "string" && MEDIA_EXTENSION_PATTERN.test(url);
  }

  function isDrmSignalUrl(url) {
    return typeof url === "string" && DRM_SIGNAL_PATTERN.test(url);
  }

  function isVttUrl(url) {
    return typeof url === "string" && VTT_EXTENSION_PATTERN.test(url);
  }

  function safeFilename(value, fallback = "video") {
    const cleaned = String(value || "")
      .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/[. ]+$/, "")
      .slice(0, 160);
    return cleaned || fallback;
  }

  const api = Object.freeze({
    isDrmSignalUrl,
    isMediaUrl,
    isVttUrl,
    safeFilename
  });

  global.VideoDL = api;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})(globalThis);
