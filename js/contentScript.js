// Content script for GitHub Smart Downloader UI integration.
// Handles DOM injection, selection state, and progress notifications.

const DEFAULT_SETTINGS = {
  buttonColor: "#8b5cf6",
  buttonText: "Download Repository",
  buttonStyle: "default",
  buttonPosition: "separate",
  themeMode: "system",
};

let buttonRenderNonce = 0;
let downloadButton = null;
let statusToast = null;
let toastHideTimeout = null;
let activeJobId = null;
let progressPulseTimer = null;
let lastToastProgress = 0;
let actionBar = null;
let lastCheckedPath = null;
let selectionDelegationReady = false;
let activeToasts = new Map(); // jobId -> toastElement
let deadJobIds = new Set(); // IDs we've already removed/finished
let pushedOutJobIds = new Set(); // IDs currently in the 'Waiting Room' (hidden)
const selectedItems = new Map();

function isContextValid() {
  try {
    return !!chrome.runtime?.id;
  } catch (e) {
    return false;
  }
}

function safeSendMessage(message, callback) {
  if (!isContextValid()) {
    console.warn(
      "[GRD] Extension context invalidated. Please refresh the page.",
    );
    updateToast(
      "context-error",
      "Extension updated. Please refresh this page to continue.",
      -1,
      true,
    );
    return false;
  }
  try {
    chrome.runtime.sendMessage(message, callback);
    return true;
  } catch (e) {
    console.warn("[GRD] Failed to send message:", e.message);
    if (e.message.includes("context invalidated")) {
      updateToast(
        "context-error",
        "Extension updated. Please refresh this page to continue.",
        -1,
        true,
      );
    }
    return false;
  }
}

function parseGitHubUrl(url) {
  return window.GitDownerShared?.parseGitHubUrl(url) || null;
}

function isRepoPage() {
  return parseGitHubUrl(window.location.href) !== null;
}

function isDirectoryPage() {
  const info = parseGitHubUrl(window.location.href);
  return info && info.path && info.path !== "" && info.isDirectory;
}

function applySettingsToDocument(settings) {
  document.documentElement.style.setProperty(
    "--gd-accent",
    settings.buttonColor || DEFAULT_SETTINGS.buttonColor,
  );
  document.documentElement.dataset.grdButtonStyle =
    settings.buttonStyle || DEFAULT_SETTINGS.buttonStyle;
  document.documentElement.dataset.grdButtonPosition =
    settings.buttonPosition || DEFAULT_SETTINGS.buttonPosition;
}

// Logic for status toast notifications and lifecycle.

function createStatusToast() {
  if (statusToast && document.body.contains(statusToast)) {
    return statusToast;
  }

  statusToast = document.createElement("div");
  statusToast.className = "grd-status-toast";
  statusToast.setAttribute("role", "status");
  statusToast.setAttribute("aria-live", "polite");
  statusToast.setAttribute("aria-atomic", "true");
  statusToast.innerHTML = `
    <div class="gd-toast-content">
      <span class="gd-toast-message">Initializing...</span>
      <button class="gd-toast-close" title="Close" aria-label="Close status">&times;</button>
    </div>
    <div class="gd-toast-meta"></div>
    <div class="gd-toast-progress">
      <div class="gd-toast-progress-bar"></div>
    </div>
  `;

  // Inject styles
  injectStyles();

  // Close button
  statusToast.querySelector(".gd-toast-close").addEventListener("click", () => {
    hideStatusToast();
  });

  document.body.appendChild(statusToast);
  return statusToast;
}

const MAX_TOASTS = 4;

function getToastContainer() {
  let container = document.getElementById("gd-toast-container");
  if (!container) {
    container = document.createElement("div");
    container.id = "gd-toast-container";
    container.style.cssText = `
      position: fixed; bottom: 24px; right: 24px; z-index: 999999;
      display: flex; flex-direction: column; justify-content: flex-end; gap: 12px;
      pointer-events: none; max-width: 360px; width: calc(100% - 48px);
    `;
    document.body.appendChild(container);
  }
  return container;
}

function createToastElement(jobId) {
  const container = getToastContainer();

  const toast = document.createElement("div");
  toast.className = "gd-toast";
  toast.id = `gd-toast-${jobId}`;
  toast.innerHTML = `
    <div class="gd-toast-content">
      <div class="gd-toast-header">
        <div class="gd-toast-message">Starting...</div>
        <div class="gd-toast-actions">
          <button class="gd-toast-cancel" title="Cancel Download">Cancel</button>
          <button class="gd-toast-close" title="Close">&times;</button>
        </div>
      </div>
      <div class="gd-toast-progress-container">
        <div class="gd-toast-progress-bar"></div>
      </div>
      <div class="gd-toast-meta"></div>
    </div>
  `;

  if (!document.getElementById("gd-toast-styles")) {
    const style = document.createElement("style");
    style.id = "gd-toast-styles";
    style.textContent = `
      .gd-toast {
        background: rgba(13, 17, 23, 0.9);
        backdrop-filter: blur(16px);
        -webkit-backdrop-filter: blur(16px);
        color: #e6edf3;
        border: 1px solid rgba(48, 54, 61, 0.8);
        border-radius: 12px;
        box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5);
        padding: 16px;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
        pointer-events: auto;
        animation: gd-toast-in 0.4s cubic-bezier(0.16, 1, 0.3, 1);
        transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
        overflow: hidden;
      }
      .gd-toast-header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 12px; gap: 12px; }
      .gd-toast-actions { display: flex; align-items: center; gap: 8px; }
      .gd-toast-message { font-weight: 600; font-size: 13px; line-height: 1.4; flex: 1; word-break: break-word; }
      .gd-toast-cancel { 
        background: rgba(248, 81, 73, 0.1); 
        border: 1px solid rgba(248, 81, 73, 0.2); 
        color: #f85149; 
        font-size: 10px; 
        font-weight: 700; 
        padding: 2px 6px; 
        border-radius: 4px; 
        cursor: pointer; 
        text-transform: uppercase;
        transition: all 0.2s;
      }
      .gd-toast-cancel:hover { background: #f85149; color: white; border-color: #f85149; }
      .gd-toast-close { background: none; border: none; color: #8b949e; cursor: pointer; font-size: 18px; padding: 0; line-height: 1; opacity: 0.7; transition: opacity 0.2s; }
      .gd-toast-close:hover { opacity: 1; color: white; }
      .gd-toast-progress-container { height: 4px; background: rgba(48, 54, 61, 0.5); border-radius: 2px; overflow: hidden; margin-bottom: 8px; }
      .gd-toast-progress-bar { height: 100%; background: var(--gd-accent, #8b5cf6); width: 0%; transition: width 0.4s cubic-bezier(0.4, 0, 0.2, 1); }
      .gd-toast-meta { font-size: 11px; color: var(--color-fg-muted, #8b949e); font-family: ui-monospace, SFMono-Regular, SF Mono, Menlo, monospace; }
      .gd-toast-error { border-color: var(--color-danger-fg, #f85149); }
      .gd-toast-error .gd-toast-progress-bar { background: var(--color-danger-fg, #f85149); }
      .gd-toast-complete .gd-toast-progress-bar { background: var(--color-success-fg, #3fb950); }
      @keyframes gd-toast-in {
        from { transform: translateY(20px); opacity: 0; }
        to { transform: translateY(0); opacity: 1; }
      }
    `;
    document.head.appendChild(style);
  }

  const cancelBtn = toast.querySelector(".gd-toast-cancel");
  if (cancelBtn) {
    cancelBtn.onclick = () => {
      safeSendMessage({ action: "cancelDownload", jobId });
      removeToast(jobId);
    };
  }

  const closeBtn = toast.querySelector(".gd-toast-close");
  closeBtn.onclick = () => removeToast(jobId);

  getToastContainer().appendChild(toast);
  activeToasts.set(jobId, toast);
  return toast;
}

function removeToast(jobId, isLimitPush = false) {
  const toast = activeToasts.get(jobId);
  if (toast && !toast.classList.contains("gd-toast-removing")) {
    activeToasts.delete(jobId); // Delete instantly to prevent re-updates

    // Only mark as dead if it's NOT a limit-based removal
    if (!isLimitPush) {
      deadJobIds.add(jobId);
      pushedOutJobIds.delete(jobId);
    } else {
      pushedOutJobIds.add(jobId);
    }

    toast.classList.add("gd-toast-removing");
    toast.style.opacity = "0";
    toast.style.transform = "translateY(20px)";
    setTimeout(() => {
      toast.remove();
      activeToasts.delete(jobId);
    }, 300);
  }
}

function updateToast(jobId, message, progress, isError = false, details = {}) {
  // If cancelled or idle, clear the toast
  if (message === "Download cancelled" || details.status === "idle") {
    removeToast(jobId);
    return;
  }

  // 1. If this job is finished or dead, ignore trailing updates
  if (deadJobIds.has(jobId)) return;

  // Cap history to 100 entries to prevent memory leaks
  if (deadJobIds.size > 100) {
    const firstId = deadJobIds.values().next().value;
    deadJobIds.delete(firstId);
  }

  let toast = activeToasts.get(jobId);
  if (!toast) {
    // 1. If this job is dead, ignore it
    if (deadJobIds.has(jobId)) return;

    // 2. If it's a finished message, don't re-spawn anything
    if (progress === 100 || isError || details.status === "complete") {
      deadJobIds.add(jobId);
      return;
    }

    // 3. If we have room, pull it in (whether it's new or was pushed out)
    if (activeToasts.size < MAX_TOASTS) {
      pushedOutJobIds.delete(jobId);
      toast = createToastElement(jobId);
    }
    // 4. If we're at the limit, only a BRAND NEW job can push someone out
    else if (!pushedOutJobIds.has(jobId)) {
      const activeIds = Array.from(activeToasts.keys());
      if (activeIds.length > 0) {
        removeToast(activeIds[0], true); // Push out oldest
        toast = createToastElement(jobId);
      }
    }

    // If we still don't have a toast (it's hidden), just stop here
    if (!toast) return;
  }

  const msgEl = toast.querySelector(".gd-toast-message");
  const metaEl = toast.querySelector(".gd-toast-meta");
  const barEl = toast.querySelector(".gd-toast-progress-bar");

  const rawFilename =
    details.filename || (details.details && details.details.filename);
  if (rawFilename && msgEl) {
    msgEl.textContent = rawFilename;
    const statusPart = toUserStatusMessage(message, isError);
    const sizePart = getSizeMeta(details);
    if (statusPart && sizePart && metaEl) {
      metaEl.innerHTML = `<span>${statusPart}</span> • <span>${sizePart}</span>`;
    } else if (metaEl) {
      metaEl.textContent = statusPart || sizePart || "";
    }
  } else if (msgEl) {
    msgEl.textContent = toUserStatusMessage(message, isError);
    if (metaEl) metaEl.textContent = getSizeMeta(details);
  }

  const isComplete =
    details.status === "complete" ||
    progress >= 100 ||
    message === "Download ready!";

  if (isError) toast.classList.add("gd-toast-error");
  if (isComplete) {
    toast.classList.add("gd-toast-complete");
    toast.classList.remove("gd-toast-error");
    // Hide cancel button on completion
    const cancelBtn = toast.querySelector(".gd-toast-cancel");
    if (cancelBtn) cancelBtn.style.display = "none";
  }

  if (progress >= 0 && barEl) {
    const normalizedProgress = Math.min(100, Math.max(0, progress));
    barEl.style.width = `${normalizedProgress}%`;
  }

  // Update last activity timestamp for the watchdog
  toast.dataset.grdLastUpdate = Date.now();

  if ((isComplete || isError) && !toast.dataset.grdExpiring) {
    toast.dataset.grdExpiring = "true";
    const delay = isError ? 8000 : 3000;
    setTimeout(() => removeToast(jobId), delay);
  }
}

function toUserStatusMessage(message, isError = false) {
  const text = String(message || "");
  if (isError) {
    const lower = text.toLowerCase();
    if (lower.includes("token")) return text;
    if (lower.includes("rate limit"))
      return "GitHub rate limit reached. Use a token to increase limits.";
    if (lower.includes("not found"))
      return "GitHub could not find that file or folder.";
    if (lower.includes("cancel")) return "Download cancelled.";
    if (text.length > 5 && text.length < 120) return text;
    return "Download failed. Try again or choose a smaller selection.";
  }

  return text;
}

function getSizeMeta(details = {}) {
  const downloaded = Number(details.bytesDownloaded) || 0;
  const estimated = Number(details.estimatedBytes) || 0;

  if (downloaded > 0 && estimated > 0) {
    return `${formatBytes(downloaded)} / ${formatBytes(estimated)}`;
  }

  if (downloaded > 0) {
    return `Downloaded: ${formatBytes(downloaded)}`;
  }

  if (estimated > 0) {
    return `Estimated size: ${formatBytes(estimated)}`;
  }

  if (downloaded === 0 && details.status === "downloading") {
    // For filtered/archive downloads, we don't have byte counts yet
    return "";
  }

  if (details.status === "zipping") {
    return "Wrapping up...";
  }

  return "";
}

function formatBytes(bytes) {
  return window.GitDownerShared?.formatBytes(bytes) || "";
}

// Injects global styles for GitHub Smart Downloader UI components.
function injectStyles() {
  if (document.getElementById("grd-styles")) return;

  const style = document.createElement("style");
  style.id = "grd-styles";
  style.textContent = `
    /* ===== MULTI-SELECT ROW CONTROLS ===== */
    
    main tr.grd-selected {
      background: rgba(56, 139, 253, 0.1) !important;
    }

    .react-directory-filename-column {
      display: flex !important;
      align-items: center;
    }

    .react-directory-filename-column > .overflow-hidden {
      flex-grow: 1;
    }

    .grd-checkbox-wrapper.custom-inline-checkbox,
    .custom-inline-checkbox,
    .grd-select-all-checkbox,
    .select-all-checkbox {
      width: 14px;
      height: 14px;
      flex: 0 0 14px;
      flex-shrink: 0;
      cursor: pointer;
      accent-color: var(--gd-accent, #8b5cf6);
    }

    .grd-select-all-checkbox,
    .select-all-checkbox {
      margin: 0 12px 0 0;
    }

    .custom-inline-checkbox {
      margin: 0 8px 0 0;
    }

    .grd-checkbox-wrapper:focus-visible,
    .custom-inline-checkbox:focus-visible,
    .grd-select-all-checkbox:focus-visible,
    .select-all-checkbox:focus-visible,
    .grd-row-download:focus-visible,
    .gd-action-btn:focus-visible,
    #grd-download-btn a:focus-visible {
      outline: 2px solid var(--color-accent-fg, #58a6ff);
      outline-offset: 2px;
    }
    
    /* Download button per row */
    .grd-row-download {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 28px;
      height: 28px;
      border: none;
      background: transparent;
      color: #8b949e;
      cursor: pointer;
      border-radius: 6px;
      transition: all 0.15s ease;
      padding: 0;
    }
    
    .grd-row-download:hover {
      background: rgba(56, 139, 253, 0.15);
      color: #58a6ff;
    }
    
    .grd-row-download:active {
      transform: scale(0.95);
    }
    
    .grd-row-download.grd-downloading {
      pointer-events: none;
    }
    
    .grd-row-download.grd-downloading svg {
      animation: grd-spin 1s linear infinite;
    }
    
    @keyframes grd-spin {
      from { transform: rotate(0deg); }
      to { transform: rotate(360deg); }
    }
    
    /* ===== FLOATING ACTION BAR ===== */
    .gd-floating-bar {
      position: fixed;
      bottom: 30px;
      left: 50%;
      transform: translateX(-50%) translateY(100px);
      display: flex;
      align-items: center;
      gap: 16px;
      padding: 12px 20px;
      background: rgba(22, 27, 34, 0.85);
      backdrop-filter: blur(12px);
      -webkit-backdrop-filter: blur(12px);
      border: 1px solid rgba(48, 54, 61, 0.8);
      border-radius: 12px;
      box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
      z-index: 9999;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif;
      font-size: 14px;
      opacity: 0;
      transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
      pointer-events: none;
    }
    
    .gd-floating-bar.grd-visible {
      opacity: 1;
      transform: translateX(-50%) translateY(0);
      pointer-events: auto;
    }
    
    .gd-floating-bar-count {
      color: #c9d1d9;
      font-weight: 500;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    
    .gd-floating-bar-count-num {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-width: 20px;
      height: 20px;
      padding: 0 6px;
      background: var(--gd-accent, #8b5cf6);
      color: white;
      border-radius: 4px;
      font-size: 11px;
      font-weight: 600;
    }
    
    .gd-floating-bar-divider {
      width: 1px;
      height: 24px;
      background: #30363d;
    }
    
    .gd-action-btn {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 16px;
      border: none;
      border-radius: 8px;
      font-size: 14px;
      font-weight: 500;
      cursor: pointer;
      transition: all 0.15s ease;
    }
    
    .gd-btn-primary {
      background-color: var(--gd-accent, #8b5cf6) !important;
      color: white !important;
      border: 1px solid rgba(255, 255, 255, 0.2) !important;
      border-radius: 6px;
    }
    
    .gd-btn-primary:active {
      filter: brightness(0.75);
      transform: none;
    }
    html[data-grd-button-position="integrated"] #grd-download-btn .grd-main-download-link {
      background: transparent !important;
      background-image: none !important;
      border: none !important;
      box-shadow: none !important;
      color: var(--fgColor-default, #c9d1d9) !important;
      transition: color 0.2s ease-in-out;
      padding: 0 16px;
      display: flex;
      align-items: center;
      height: 100%;
      text-decoration: none !important;
      transform: none !important;
      font-size: 14px;
      font-weight: 500;
      cursor: pointer !important;
    }

    html[data-grd-button-position="integrated"] #grd-download-btn .grd-main-download-link:hover {
      color: var(--gd-accent, #8b5cf6) !important;
      background: transparent !important;
      background-color: transparent !important;
    }

    html[data-grd-button-position="separate"] #grd-download-btn .grd-main-download-link {
      height: 30px;
      padding: 0 12px;
      display: flex;
      align-items: center;
      justify-content: center;
      border-radius: 6px;
      transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1);
      font-size: 14px;
      text-decoration: none !important;
      color: white !important;
      background-color: var(--gd-accent, #8b5cf6) !important;
      font-weight: 600;
      border: 1px solid rgba(255, 255, 255, 0.2) !important;
      cursor: pointer !important;
    }

    html[data-grd-button-position="separate"] #grd-download-btn .grd-main-download-link:hover {
      background-color: #7c3aed !important;
      color: white !important;
      filter: saturate(1.2) !important;
      transform: translateY(-2px) !important;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15) !important;
      border-color: #7c3aed !important;
      text-decoration: none !important;
    }

    .gd-btn-secondary {
      background: transparent;
      color: #8b949e;
      border: 1px solid #30363d;
    }

    .gd-btn-secondary:hover {
      background: rgba(110, 118, 129, 0.1);
      color: #c9d1d9;
      border-color: #8b949e;
    }

    .grd-download-mount {
      display: flex;
      justify-content: flex-end;
      align-items: center;
      margin: 0 0 8px;
      min-height: 34px;
    }

    html[data-grd-button-style="none"] #grd-download-btn .grd-main-download-link {
      background: transparent !important;
      border: 1px solid transparent !important;
      padding-inline: 0;
      color: var(--gd-accent, #8b5cf6) !important;
    }

    html[data-grd-button-style="outline"] #grd-download-btn .grd-main-download-link {
      border: 1px solid currentColor !important;
      background: transparent !important;
      color: var(--gd-accent, #8b5cf6) !important;
    }

    html[data-grd-button-style="rounded"] #grd-download-btn .grd-main-download-link {
      border-radius: 8px;
    }

    html[data-grd-button-style="pill"] #grd-download-btn .grd-main-download-link {
      border-radius: 12px;
    }
  `;
  document.head.appendChild(style);
}

function addDownloadButton() {
  if (!isRepoPage() || !isContextValid()) return;
  const nonce = ++buttonRenderNonce;

  try {
    chrome.storage.sync.get(DEFAULT_SETTINGS, (settings) => {
      if (nonce !== buttonRenderNonce || !isRepoPage() || !settings) return;

      const currentButton = document.querySelector("#grd-download-btn");
      const isIntegrated = settings.buttonPosition === "integrated";

      if (currentButton) {
        const parentIsNav = currentButton.closest(
          'nav, .UnderlineNav, [class*="UnderlineNav"]',
        );
        if ((isIntegrated && parentIsNav) || (!isIntegrated && !parentIsNav)) {
          return; // Already in correct position
        }
        removeInjectedDownloadButtons();
      }

      applySettingsToDocument(settings);

      if (isIntegrated) {
        injectIntegratedButton(settings);
      } else {
        injectSeparateButton(settings);
      }
    });
  } catch (e) {
    console.warn("[GRD] Context invalid during button injection");
  }
}

function injectIntegratedButton(settings) {
  // Use specific selectors for the Insights tab across different GitHub UI versions
  const insightsTab = Array.from(
    document.querySelectorAll(
      '.prc-UnderlineNav-UnderlineNavItem-syRjR, nav[aria-label="Repository"] li, .UnderlineNav-body li',
    ),
  ).find((el) => el.textContent.trim().includes("Insights"));

  if (!insightsTab) return;

  const downloadLi = document.createElement("li");
  downloadLi.id = "grd-download-btn";
  downloadLi.dataset.grdMainDownload = "true";
  downloadLi.className = insightsTab.className;

  const downloadLink = document.createElement("a");
  downloadLink.href = "#";
  downloadLink.className = "grd-main-download-link";
  downloadLink.innerText = "Download";

  // Style reset to match nav bar exactly as requested
  Object.assign(downloadLink.style, {
    background: "none",
    backgroundColor: "transparent",
    color: "inherit",
    padding: "0 16px",
    height: "100%",
    display: "flex",
    alignItems: "center",
    fontSize: "14px",
    border: "none",
    margin: "0",
    textDecoration: "none",
    cursor: "pointer",
    transition: "color 0.2s ease",
  });

  downloadLink.addEventListener("click", (e) => {
    e.preventDefault();
    startDownload();
  });

  downloadLi.appendChild(downloadLink);
  insightsTab.after(downloadLi);
  downloadButton = downloadLi;
}

function injectSeparateButton(settings) {
  // Find the GitHub search button to use as a positional anchor
  const searchButton = document.querySelector(
    "button.Search-module__searchButton__aiE0a, .header-search-button",
  );
  const searchParent = searchButton?.parentElement;

  let mount = searchParent;
  let useSearchLogic = !!searchParent;

  if (!useSearchLogic) {
    mount = getDownloadButtonMount();
  }

  if (!mount) return;

  const isDir = isDirectoryPage();
  const buttonText = isDir
    ? settings.buttonText.replace("Repository", "Directory")
    : settings.buttonText;

  const useListItem = mount.matches("ul, ol");
  downloadButton = document.createElement(useListItem ? "li" : "div");
  downloadButton.id = "grd-download-btn";
  downloadButton.dataset.grdMainDownload = "true";
  downloadButton.className = "d-flex";

  // Positional logic for header injection
  if (useSearchLogic) {
    mount.style.display = "flex";
    mount.style.flexDirection = "row";
    mount.style.alignItems = "center";
    mount.style.flexWrap = "nowrap";
    downloadButton.style.marginRight = "8px";
    downloadButton.style.flexShrink = "0";
  } else {
    downloadButton.style.marginLeft = "8px";
    downloadButton.style.alignItems = "center";
  }

  downloadButton.innerHTML = `
    <a class="grd-main-download-link" role="button" style="display: inline-flex; white-space: nowrap; text-decoration: none;">
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="16" height="16" fill="currentColor" style="margin-right: 4px;">
        <path d="M2.75 14A1.75 1.75 0 0 1 1 12.25v-2.5a.75.75 0 0 1 1.5 0v2.5c0 .138.112.25.25.25h10.5a.25.25 0 0 0 .25-.25v-2.5a.75.75 0 0 1 1.5 0v2.5A1.75 1.75 0 0 1 13.25 14Z"/>
        <path d="M7.25 7.689V2a.75.75 0 0 1 1.5 0v5.689l1.97-1.969a.749.749 0 1 1 1.06 1.06l-3.25 3.25a.749.749 0 0 1-1.06 0L4.22 6.78a.749.749 0 1 1 1.06-1.06l1.97 1.969Z"/>
      </svg>
      <span>${buttonText}</span>
    </a>
  `;

  const link = downloadButton.querySelector("a");
  link.addEventListener("click", (e) => {
    e.preventDefault();
    startDownload();
  });

  if (useSearchLogic && searchButton) {
    mount.insertBefore(downloadButton, searchButton);
  } else {
    mount.appendChild(downloadButton);
  }
}

function removeInjectedDownloadButtons() {
  document
    .querySelectorAll('#grd-download-btn, [data-grd-main-download="true"]')
    .forEach((node) => node.remove());
  document.querySelectorAll(".grd-download-mount").forEach((node) => {
    if (
      node.children.length === 0 ||
      node.querySelector('[data-grd-main-download="true"], #grd-download-btn')
    ) {
      node.remove();
    }
  });
  downloadButton = null;
}

function getFileListContainer() {
  const firstRow = document.querySelector(
    'main tr.react-directory-row, main tr:has(a.Link--primary[href*="/tree/"]), main tr:has(a.Link--primary[href*="/blob/"])',
  );
  return (
    firstRow?.closest('.Box, table, [role="grid"], .react-directory') || null
  );
}

function isMainContentMount(candidate, fileList) {
  if (!candidate || !candidate.isConnected || !candidate.closest("main"))
    return false;
  if (
    candidate.closest(
      'aside, nav, [aria-label*="Files"], [aria-label*="files"]',
    )
  )
    return false;
  if (!fileList) return true;

  const candidateRect = candidate.getBoundingClientRect();
  const fileRect = fileList.getBoundingClientRect();
  if (!candidateRect.width || !fileRect.width) return true;

  const tooFarLeft =
    candidateRect.right < fileRect.left + Math.min(120, fileRect.width * 0.12);
  const tooNarrow = candidateRect.width < Math.min(360, fileRect.width * 0.35);
  return !tooFarLeft && !tooNarrow;
}

function getDownloadButtonMount() {
  const fileList = getFileListContainer();
  const candidates = Array.from(
    document.querySelectorAll(
      [
        "main .file-navigation .d-flex.flex-items-center",
        "main .file-navigation",
        "main .repository-content .d-flex.flex-items-center",
        "main .pagehead-actions",
      ].join(","),
    ),
  );

  const existing = candidates.find((candidate) =>
    isMainContentMount(candidate, fileList),
  );
  if (existing) return existing;

  if (!fileList?.parentElement) return null;

  let mount = document.getElementById("grd-download-mount");
  if (!mount) {
    mount = document.createElement("div");
    mount.id = "grd-download-mount";
    mount.className = "grd-download-mount";
    fileList.parentElement.insertBefore(mount, fileList);
  }

  return mount;
}

function startDownload(targetUrl, existingJobId) {
  const url = targetUrl || window.location.href;
  const repoInfo = parseGitHubUrl(url);

  if (!repoInfo) {
    updateToast(
      "temp-" + Date.now(),
      "Could not parse repository information",
      -1,
      true,
    );
    return;
  }

  const jobId = existingJobId || "job-" + Date.now();
  if (!existingJobId) {
    updateToast(jobId, "Starting download...", 0);
  }

  safeSendMessage(
    {
      action: "startDownload",
      url: url,
      jobId: jobId,
    },
    (response) => {
      if (chrome.runtime.lastError) {
        updateToast(
          jobId,
          `Error: ${chrome.runtime.lastError.message}`,
          -1,
          true,
        );
        return;
      }

      if (response?.jobId) {
        activeJobId = response.jobId;
      } else if (response?.error) {
        updateToast(jobId, `Error: ${response.error}`, -1, true);
      }
    },
  );
}

const ICONS = {
  download: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="16" height="16" fill="currentColor">
    <path d="M2.75 14A1.75 1.75 0 0 1 1 12.25v-2.5a.75.75 0 0 1 1.5 0v2.5c0 .138.112.25.25.25h10.5a.25.25 0 0 0 .25-.25v-2.5a.75.75 0 0 1 1.5 0v2.5A1.75 1.75 0 0 1 13.25 14Z"/>
    <path d="M7.25 7.689V2a.75.75 0 0 1 1.5 0v5.689l1.97-1.969a.749.749 0 1 1 1.06 1.06l-3.25 3.25a.749.749 0 0 1-1.06 0L4.22 6.78a.749.749 0 1 1 1.06-1.06l1.97 1.969Z"/>
  </svg>`,
  spinner: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="16" height="16" fill="currentColor">
    <path d="M8 0a8 8 0 1 0 8 8h-1.5A6.5 6.5 0 1 1 8 1.5V0Z"/>
  </svg>`,
  folder: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="16" height="16" fill="currentColor">
    <path d="M1.75 1A1.75 1.75 0 0 0 0 2.75v10.5C0 14.216.784 15 1.75 15h12.5A1.75 1.75 0 0 0 16 13.25v-8.5A1.75 1.75 0 0 0 14.25 3H7.5a.25.25 0 0 1-.2-.1l-.9-1.2c-.33-.44-.85-.7-1.4-.7H1.75Z"/>
  </svg>`,
};

function getRowItemInfo(row) {
  if (!row || !row.matches("tr")) return null;
  const nameLink = row.querySelector("a.Link--primary");
  if (!nameLink) return null;
  const name = nameLink.textContent.trim();
  const href = nameLink.getAttribute("href") || "";
  return (
    window.GitDownerShared?.getSelectableGitHubItem(
      window.location.href,
      href,
      name,
    ) || null
  );
}

function getRowControlHosts(row) {
  const nameLink = row.querySelector("a.Link--primary");
  const nameCell =
    nameLink?.closest('td, [role="gridcell"]') ||
    row.querySelector('td, [role="gridcell"]');
  if (!nameCell) return null;
  const filenameColumns = Array.from(
    row.querySelectorAll(".react-directory-filename-column"),
  );
  if (filenameColumns.length > 0) return filenameColumns;
  const flexWrapper = Array.from(nameCell.querySelectorAll("div, span")).find(
    (node) => getComputedStyle(node).display.includes("flex"),
  );
  if (flexWrapper) return [flexWrapper];
  return [nameCell.querySelector(":scope > div, :scope > span") || nameCell];
}

function injectInlineDownloadIcons() {
  const rows = getFileRows();
  rows.forEach((row) => {
    if (row.querySelector(".grd-inline-download-btn")) return;
    const dateEl = row.querySelector("relative-time");
    if (!dateEl) return;
    const dateContainer = dateEl.parentElement;
    if (!dateContainer) return;
    const info = getRowItemInfo(row);
    if (!info) return;

    const btn = document.createElement("a");
    btn.className = "grd-inline-download-btn";
    btn.title = `Download ${info.name}`;
    btn.innerHTML = `
      <svg aria-hidden="true" height="16" viewBox="0 0 16 16" version="1.1" width="16" fill="currentColor">
        <path d="M7.47 10.78a.75.75 0 0 0 1.06 0l3.25-3.25a.75.75 0 0 0-1.06-1.06L8.75 8.44V1.75a.75.75 0 0 0-1.5 0v6.69L5.28 6.47a.75.75 0 0 0-1.06 1.06l3.25 3.25Z"></path>
        <path d="M2.75 13a.75.75 0 0 0 0 1.5h10.5a.75.75 0 0 0 0-1.5H2.75Z"></path>
      </svg>
    `;
    Object.assign(btn.style, {
      marginRight: "10px",
      color: "#656d76",
      display: "inline-flex",
      alignItems: "center",
      transition: "color 0.2s, transform 0.1s",
      flexShrink: "0",
      textDecoration: "none",
      cursor: "pointer",
    });
    btn.onmouseenter = () => (btn.style.color = "#7c3aed");
    btn.onmouseleave = () => (btn.style.color = "#656d76");
    btn.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      const link = row.querySelector("a.Link--primary");
      if (link) {
        startDownload(
          new URL(link.getAttribute("href"), window.location.origin).href,
        );
      }
    };
    dateContainer.style.display = "flex";
    dateContainer.style.alignItems = "center";
    dateContainer.prepend(btn);
  });
}

function getFileRows() {
  const rows = Array.from(
    document.querySelectorAll(
      'main tr.react-directory-row, main tr:has(a.Link--primary[href*="/tree/"]), main tr:has(a.Link--primary[href*="/blob/"])',
    ),
  ).filter((row) => getRowItemInfo(row));

  // Wait for at least one row to have a date/commit info before considering the list 'ready'
  // This prevents the 'triple load' flicker as GitHub populates the list asynchronously
  const readyRows = rows.filter((row) =>
    row.querySelector(
      'relative-time, .react-directory-commit-message, [id^="commit-message-"]',
    ),
  );

  return readyRows.length > 0 ? readyRows : [];
}

function getRowCheckboxes() {
  return Array.from(document.querySelectorAll(".custom-inline-checkbox"));
}

function getUniqueRowCheckboxes() {
  const seen = new Set();
  return getRowCheckboxes().filter((checkbox) => {
    const path = checkbox.dataset.path;
    if (!path || seen.has(path)) return false;
    seen.add(path);
    return true;
  });
}

function getSelectAllCheckbox() {
  return document.querySelector(
    ".grd-select-all-checkbox, .select-all-checkbox",
  );
}

function getSelectionCheckboxesForRow(row, itemInfo) {
  if (!row || !itemInfo) return [];
  return Array.from(row.querySelectorAll(".custom-inline-checkbox")).filter(
    (checkbox) => checkbox.dataset.path === itemInfo.path,
  );
}

function setItemSelected(row, itemInfo, checked) {
  if (!row || !itemInfo) return;
  getSelectionCheckboxesForRow(row, itemInfo).forEach((checkbox) => {
    setCheckboxState(checkbox, checked);
  });
  if (checked) {
    selectedItems.set(itemInfo.path, itemInfo);
    row.classList.add("grd-selected");
  } else {
    selectedItems.delete(itemInfo.path);
    row.classList.remove("grd-selected");
  }
}

function updateSelectAllState() {
  const selectAllCheckbox = getSelectAllCheckbox();
  if (!selectAllCheckbox) return;
  const rows = getFileRows();
  const total = rows.length;
  const selectedCount = rows.filter((row) => {
    const info = getRowItemInfo(row);
    return info && selectedItems.has(info.path);
  }).length;
  selectAllCheckbox.checked = total > 0 && selectedCount === total;
  selectAllCheckbox.indeterminate = selectedCount > 0 && selectedCount < total;
}

function setAllItemsSelected(checked) {
  const rows = getFileRows();
  rows.forEach((row) => {
    const info = getRowItemInfo(row);
    if (info) setItemSelected(row, info, checked);
  });
  lastCheckedPath = checked
    ? rows.at(-1)?.querySelector(".custom-inline-checkbox")?.dataset.path ||
      null
    : null;
  updateActionBar();
  updateSelectAllState();
}

function handleRowCheckboxChange(checkbox, shiftKey) {
  const row = checkbox.closest("tr");
  const itemInfo = getRowItemInfo(row);
  if (!row || !itemInfo) return;
  const isChecked = checkbox.checked;
  const allWrappers = getUniqueRowCheckboxes();
  const currentIndex = allWrappers.findIndex(
    (wrapper) => wrapper.dataset.path === itemInfo.path,
  );
  if (shiftKey && lastCheckedPath !== null && currentIndex >= 0) {
    const lastIndex = allWrappers.findIndex(
      (wrapper) => wrapper.dataset.path === lastCheckedPath,
    );
    if (lastIndex >= 0) {
      const start = Math.min(currentIndex, lastIndex);
      const end = Math.max(currentIndex, lastIndex);
      for (let i = start; i <= end; i++) {
        const wrapper = allWrappers[i];
        const wrapperRow = wrapper.closest("tr");
        const info = getRowItemInfo(wrapperRow);
        if (info) setItemSelected(wrapperRow, info, isChecked);
      }
    }
  } else {
    setItemSelected(row, itemInfo, isChecked);
  }
  lastCheckedPath = isChecked ? itemInfo.path : null;
  updateActionBar();
  updateSelectAllState();
}

function getSelectAllHost() {
  const latestCommitBox = document.querySelector(
    "main .LatestCommit-module__Box__B25ZT",
  );
  if (latestCommitBox) return latestCommitBox;
  const table = document.querySelector(
    'main table[aria-label="Folders and files"]',
  );
  const firstBodyRow = table?.querySelector("tbody tr");
  if (!firstBodyRow || getRowItemInfo(firstBodyRow)) return null;
  const authorLink = firstBodyRow.querySelector(
    'a[href*="commits?author="], a[href^="/"][href*="?author="]',
  );
  const host =
    authorLink?.parentElement || firstBodyRow.querySelector("td div");
  return host || null;
}

function injectSelectAllControl() {
  const host = getSelectAllHost();
  if (!host) {
    updateSelectAllState();
    return;
  }
  document
    .querySelectorAll(".grd-select-all-checkbox, .select-all-checkbox")
    .forEach((checkbox) => {
      if (!host.contains(checkbox)) checkbox.remove();
    });
  if (host.querySelector(".grd-select-all-checkbox, .select-all-checkbox")) {
    updateSelectAllState();
    return;
  }
  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.className = "grd-select-all-checkbox select-all-checkbox";
  checkbox.setAttribute("aria-label", "Select all files and folders");
  checkbox.style.cssText =
    "margin-right: 12px; cursor: pointer; flex-shrink: 0;";
  checkbox.addEventListener("click", (event) => event.stopPropagation());
  host.style.display = "flex";
  host.style.alignItems = "center";
  host.prepend(checkbox);
  updateSelectAllState();
}

function createCheckboxControl(row, itemInfo) {
  const checkboxWrapper = document.createElement("input");
  checkboxWrapper.type = "checkbox";
  checkboxWrapper.className =
    "grd-checkbox-wrapper grd-row-select-control custom-inline-checkbox";
  checkboxWrapper.setAttribute("aria-label", `Select ${itemInfo.name}`);
  checkboxWrapper.dataset.path = itemInfo.path;
  checkboxWrapper.addEventListener("click", (e) => {
    checkboxWrapper.dataset.grdShiftKey = e.shiftKey ? "true" : "false";
    e.stopPropagation();
  });
  checkboxWrapper.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.stopPropagation();
    }
  });
  return checkboxWrapper;
}

function setupSelectionDelegation() {
  if (selectionDelegationReady || !document.body) return;
  selectionDelegationReady = true;
  document.body.addEventListener("change", (event) => {
    const target = event.target;
    if (!target || target.tagName !== "INPUT") return;
    if (target.classList.contains("custom-inline-checkbox")) {
      handleRowCheckboxChange(target, target.dataset.grdShiftKey === "true");
      delete target.dataset.grdShiftKey;
      return;
    }
    if (
      target.classList.contains("select-all-checkbox") ||
      target.classList.contains("grd-select-all-checkbox")
    ) {
      setAllItemsSelected(target.checked);
    }
  });
}

function setCheckboxState(wrapper, checked) {
  if (!wrapper) return;
  wrapper.checked = checked;
  wrapper.setAttribute("aria-checked", checked ? "true" : "false");
  if (checked) {
    wrapper.classList.add("grd-checked");
  } else {
    wrapper.classList.remove("grd-checked");
  }
}

function createActionBar() {
  if (actionBar && document.body.contains(actionBar)) {
    return actionBar;
  }
  actionBar = document.createElement("div");
  actionBar.className = "gd-floating-bar";
  actionBar.innerHTML = `
    <div class="gd-floating-bar-count">
      <span class="gd-floating-bar-count-num">0</span>
      <span>items selected</span>
    </div>
    <div class="gd-floating-bar-divider"></div>
    <button class="gd-action-btn gd-btn-primary grd-download-selected">
      ${ICONS.download}
      <span>Download Selected</span>
    </button>
    <button class="gd-action-btn gd-btn-secondary grd-clear-selection">
      Clear
    </button>
  `;
  actionBar
    .querySelector(".grd-download-selected")
    .addEventListener("click", () => {
      downloadSelectedItems();
    });
  actionBar
    .querySelector(".grd-clear-selection")
    .addEventListener("click", () => {
      clearSelection();
    });
  document.body.appendChild(actionBar);
  return actionBar;
}

function updateActionBar() {
  const bar = createActionBar();
  const count = selectedItems.size;
  bar.querySelector(".gd-floating-bar-count-num").textContent = count;
  bar.querySelector(".gd-floating-bar-count span:last-child").textContent =
    count === 1 ? "item selected" : "items selected";
  if (count > 0) {
    bar.classList.add("grd-visible");
  } else {
    bar.classList.remove("grd-visible");
  }
}

function clearSelection() {
  selectedItems.clear();
  document.querySelectorAll(".grd-checkbox-wrapper").forEach((wrapper) => {
    setCheckboxState(wrapper, false);
  });
  document.querySelectorAll("tr.grd-selected").forEach((row) => {
    row.classList.remove("grd-selected");
  });
  updateActionBar();
  updateSelectAllState();
}

function getAllVisibleSelectableItems() {
  return getFileRows()
    .map((row) => getRowItemInfo(row))
    .filter(Boolean);
}

function getExcludedTopLevelItems(allItems, selectedPaths) {
  return allItems
    .filter((item) => !selectedPaths.has(item.path))
    .map((item) => item.path.split("/")[0])
    .filter(Boolean);
}

function buildStrategyInput(repoInfo, allVisibleItems, selectedItemsList) {
  const selectedPaths = new Set(selectedItemsList.map((item) => item.path));
  const excludedTopLevelPaths = getExcludedTopLevelItems(
    allVisibleItems,
    selectedPaths,
  );
  return {
    input: {
      isRepoRoot: repoInfo.isRepoRoot,
      totalVisible: allVisibleItems.length,
      selectedCount: selectedItemsList.length,
      selectedDirs: selectedItemsList.filter((item) => item.type === "dir")
        .length,
      selectedFiles: selectedItemsList.filter((item) => item.type === "file")
        .length,
      excludedCount: Math.max(
        0,
        allVisibleItems.length - selectedItemsList.length,
      ),
      excludedTopLevelCount: excludedTopLevelPaths.length,
    },
    excludedTopLevelPaths,
  };
}

async function downloadSelectedItems() {
  if (selectedItems.size === 0) return;
  const repoInfo = parseGitHubUrl(window.location.href);
  if (!repoInfo) {
    updateToast(
      "temp-" + Date.now(),
      "Could not parse repository info",
      -1,
      true,
    );
    return;
  }
  const items = Array.from(selectedItems.values());
  const jobId = "job-" + Date.now();

  // Clear selection immediately to allow the user to start a new selection
  clearSelection();

  updateToast(jobId, "Analyzing selection...", 5);

  try {
    const allVisibleItems = getAllVisibleSelectableItems();
    const { input: strategyInput, excludedTopLevelPaths } = buildStrategyInput(
      repoInfo,
      allVisibleItems,
      items,
    );

    const plan = (await new Promise((resolve) => {
      safeSendMessage(
        {
          action: "planStrategy",
          repoInfo,
          input: strategyInput,
          jobId: jobId, // Pass jobId for progress updates
        },
        resolve,
      );
    })) || { strategy: "selectedRecursiveZip" };

    // Update repoInfo with background-resolved metadata to avoid double fetching
    if (plan.resolvedRef) repoInfo.ref = plan.resolvedRef;
    if (plan.resolvedSize) repoInfo.totalRepoSizeKb = plan.resolvedSize;

    if (plan.strategy === "fullArchive") {
      startDownload(null, jobId);
      return;
    }

    if (plan.strategy === "filteredArchive") {
      safeSendMessage({
        action: "downloadFilteredRepository",
        repoInfo,
        excludedTopLevelPaths,
        includedPaths: items.map((i) => i.path), // Pass selection for surgical extraction
        jobId: jobId,
      });
      return;
    }

    safeSendMessage({
      action: "downloadItems",
      items: items,
      repoInfo: repoInfo,
      jobId: jobId,
    });
  } catch (error) {
    updateToast(jobId, error.message, -1, true);
  }
}

function selectAllItems() {
  setAllItemsSelected(true);
}

function setupKeyboardShortcuts() {
  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "a") {
      if (
        document.activeElement.tagName !== "INPUT" &&
        document.activeElement.tagName !== "TEXTAREA" &&
        window.getSelection().toString() === ""
      ) {
        e.preventDefault();
        const allCount = getFileRows().length;
        if (allCount > 0) {
          if (selectedItems.size === allCount) {
            clearSelection();
          } else {
            selectAllItems();
          }
        }
      }
    }
    if (e.key === "Escape") {
      if (selectedItems.size > 0) {
        e.preventDefault();
        clearSelection();
      }
    }
  });
}

function injectRowControls() {
  cleanupInvalidInjectedControls();
  const rows = getFileRows();
  rows.forEach((row) => {
    row
      .querySelectorAll(
        ".grd-checkbox-cell, .grd-download-cell, .grd-row-select-control, .grd-row-download-control",
      )
      .forEach((cell) => cell.remove());
    const itemInfo = getRowItemInfo(row);
    if (!itemInfo) return;
    const controlHosts = getRowControlHosts(row);
    if (!controlHosts || controlHosts.length === 0) return;
    row.dataset.grdInjected = "true";
    controlHosts.forEach((controlHost) => {
      const checkbox = createCheckboxControl(row, itemInfo);
      if (selectedItems.has(itemInfo.path)) {
        setCheckboxState(checkbox, true);
      }
      controlHost.prepend(checkbox);
    });
  });
  injectSelectAllControl();
}

function cleanupInvalidInjectedControls() {
  document.querySelectorAll('tr[data-grd-injected="true"]').forEach((row) => {
    if (getRowItemInfo(row)) return;
    row
      .querySelectorAll(
        ".grd-checkbox-cell, .grd-download-cell, .grd-row-select-control, .grd-row-download-control",
      )
      .forEach((cell) => cell.remove());
    row.classList.remove("grd-selected");
    delete row.dataset.grdInjected;
  });
  document
    .querySelectorAll(".grd-select-all-cell, .grd-select-all")
    .forEach((node) => {
      const cell = node.closest("th,td") || node;
      cell.remove();
    });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "progressUpdate") {
    const { jobId, status, message: msg, progress } = message;
    if (jobId) {
      updateToast(jobId, msg, progress, status === "error", {
        ...message,
        status,
      });
    }
    return false;
  }

  if (message.action === "triggerDownload") {
    const { blob, filename } = message;
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 100);
    return false;
  }

  // Legacy support for popup requests
  if (message.action === "downloadSubdirectory") {
    startDownload();
    sendResponse({ success: true, message: "Download started" });
    return true;
  }

  return false;
});

function setupObserver() {
  // Debounce utility for performance
  function debounce(fn, delay) {
    let timeout;
    return (...args) => {
      clearTimeout(timeout);
      timeout = setTimeout(() => fn.apply(this, args), delay);
    };
  }

  const runInjectionPass = () => {
    injectStyles();
    setupSelectionDelegation();
    addDownloadButton();
    injectRowControls();
    injectInlineDownloadIcons();
  };

  const handleRouteChange = () => {
    selectedItems.clear();
    deadJobIds.clear();
    pushedOutJobIds.clear();
    lastCheckedPath = null;
    if (actionBar) {
      actionBar.classList.remove("grd-visible");
    }

    buttonRenderNonce++;
    removeInjectedDownloadButtons();

    document.querySelectorAll('tr[data-grd-injected="true"]').forEach((row) => {
      row
        .querySelectorAll(
          ".grd-checkbox-cell, .grd-download-cell, .grd-row-select-control, .grd-row-download-control",
        )
        .forEach((cell) => cell.remove());
      row.classList.remove("grd-selected");
      delete row.dataset.grdInjected;
    });
    document
      .querySelectorAll(".grd-select-all-checkbox, .select-all-checkbox")
      .forEach((node) => node.remove());

    // Single initial pass - let MutationObserver handle the 'readiness' via getFileRows()
    setTimeout(runInjectionPass, 250);
  };

  // Initial injection
  setTimeout(runInjectionPass, 300);

  // Watch for navigation changes (GitHub SPA)
  let lastUrl = location.href;

  // Debounced row injection (100ms delay)
  const debouncedInjectRows = debounce(() => {
    const uninjectRows = getFileRows().filter(
      (row) => !row.dataset.grdInjected,
    );
    if (
      !document.querySelector(
        '#grd-download-btn, [data-grd-main-download="true"]',
      )
    ) {
      addDownloadButton();
    }

    if (uninjectRows.length > 0) {
      injectRowControls();
      injectInlineDownloadIcons();
    } else {
      injectSelectAllControl();
      injectInlineDownloadIcons();
    }
  }, 100);

  const observer = new MutationObserver(() => {
    // Check for URL changes
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      handleRouteChange();
    }

    // Debounced check for new rows
    debouncedInjectRows();

    // Watchdog: cleanup stuck or completed toasts
    const container = document.getElementById("gd-toast-container");
    if (container) {
      const now = Date.now();
      container
        .querySelectorAll(".gd-toast:not(.gd-toast-removing)")
        .forEach((toast) => {
          const isComplete = toast.classList.contains("gd-toast-complete");
          const lastUpdate = parseInt(toast.dataset.grdLastUpdate || 0);
          const timeSinceUpdate = now - lastUpdate;

          // Cleanup completed toasts after a short delay
          if (isComplete && !toast.dataset.grdCleaning) {
            toast.classList.add("gd-toast-cleaning");
            const jobId = toast.id.replace("gd-toast-", "");
            setTimeout(() => removeToast(jobId), 3000);
          }
          // Cleanup 'stuck' toasts (no update for 15 seconds)
          else if (timeSinceUpdate > 15000 && !toast.dataset.grdExpiring) {
            const jobId = toast.id.replace("gd-toast-", "");
            removeToast(jobId);
          }
        });
    }
  });

  observer.observe(document.body, { childList: true, subtree: true });

  document.addEventListener("turbo:load", handleRouteChange);
  document.addEventListener("turbo:render", handleRouteChange);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => {
    setupObserver();
    setupKeyboardShortcuts();
  });
} else {
  setupObserver();
  setupKeyboardShortcuts();
}

console.log("[GRD] GitHub Repository Downloader content script loaded");
