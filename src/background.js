(function initialiseBackground() {
  "use strict";

  const mediaByTab = new Map();
  const drmProtectedTabs = new Set();
  const downloadsById = new Map();
  const downloadedByTab = new Map();

  function markDrmProtected(tabId) {
    if (tabId >= 0) {
      drmProtectedTabs.add(tabId);
      mediaByTab.delete(tabId);
    }
  }

  function candidateKey(candidate) {
    return candidate.url;
  }

  function downloadedUrls(tabId) {
    if (!downloadedByTab.has(tabId)) {
      downloadedByTab.set(tabId, new Set());
    }
    return downloadedByTab.get(tabId);
  }

  function markDownloaded(tabId, url) {
    downloadedUrls(tabId).add(url);
    browser.runtime.sendMessage({ type: "downloadCompleted", tabId, url }).catch(() => {});
  }

  function mergeCandidates(tabId, candidates) {
    const existing = mediaByTab.get(tabId) || new Map();
    for (const candidate of candidates) {
      if (!candidate || typeof candidate.url !== "string") {
        continue;
      }

      let parsed;
      try {
        parsed = new URL(candidate.url);
      } catch (_error) {
        continue;
      }
      if (!/^(?:https?|blob):$/.test(parsed.protocol)) {
        continue;
      }

      const normalised = {
        url: parsed.href,
        title: String(candidate.title || "Video").trim().slice(0, 200),
        type: String(candidate.type || "").trim().slice(0, 100),
        kind: candidate.kind === "vtt" ? "vtt" : "video"
      };
      const key = candidateKey(normalised);
      existing.set(key, { ...existing.get(key), ...normalised });
    }
    mediaByTab.set(tabId, existing);
  }

  async function getTabState(tabId) {
    try {
      const response = await browser.tabs.sendMessage(tabId, { type: "scan" });
      if (response && response.drmProtected) {
        markDrmProtected(tabId);
      } else if (response && Array.isArray(response.media)) {
        mergeCandidates(tabId, response.media);
      }
    } catch (_error) {
      // Restricted Firefox pages cannot host content scripts.
    }

    const drmProtected = drmProtectedTabs.has(tabId);
    const completed = downloadedByTab.get(tabId) || new Set();
    const media = drmProtected ? [] : [...(mediaByTab.get(tabId) || new Map()).values()]
      .map((candidate) => ({ ...candidate, downloaded: completed.has(candidate.url) }));
    return { drmProtected, media };
  }

  async function downloadCandidate(tabId, url, title) {
    if (drmProtectedTabs.has(tabId)) {
      throw new Error("DRM-protected media cannot be downloaded.");
    }

    const known = mediaByTab.get(tabId);
    if (!known || !known.has(url)) {
      throw new Error("The media URL is no longer available.");
    }

    const parsed = new URL(url);
    const pathName = decodeURIComponent(parsed.pathname.split("/").pop() || "");
    const extensionMatch = pathName.match(/\.[a-z0-9]{2,5}$/i);
    const filename = `${VideoDL.safeFilename(title || pathName)}${extensionMatch && !String(title).endsWith(extensionMatch[0]) ? extensionMatch[0] : ""}`;
    const downloadId = await browser.downloads.download({ url, filename, saveAs: true });
    downloadsById.set(downloadId, { tabId, url });

    // Small VTT files may complete before the onChanged listener sees them.
    const [download] = await browser.downloads.search({ id: downloadId });
    if (download && download.state === "complete") {
      markDownloaded(tabId, url);
      downloadsById.delete(downloadId);
    }
    return downloadId;
  }

  browser.runtime.onMessage.addListener((message, sender) => {
    if (!message || typeof message.type !== "string") {
      return undefined;
    }

    if (message.type === "drmDetected" && sender.tab) {
      markDrmProtected(sender.tab.id);
      return Promise.resolve({ accepted: true });
    }

    if (message.type === "mediaFound" && sender.tab) {
      if (message.drmProtected) {
        markDrmProtected(sender.tab.id);
      } else if (!drmProtectedTabs.has(sender.tab.id)) {
        mergeCandidates(sender.tab.id, Array.isArray(message.media) ? message.media : []);
      }
      return Promise.resolve({ accepted: true });
    }

    if (message.type === "getState" && Number.isInteger(message.tabId)) {
      return getTabState(message.tabId);
    }

    if (message.type === "download" && Number.isInteger(message.tabId)) {
      return downloadCandidate(message.tabId, message.url, message.title)
        .then((downloadId) => ({ downloadId }))
        .catch((error) => ({ error: error.message }));
    }

    return undefined;
  });

  browser.tabs.onRemoved.addListener((tabId) => {
    mediaByTab.delete(tabId);
    drmProtectedTabs.delete(tabId);
    downloadedByTab.delete(tabId);
  });
  browser.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (changeInfo.url || changeInfo.status === "loading") {
      mediaByTab.delete(tabId);
      drmProtectedTabs.delete(tabId);
      downloadedByTab.delete(tabId);
    }
  });

  browser.downloads.onChanged.addListener((delta) => {
    const tracked = downloadsById.get(delta.id);
    if (!tracked || !delta.state) {
      return;
    }
    if (delta.state.current === "complete") {
      markDownloaded(tracked.tabId, tracked.url);
      downloadsById.delete(delta.id);
    } else if (delta.state.current === "interrupted") {
      browser.runtime.sendMessage({
        type: "downloadFailed",
        tabId: tracked.tabId,
        url: tracked.url
      }).catch(() => {});
      downloadsById.delete(delta.id);
    }
  });

  browser.webRequest.onHeadersReceived.addListener(
    (details) => {
      if (details.tabId < 0) {
        return;
      }
      if (VideoDL.isDrmSignalUrl(details.url)) {
        markDrmProtected(details.tabId);
        return;
      }
      const contentTypeHeader = (details.responseHeaders || []).find(
        (header) => header.name.toLowerCase() === "content-type"
      );
      const contentType = contentTypeHeader ? contentTypeHeader.value || "" : "";
      const isVtt = /^text\/vtt(?:;|$)/i.test(contentType) || VideoDL.isVttUrl(details.url);
      const isVideo = /^video\//i.test(contentType) || VideoDL.isMediaUrl(details.url);
      if (!isVtt && !isVideo) {
        return;
      }

      if (!drmProtectedTabs.has(details.tabId)) {
        mergeCandidates(details.tabId, [{
          url: details.url,
          title: isVtt ? "Detected subtitles" : "Detected video",
          type: contentType,
          kind: isVtt ? "vtt" : "video"
        }]);
      }
    },
    { urls: ["<all_urls>"], types: ["media", "xmlhttprequest"] },
    ["responseHeaders"]
  );
})();
