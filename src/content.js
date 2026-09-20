(function initialiseContentScanner() {
  "use strict";

  let lastPayload = "";
  let scanTimer;
  let drmProtected = false;

  function reportDrm() {
    if (!drmProtected) {
      drmProtected = true;
      browser.runtime.sendMessage({ type: "drmDetected" }).catch(() => {});
    }
  }

  function absoluteUrl(value) {
    if (typeof value !== "string" || !value.trim()) {
      return "";
    }
    try {
      return new URL(value, document.baseURI).href;
    } catch (_error) {
      return "";
    }
  }

  function collectMedia() {
    const results = new Map();
    const add = (candidate) => {
      const absolute = absoluteUrl(candidate.url);
      if (absolute && /^(?:https?|blob):/.test(absolute)) {
        const previous = results.get(absolute) || {};
        results.set(absolute, {
          ...previous,
          ...candidate,
          url: absolute,
          type: candidate.type || previous.type || ""
        });
      }
    };

    for (const element of document.querySelectorAll("video")) {
      if (element.mediaKeys) {
        reportDrm();
        continue;
      }
      const title = element.getAttribute("title") || document.title || "Video";
      const videoMetadata = {
        title,
        kind: "video",
        width: element.videoWidth || undefined,
        height: element.videoHeight || undefined,
        durationSeconds: Number.isFinite(element.duration) ? element.duration : undefined
      };
      add({
        ...videoMetadata,
        url: element.currentSrc || element.src,
        type: element.getAttribute("type") || ""
      });
      for (const source of element.querySelectorAll("source[src]")) {
        add({ ...videoMetadata, url: source.src, type: source.type });
      }
      for (const track of element.querySelectorAll("track[src][kind='subtitles'], track[src][kind='captions']")) {
        add({
          url: track.src,
          title: track.label || `${title} subtitles`,
          type: "text/vtt",
          kind: "vtt",
          language: track.srclang || "",
          label: track.label || ""
        });
      }
    }

    for (const link of document.querySelectorAll("a[href]")) {
      const title = link.textContent.trim() || document.title || "Media";
      const suggestedName = link.getAttribute("download") || "";
      if (/\.vtt(?:$|[?#])/i.test(link.href)) {
        add({
          url: link.href,
          title,
          type: "text/vtt",
          kind: "vtt",
          language: link.hreflang || "",
          label: link.textContent.trim(),
          suggestedName
        });
      } else if (link.hasAttribute("download") || /\.(?:mp4|m4v|webm|mov|mkv|m3u8|mpd|ogv)(?:$|[?#])/i.test(link.href)) {
        add({ url: link.href, title, type: "", kind: "video", suggestedName });
      }
    }

    return [...results.values()];
  }

  function scan() {
    const media = collectMedia();
    const payload = JSON.stringify(media);
    if (payload === lastPayload) {
      return;
    }
    lastPayload = payload;
    browser.runtime.sendMessage({ type: "mediaFound", media, drmProtected }).catch(() => {});
  }

  function scheduleScan() {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(scan, 250);
  }

  browser.runtime.onMessage.addListener((message) => {
    if (message && message.type === "scan") {
      const media = collectMedia();
      lastPayload = JSON.stringify(media);
      return Promise.resolve({ media, drmProtected });
    }
    return undefined;
  });

  new MutationObserver(scheduleScan).observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["src", "href"]
  });
  document.addEventListener("encrypted", reportDrm, true);
  document.addEventListener("webkitneedkey", reportDrm, true);
  document.addEventListener("loadedmetadata", scheduleScan, true);
  document.addEventListener("durationchange", scheduleScan, true);
  scan();
})();
