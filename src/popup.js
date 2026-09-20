(function initialisePopup() {
  "use strict";

  const content = document.querySelector("#content");
  const summary = document.querySelector("#selection-summary");
  const hint = document.querySelector("#selection-hint");
  const downloadSelectedButton = document.querySelector("#download-selected");
  let activeTabId;
  let activeKind = "video";
  let currentState;
  let selection = { videoUrl: null, vttUrls: new Set() };
  let initialSelectionApplied = false;
  let startingDownloads = false;

  function textElement(tag, className, value) {
    const element = document.createElement(tag);
    element.className = className;
    element.textContent = value;
    return element;
  }

  function showMessage(message, className = "status") {
    content.replaceChildren(textElement("p", className, message));
  }

  function candidateFor(url) {
    return currentState && currentState.media.find((candidate) => candidate.url === url);
  }

  function updateFooter() {
    const video = candidateFor(selection.videoUrl);
    const selectableVideo = video && !video.downloaded && !video.downloading;
    if (!selectableVideo) {
      summary.textContent = "Select one video";
      hint.textContent = "Captions are optional";
    } else {
      const captionCount = selection.vttUrls.size;
      summary.textContent = "1 video selected";
      hint.textContent = captionCount === 0
        ? "No captions selected"
        : `${captionCount} caption${captionCount === 1 ? "" : "s"} selected`;
    }
    downloadSelectedButton.disabled = !selectableVideo || startingDownloads || Boolean(currentState && currentState.drmProtected);
    downloadSelectedButton.textContent = startingDownloads ? "Starting…" : "Download selected";
  }

  function metadataElement(candidate) {
    const metadata = document.createElement("div");
    metadata.className = "metadata";
    for (const label of VideoDL.metadataLabels(candidate)) {
      metadata.append(textElement("span", "metadata-tag", label));
    }
    return metadata;
  }

  async function retryCandidate(candidate) {
    candidate.error = "";
    candidate.downloading = true;
    renderState(currentState);
    const result = await browser.runtime.sendMessage({
      type: "retryDownload",
      tabId: activeTabId,
      url: candidate.url
    });
    if (result.error) {
      candidate.downloading = false;
      candidate.error = result.error;
    }
    renderState(currentState);
  }

  function createMediaRow(candidate) {
    const selected = candidate.kind === "video"
      ? selection.videoUrl === candidate.url
      : selection.vttUrls.has(candidate.url);
    const item = document.createElement("li");
    item.className = [
      "media-item",
      selected ? "selected" : "",
      candidate.downloading ? "downloading" : "",
      candidate.downloaded ? "downloaded" : ""
    ].filter(Boolean).join(" ");

    const choice = document.createElement("label");
    choice.className = "media-choice";
    const input = document.createElement("input");
    input.type = candidate.kind === "video" ? "radio" : "checkbox";
    input.name = candidate.kind === "video" ? "selected-video" : `caption-${candidate.url}`;
    input.checked = selected;
    input.disabled = Boolean(candidate.downloaded || candidate.downloading);
    input.setAttribute("aria-label", `Select ${candidate.title || candidate.suggestedName || candidate.kind}`);
    input.addEventListener("change", () => {
      if (candidate.kind === "video") {
        selection.videoUrl = input.checked ? candidate.url : null;
      } else if (input.checked) {
        selection.vttUrls.add(candidate.url);
      } else {
        selection.vttUrls.delete(candidate.url);
      }
      renderState(currentState);
    });

    const details = document.createElement("div");
    details.className = "media-details";
    details.append(
      textElement(
        "div",
        "media-title",
        candidate.title || candidate.suggestedName || (candidate.kind === "vtt" ? "Subtitles" : "Video")
      ),
      textElement("div", "media-url", candidate.url)
    );
    const metadata = metadataElement(candidate);
    if (metadata.childElementCount > 0) {
      details.append(metadata);
    }
    if (candidate.downloaded) {
      details.append(textElement("p", "item-success", "Downloaded"));
    } else if (candidate.downloading) {
      details.append(textElement("p", "status", "Downloading…"));
    } else if (candidate.error) {
      details.append(textElement("p", "item-error", candidate.error));
    }
    choice.append(input, details);
    item.append(choice);

    if (candidate.error && !candidate.downloaded && !candidate.downloading) {
      const retry = document.createElement("button");
      retry.type = "button";
      retry.className = "retry";
      retry.textContent = "Retry";
      retry.addEventListener("click", () => retryCandidate(candidate));
      item.append(retry);
    }
    return item;
  }

  function renderCollection(media) {
    const matching = media.filter((item) => item.kind === activeKind);
    if (matching.length === 0) {
      return textElement("p", "empty", activeKind === "video" ? "No videos detected." : "No .vtt files detected.");
    }

    const list = document.createElement("ul");
    list.className = "media-list";
    for (const candidate of matching) {
      list.append(createMediaRow(candidate));
    }
    return list;
  }

  function renderState(state) {
    currentState = state;
    selection = VideoDL.reconcileSelection(state.media, selection, !initialSelectionApplied);
    initialSelectionApplied = true;
    if (state.drmProtected) {
      const message = textElement("p", "error", "DRM-protected media detected.");
      const explanation = textElement("p", "status", "VideoDL does not download or bypass encrypted media.");
      content.replaceChildren(message, explanation);
      updateFooter();
      return;
    }

    const tabs = document.createElement("div");
    tabs.className = "tabs";
    tabs.setAttribute("role", "tablist");
    const counts = {
      video: state.media.filter((item) => item.kind === "video").length,
      vtt: state.media.filter((item) => item.kind === "vtt").length
    };
    for (const kind of ["video", "vtt"]) {
      const tab = document.createElement("button");
      tab.type = "button";
      tab.className = "tab";
      tab.setAttribute("role", "tab");
      tab.setAttribute("aria-selected", String(activeKind === kind));
      tab.textContent = `${kind === "video" ? "Videos" : ".vtt files"} (${counts[kind]})`;
      tab.addEventListener("click", () => {
        activeKind = kind;
        renderState(currentState);
      });
      tabs.append(tab);
    }
    content.replaceChildren(tabs, renderCollection(state.media));
    updateFooter();
  }

  async function downloadSelection() {
    const videoUrl = selection.videoUrl;
    const vttUrls = [...selection.vttUrls];
    const urls = videoUrl ? [videoUrl, ...vttUrls] : [];
    if (!videoUrl || urls.length === 0) {
      return;
    }
    startingDownloads = true;
    for (const url of urls) {
      const candidate = candidateFor(url);
      if (candidate) {
        candidate.error = "";
        candidate.downloading = true;
      }
    }
    renderState(currentState);

    const result = await browser.runtime.sendMessage({
      type: "downloadSet",
      tabId: activeTabId,
      videoUrl,
      vttUrls
    });
    startingDownloads = false;

    if (result.error) {
      for (const url of urls) {
        const candidate = candidateFor(url);
        if (candidate) {
          candidate.downloading = false;
          candidate.error = result.error;
        }
      }
    }
    for (const fileResult of result.results || []) {
      const candidate = candidateFor(fileResult.url);
      if (!candidate) {
        continue;
      }
      if (fileResult.error) {
        candidate.downloading = false;
        candidate.error = fileResult.error;
      } else if (!candidate.downloaded) {
        candidate.downloading = true;
      }
    }
    renderState(currentState);
  }

  async function refresh() {
    showMessage("Scanning this page…");
    try {
      const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
      if (!tab || !Number.isInteger(tab.id)) {
        throw new Error("No active browser tab was found.");
      }
      if (activeTabId !== tab.id) {
        selection = { videoUrl: null, vttUrls: new Set() };
        initialSelectionApplied = false;
      }
      activeTabId = tab.id;
      const state = await browser.runtime.sendMessage({ type: "getState", tabId: activeTabId });
      renderState(state);
    } catch (error) {
      showMessage(error.message || "Unable to inspect this page.", "error");
      downloadSelectedButton.disabled = true;
    }
  }

  document.querySelector("#refresh").addEventListener("click", refresh);
  downloadSelectedButton.addEventListener("click", downloadSelection);
  browser.runtime.onMessage.addListener((message) => {
    if (!message || message.tabId !== activeTabId || !currentState) {
      return;
    }
    const candidate = candidateFor(message.url);
    if (!candidate) {
      return;
    }
    if (message.type === "downloadCompleted") {
      candidate.downloaded = true;
      candidate.downloading = false;
      candidate.error = "";
    } else if (message.type === "downloadFailed") {
      candidate.downloading = false;
      candidate.error = message.error || "Download interrupted.";
    } else {
      return;
    }
    renderState(currentState);
  });
  refresh();
})();
