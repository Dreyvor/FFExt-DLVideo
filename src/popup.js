(function initialisePopup() {
  "use strict";

  const content = document.querySelector("#content");
  let activeTabId;
  let activeKind = "video";
  let currentState;
  const rowByUrl = new Map();

  function textElement(tag, className, value) {
    const element = document.createElement(tag);
    element.className = className;
    element.textContent = value;
    return element;
  }

  function showMessage(message, className = "status") {
    content.replaceChildren(textElement("p", className, message));
  }

  function markRowDownloaded(url) {
    const row = rowByUrl.get(url);
    if (!row) {
      return;
    }
    row.classList.remove("downloading");
    row.classList.add("downloaded");
    const button = row.querySelector("button");
    button.disabled = true;
    button.textContent = "Downloaded";
  }

  function renderCollection(media) {
    rowByUrl.clear();
    const matching = media.filter((item) => item.kind === activeKind);
    if (matching.length === 0) {
      return textElement("p", "empty", activeKind === "video" ? "No videos detected." : "No .vtt files detected.");
    }

    const list = document.createElement("ul");
    list.className = "media-list";
    for (const itemData of matching) {
      const item = document.createElement("li");
      item.className = `media-item${itemData.downloaded ? " downloaded" : ""}`;
      rowByUrl.set(itemData.url, item);
      const details = document.createElement("div");
      details.append(
        textElement("div", "media-title", itemData.title || (activeKind === "vtt" ? "Subtitles" : "Video")),
        textElement("div", "media-url", itemData.url)
      );
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = itemData.downloaded ? "Downloaded" : "Download";
      button.disabled = Boolean(itemData.downloaded);
      button.addEventListener("click", async () => {
        button.disabled = true;
        button.textContent = "Starting…";
        item.classList.add("downloading");
        const result = await browser.runtime.sendMessage({
          type: "download",
          tabId: activeTabId,
          url: itemData.url,
          title: itemData.title
        });
        if (result.error) {
          item.classList.remove("downloading");
          button.disabled = false;
          button.textContent = "Retry";
          button.title = result.error;
        } else {
          button.textContent = "Downloading…";
        }
      });
      item.append(details, button);
      list.append(item);
    }
    return list;
  }

  function renderState(state) {
    currentState = state;
    if (state.drmProtected) {
      const message = textElement("p", "error", "DRM-protected media detected.");
      const explanation = textElement("p", "status", "VideoDL does not download or bypass encrypted media.");
      content.replaceChildren(message, explanation);
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
  }

  async function refresh() {
    showMessage("Scanning this page…");
    try {
      const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
      if (!tab || !Number.isInteger(tab.id)) {
        throw new Error("No active browser tab was found.");
      }
      activeTabId = tab.id;
      const state = await browser.runtime.sendMessage({ type: "getState", tabId: activeTabId });
      renderState(state);
    } catch (error) {
      showMessage(error.message || "Unable to inspect this page.", "error");
    }
  }

  document.querySelector("#refresh").addEventListener("click", refresh);
  browser.runtime.onMessage.addListener((message) => {
    if (!message || message.tabId !== activeTabId) {
      return;
    }
    if (message.type === "downloadCompleted") {
      markRowDownloaded(message.url);
      const candidate = currentState && currentState.media.find((item) => item.url === message.url);
      if (candidate) {
        candidate.downloaded = true;
      }
    } else if (message.type === "downloadFailed") {
      const row = rowByUrl.get(message.url);
      if (row) {
        row.classList.remove("downloading");
        const button = row.querySelector("button");
        button.disabled = false;
        button.textContent = "Retry";
      }
    }
  });
  refresh();
})();
