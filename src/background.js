(function initialiseBackground() {
  "use strict";

  const mediaByTab = new Map();
  const drmProtectedTabs = new Set();
  const downloadsById = new Map();
  const downloadedByTab = new Map();
  const downloadFailuresByTab = new Map();
  const plannedFilenamesByTab = new Map();

  function markDrmProtected(tabId) {
    if (tabId >= 0) {
      drmProtectedTabs.add(tabId);
      mediaByTab.delete(tabId);
    }
  }

  function candidateKey(candidate) {
    return candidate.url;
  }

  function activeDownloadUrls(tabId) {
    return new Set(
      [...downloadsById.values()]
        .filter((download) => download.tabId === tabId)
        .map((download) => download.url)
    );
  }

  function downloadedUrls(tabId) {
    if (!downloadedByTab.has(tabId)) {
      downloadedByTab.set(tabId, new Set());
    }
    return downloadedByTab.get(tabId);
  }

  function markDownloaded(tabId, url) {
    downloadedUrls(tabId).add(url);
    if (downloadFailuresByTab.has(tabId)) {
      downloadFailuresByTab.get(tabId).delete(url);
    }
    browser.runtime.sendMessage({ type: "downloadCompleted", tabId, url }).catch(() => {});
  }

  function markDownloadFailed(tabId, url, error) {
    if (!downloadFailuresByTab.has(tabId)) {
      downloadFailuresByTab.set(tabId, new Map());
    }
    const message = error || "The download could not be completed.";
    downloadFailuresByTab.get(tabId).set(url, message);
    browser.runtime.sendMessage({ type: "downloadFailed", tabId, url, error: message }).catch(() => {});
  }

  function clearTabState(tabId) {
    mediaByTab.delete(tabId);
    drmProtectedTabs.delete(tabId);
    downloadedByTab.delete(tabId);
    downloadFailuresByTab.delete(tabId);
    plannedFilenamesByTab.delete(tabId);
    for (const [downloadId, download] of downloadsById) {
      if (download.tabId === tabId) {
        downloadsById.delete(downloadId);
      }
    }
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
        kind: candidate.kind === "vtt" ? "vtt" : "video"
      };
      for (const field of ["title", "type", "language", "label", "suggestedName"]) {
        if (typeof candidate[field] === "string" && candidate[field].trim()) {
          normalised[field] = candidate[field].trim().slice(0, field === "title" ? 200 : 240);
        }
      }
      for (const field of ["width", "height", "durationSeconds", "byteLength"]) {
        const value = Number(candidate[field]);
        if (Number.isFinite(value) && value >= 0) {
          normalised[field] = value;
        }
      }
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
    const downloading = activeDownloadUrls(tabId);
    const failures = downloadFailuresByTab.get(tabId) || new Map();
    const media = drmProtected ? [] : [...(mediaByTab.get(tabId) || new Map()).values()]
      .map((candidate) => ({
        ...candidate,
        downloaded: completed.has(candidate.url),
        downloading: downloading.has(candidate.url),
        error: failures.get(candidate.url) || ""
      }));
    return { drmProtected, media };
  }

  async function startDownload(tabId, file) {
    if (downloadFailuresByTab.has(tabId)) {
      downloadFailuresByTab.get(tabId).delete(file.url);
    }
    const downloadId = await browser.downloads.download({
      url: file.url,
      filename: file.filename,
      saveAs: false,
      conflictAction: "uniquify"
    });
    downloadsById.set(downloadId, { tabId, url: file.url });

    // Small VTT files may complete before the onChanged listener sees them.
    try {
      const [download] = await browser.downloads.search({ id: downloadId });
      if (download && download.state === "complete") {
        markDownloaded(tabId, file.url);
        downloadsById.delete(downloadId);
      }
    } catch (_error) {
      // The onChanged listener remains authoritative if the lookup is unavailable.
    }
    return downloadId;
  }

  async function downloadSet(tabId, videoUrl, vttUrls) {
    if (drmProtectedTabs.has(tabId)) {
      return { error: "DRM-protected media cannot be downloaded.", results: [] };
    }

    const known = mediaByTab.get(tabId);
    const completed = downloadedByTab.get(tabId) || new Set();
    const downloading = activeDownloadUrls(tabId);
    const candidates = new Map(
      [...(known || new Map()).entries()].map(([url, candidate]) => [url, {
        ...candidate,
        downloaded: completed.has(url),
        downloading: downloading.has(url)
      }])
    );
    const validation = VideoDL.validateDownloadSet(candidates, videoUrl, vttUrls);
    if (validation.error) {
      return { error: validation.error, results: [] };
    }

    const plan = VideoDL.buildDownloadPlan(validation.video, validation.captions);
    if (!plannedFilenamesByTab.has(tabId)) {
      plannedFilenamesByTab.set(tabId, new Map());
    }
    for (const file of plan) {
      plannedFilenamesByTab.get(tabId).set(file.url, file.filename);
    }
    const results = [...validation.errors];
    const started = await Promise.all(plan.map(async (file) => {
      try {
        const downloadId = await startDownload(tabId, file);
        return { url: file.url, downloadId, filename: file.filename };
      } catch (error) {
        const message = error.message || "The download could not be started.";
        markDownloadFailed(tabId, file.url, message);
        return { url: file.url, error: message };
      }
    }));
    results.push(...started);
    return { results };
  }

  async function retryDownload(tabId, url) {
    if (drmProtectedTabs.has(tabId)) {
      return { error: "DRM-protected media cannot be downloaded." };
    }
    const candidate = mediaByTab.get(tabId) && mediaByTab.get(tabId).get(url);
    const filename = plannedFilenamesByTab.get(tabId) && plannedFilenamesByTab.get(tabId).get(url);
    if (!candidate || !filename) {
      return { error: "The failed download is no longer available." };
    }
    if ((downloadedByTab.get(tabId) || new Set()).has(url) || activeDownloadUrls(tabId).has(url)) {
      return { error: "This file is already downloaded or downloading." };
    }
    try {
      const downloadId = await startDownload(tabId, { url, filename });
      return { downloadId, filename };
    } catch (error) {
      const message = error.message || "The download could not be started.";
      markDownloadFailed(tabId, url, message);
      return { error: message };
    }
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

    if (message.type === "downloadSet" && Number.isInteger(message.tabId)) {
      return downloadSet(message.tabId, message.videoUrl, message.vttUrls)
        .catch((error) => ({ error: error.message, results: [] }));
    }

    if (message.type === "retryDownload" && Number.isInteger(message.tabId)) {
      return retryDownload(message.tabId, message.url);
    }

    return undefined;
  });

  browser.tabs.onRemoved.addListener((tabId) => {
    clearTabState(tabId);
  });
  browser.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (changeInfo.url || changeInfo.status === "loading") {
      clearTabState(tabId);
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
      markDownloadFailed(
        tracked.tabId,
        tracked.url,
        delta.error && delta.error.current ? delta.error.current : "Download interrupted."
      );
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
      const contentLengthHeader = (details.responseHeaders || []).find(
        (header) => header.name.toLowerCase() === "content-length"
      );
      const contentRangeHeader = (details.responseHeaders || []).find(
        (header) => header.name.toLowerCase() === "content-range"
      );
      const contentDispositionHeader = (details.responseHeaders || []).find(
        (header) => header.name.toLowerCase() === "content-disposition"
      );
      const contentType = contentTypeHeader ? contentTypeHeader.value || "" : "";
      const contentRangeMatch = contentRangeHeader && String(contentRangeHeader.value || "").match(/\/(\d+)$/);
      const byteLengthValue = contentRangeMatch
        ? Number(contentRangeMatch[1])
        : Number(contentLengthHeader && contentLengthHeader.value);
      const isVtt = /^text\/vtt(?:;|$)/i.test(contentType) || VideoDL.isVttUrl(details.url);
      const isVideo = /^video\//i.test(contentType) || VideoDL.isMediaUrl(details.url);
      if (!isVtt && !isVideo) {
        return;
      }

      if (!drmProtectedTabs.has(details.tabId)) {
        mergeCandidates(details.tabId, [{
          url: details.url,
          type: contentType,
          kind: isVtt ? "vtt" : "video",
          byteLength: Number.isFinite(byteLengthValue) && byteLengthValue >= 0 ? byteLengthValue : undefined,
          suggestedName: VideoDL.filenameFromContentDisposition(
            contentDispositionHeader ? contentDispositionHeader.value || "" : ""
          )
        }]);
      }
    },
    { urls: ["<all_urls>"], types: ["media", "xmlhttprequest"] },
    ["responseHeaders"]
  );
})();
