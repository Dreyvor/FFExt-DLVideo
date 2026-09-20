(function initialiseVideoDL(global) {
  "use strict";

  const MEDIA_EXTENSION_PATTERN = /\.(?:mp4|m4v|webm|mov|mkv|avi|m3u8|mpd|ogv)(?:$|[?#])/i;
  const VTT_EXTENSION_PATTERN = /\.vtt(?:$|[?#])/i;
  const DRM_SIGNAL_PATTERN = /(?:^|[./_?&=-])(?:widevine|playready|fairplay|drm|license|licence|mediakeys?|encrypted-media)(?:$|[./_?&=-])/i;
  const CONTENT_TYPE_EXTENSIONS = Object.freeze({
    "application/dash+xml": ".mpd",
    "application/vnd.apple.mpegurl": ".m3u8",
    "application/x-mpegurl": ".m3u8",
    "text/vtt": ".vtt",
    "video/mp4": ".mp4",
    "video/ogg": ".ogv",
    "video/quicktime": ".mov",
    "video/webm": ".webm",
    "video/x-matroska": ".mkv"
  });

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

  function formatBytes(value) {
    if (!Number.isFinite(value) || value < 0) {
      return "";
    }
    if (value < 1024) {
      return `${Math.round(value)} B`;
    }
    const units = ["KB", "MB", "GB", "TB"];
    let amount = value;
    let unitIndex = -1;
    do {
      amount /= 1024;
      unitIndex += 1;
    } while (amount >= 1024 && unitIndex < units.length - 1);
    const decimals = amount >= 10 ? 1 : 2;
    return `${amount.toFixed(decimals).replace(/\.0+$|(?<=\.[0-9])0$/, "")} ${units[unitIndex]}`;
  }

  function formatDuration(value) {
    if (!Number.isFinite(value) || value < 0) {
      return "";
    }
    const totalSeconds = Math.round(value);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    return hours > 0
      ? `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
      : `${minutes}:${String(seconds).padStart(2, "0")}`;
  }

  function metadataLabels(candidate) {
    const labels = [];
    if (Number.isFinite(candidate.width) && candidate.width > 0 && Number.isFinite(candidate.height) && candidate.height > 0) {
      labels.push(`${Math.round(candidate.width)}×${Math.round(candidate.height)}`);
    }
    const duration = formatDuration(candidate.durationSeconds);
    if (duration) {
      labels.push(duration);
    }
    const size = formatBytes(candidate.byteLength);
    if (size) {
      labels.push(size);
    }
    const type = String(candidate.type || "").split(";", 1)[0].trim();
    if (type) {
      labels.push(type);
    }
    if (candidate.kind === "vtt" && candidate.language) {
      labels.push(String(candidate.language));
    }
    return labels;
  }

  function decodeDispositionValue(value) {
    try {
      return decodeURIComponent(value);
    } catch (_error) {
      return value;
    }
  }

  function filenameFromContentDisposition(value) {
    if (typeof value !== "string") {
      return "";
    }
    const encoded = value.match(/filename\*\s*=\s*UTF-8''([^;]+)/i);
    if (encoded) {
      return safeFilename(decodeDispositionValue(encoded[1].trim().replace(/^"|"$/g, "")), "");
    }
    const regular = value.match(/filename\s*=\s*(?:"([^"]+)"|([^;]+))/i);
    return regular ? safeFilename((regular[1] || regular[2]).trim(), "") : "";
  }

  function extensionFromCandidate(candidate) {
    const names = [candidate.suggestedName];
    try {
      names.push(decodeURIComponent(new URL(candidate.url).pathname.split("/").pop() || ""));
    } catch (_error) {
      // A validated candidate normally has a URL, but filename generation is defensive.
    }
    for (const name of names) {
      const match = String(name || "").match(/(\.[a-z0-9]{2,5})$/i);
      if (match) {
        return match[1].toLowerCase();
      }
    }
    const contentType = String(candidate.type || "").split(";", 1)[0].toLowerCase();
    return CONTENT_TYPE_EXTENSIONS[contentType] || (candidate.kind === "vtt" ? ".vtt" : ".mp4");
  }

  function downloadBaseName(candidate) {
    const suggestedName = String(candidate.suggestedName || "").replace(/\.[a-z0-9]{2,5}$/i, "");
    const title = String(candidate.title || "").replace(/\.[a-z0-9]{2,5}$/i, "");
    return safeFilename(title || suggestedName, "video").slice(0, 80);
  }

  function captionToken(candidate, index) {
    const language = safeFilename(candidate.language || "", "")
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "");
    return language || String(index + 1);
  }

  function buildDownloadPlan(video, captions) {
    const baseName = downloadBaseName(video);
    const folder = `VideoDL/${baseName}`;
    const usedCaptionTokens = new Map();
    const files = [{
      url: video.url,
      kind: "video",
      filename: `${folder}/${baseName}${extensionFromCandidate(video)}`
    }];

    captions.forEach((caption, index) => {
      const baseToken = captionToken(caption, index);
      const occurrence = (usedCaptionTokens.get(baseToken) || 0) + 1;
      usedCaptionTokens.set(baseToken, occurrence);
      const token = occurrence === 1 ? baseToken : `${baseToken}-${occurrence}`;
      files.push({
        url: caption.url,
        kind: "vtt",
        filename: `${folder}/${baseName}.${token}.vtt`
      });
    });
    return files;
  }

  function validateDownloadSet(candidates, videoUrl, vttUrls) {
    if (!(candidates instanceof Map)) {
      return { error: "No detected media is available." };
    }
    const video = candidates.get(videoUrl);
    if (!video || video.kind !== "video") {
      return { error: "Select a detected video." };
    }
    if (video.downloaded || video.downloading) {
      return { error: "Select a video that is not already downloaded or downloading." };
    }
    if (!Array.isArray(vttUrls)) {
      return { error: "Caption selection is invalid." };
    }

    const captions = [];
    const errors = [];
    for (const url of [...new Set(vttUrls)]) {
      const caption = candidates.get(url);
      if (!caption || caption.kind !== "vtt") {
        errors.push({ url, error: "The caption file is no longer available." });
      } else if (caption.downloaded || caption.downloading) {
        errors.push({ url, error: "The caption file is already downloaded or downloading." });
      } else {
        captions.push(caption);
      }
    }
    return { video, captions, errors };
  }

  function reconcileSelection(media, previous, autoSelectVideo = false) {
    const candidates = Array.isArray(media) ? media : [];
    const selectableVideos = candidates.filter((item) => item.kind === "video" && !item.downloaded && !item.downloading);
    const selectableVtt = new Set(
      candidates.filter((item) => item.kind === "vtt" && !item.downloaded && !item.downloading).map((item) => item.url)
    );
    let videoUrl = previous && selectableVideos.some((item) => item.url === previous.videoUrl)
      ? previous.videoUrl
      : null;
    if (!videoUrl && autoSelectVideo && selectableVideos.length === 1) {
      videoUrl = selectableVideos[0].url;
    }
    const vttUrls = new Set(
      [...(previous && previous.vttUrls ? previous.vttUrls : [])].filter((url) => selectableVtt.has(url))
    );
    return { videoUrl, vttUrls };
  }

  const api = Object.freeze({
    buildDownloadPlan,
    downloadBaseName,
    extensionFromCandidate,
    filenameFromContentDisposition,
    formatBytes,
    formatDuration,
    isDrmSignalUrl,
    isMediaUrl,
    isVttUrl,
    metadataLabels,
    reconcileSelection,
    safeFilename,
    validateDownloadSet
  });

  global.VideoDL = api;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})(globalThis);
