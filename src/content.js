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
    try {
      return new URL(value, document.baseURI).href;
    } catch (_error) {
      return "";
    }
  }

  function collectMedia() {
    const results = new Map();
    const add = (url, title, type, kind) => {
      const absolute = absoluteUrl(url);
      if (absolute && /^(?:https?|blob):/.test(absolute)) {
        results.set(absolute, { url: absolute, title, type: type || "", kind });
      }
    };

    for (const element of document.querySelectorAll("video")) {
      if (element.mediaKeys) {
        reportDrm();
        continue;
      }
      const title = element.getAttribute("title") || document.title || "Video";
      add(element.currentSrc || element.src, title, element.getAttribute("type"), "video");
      for (const source of element.querySelectorAll("source[src]")) {
        add(source.src, title, source.type, "video");
      }
      for (const track of element.querySelectorAll("track[src][kind='subtitles'], track[src][kind='captions']")) {
        add(track.src, track.label || `${title} subtitles`, "text/vtt", "vtt");
      }
    }

    for (const link of document.querySelectorAll("a[href]")) {
      const title = link.textContent.trim() || document.title || "Media";
      if (/\.vtt(?:$|[?#])/i.test(link.href)) {
        add(link.href, title, "text/vtt", "vtt");
      } else if (link.hasAttribute("download") || /\.(?:mp4|m4v|webm|mov|mkv|m3u8|mpd|ogv)(?:$|[?#])/i.test(link.href)) {
        add(link.href, title, "", "video");
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
  scan();
})();
