try {
  importScripts("shared.js");
  importScripts("../lib/jszip.min.js");
} catch (e) {
  console.error("[GSD] Dependency load failure:", e);
}

const {
  DEFAULT_SETTINGS,
  buildArchiveUrl,
  describeRateLimitWait,
  formatBytes,
  generateZipFilename,
  getZipSizeEstimate,
  parseGitHubUrl,
  parseRateLimitHeaders,
  sanitizeFilename,
  buildRawUrl,
  getRepoKey,
  fetchWithRetry,
} = GitHubSmartDownloaderShared;

const downloadJobs = new Map();
const activeToasts = new Map();
const deadJobIds = new Set();
const hotArchives = new Map();
const pendingArchives = new Set();
let latestJobId = null;
let latestJobSnapshot = null;
const directoryCache = new Map();

const CONFIG = {
  COMPRESSION_TYPE: "STORE",
  BASE_API_URL: "https://api.github.com/repos",
  DEFAULT_CONCURRENCY: 25,
  RATE_LIMIT_DELAY: 1000,
  RATE_LIMIT_ABORT_THRESHOLD_MS: 30000,
  CACHE_TTL: 600000, // 10 minutes
  MAX_CACHE_MEMORY_BYTES: 100 * 1024 * 1024,
  MAX_MEMORY_ZIP_SIZE: 250 * 1024 * 1024,
};

let currentCacheMemoryUsage = 0;

function refreshConfigFromSettings() {
  chrome.storage.sync.get(DEFAULT_SETTINGS, (settings) => {
    if (settings.maxCacheSize) {
      CONFIG.MAX_CACHE_MEMORY_BYTES = settings.maxCacheSize * 1024 * 1024;
      CONFIG.MAX_MEMORY_ZIP_SIZE = settings.maxCacheSize * 2.5 * 1024 * 1024;
      console.log(
        `[GSD] Memory Limits Updated: Cache=${settings.maxCacheSize}MB, ZIP=${Math.round(settings.maxCacheSize * 2.5)}MB`,
      );
    }
  });
}

refreshConfigFromSettings();
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "sync" && changes.maxCacheSize) {
    refreshConfigFromSettings();
  }
});

// Restore "Hot Archives" metadata to survive Service Worker suspension
chrome.storage.local.get(["hotArchivesMetadata"], (result) => {
  if (result.hotArchivesMetadata) {
    const now = Date.now();
    for (const [key, data] of Object.entries(result.hotArchivesMetadata)) {
      if (now - data.timestamp < 600000) {
        hotArchives.set(key, data);
      }
    }
    console.log(
      `[GSD] Restored ${hotArchives.size} archives from persistent metadata.`,
    );
  }
});

function saveHotArchivesMetadata() {
  const metadata = Object.fromEntries(hotArchives);
  chrome.storage.local.set({ hotArchivesMetadata: metadata });
}

function loadJSZip() {
  if (typeof JSZip === "undefined") throw new Error("JSZip library not loaded");
  return JSZip;
}

function createDownloadJob(source, tabId = null, jobId = null) {
  if (jobId && downloadJobs.has(jobId)) {
    const existing = downloadJobs.get(jobId);
    existing.source = source;
    existing.tabId = tabId || existing.tabId;
    return existing;
  }

  const job = {
    id: jobId || `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    source,
    tabId,
    controller: new AbortController(),
    state: {
      filesTotal: 0,
      filesCompleted: 0,
      filesFailed: 0,
      status: "starting",
      message: "Starting download...",
      progress: 0,
      estimatedBytes: 0,
      bytesDownloaded: 0,
      sizeBytes: 0,
    },
    filename: null,
  };

  job.repoInfo = null;
  downloadJobs.set(job.id, job);
  latestJobId = job.id;
  console.log(`[GSD] Job created: ${job.id} for Tab: ${tabId}`);
  return job;
}

function updateJobState(job, patch) {
  Object.assign(job.state, patch);
}

function finishDownloadJob(job) {
  latestJobSnapshot = { jobId: job.id, ...job.state };
  downloadJobs.delete(job.id);
}

function getLatestDownloadState() {
  if (latestJobId && downloadJobs.has(latestJobId)) {
    return { jobId: latestJobId, ...downloadJobs.get(latestJobId).state };
  }
  return (
    latestJobSnapshot || {
      jobId: latestJobId,
      filesTotal: 0,
      filesCompleted: 0,
      filesFailed: 0,
      status: "idle",
      message: "No active download",
      progress: 0,
    }
  );
}

const uiUpdateThrottle = new Map();
function throttledUpdateProgress(
  job,
  status,
  message,
  progress = 0,
  details = {},
) {
  const now = Date.now();
  const lastUpdate = uiUpdateThrottle.get(job.id) || 0;

  // Throttle to 200ms unless it's a status change or completion
  if (
    now - lastUpdate > 200 ||
    status !== job.state.status ||
    progress === 100
  ) {
    uiUpdateThrottle.set(job.id, now);
    updateProgress(job, status, message, progress, details);
  }
}

function updateProgress(job, status, message, progress = 0, details = {}) {
  try {
    const patch = { status, message, progress };
    if (Object.prototype.hasOwnProperty.call(details, "estimatedBytes"))
      patch.estimatedBytes = details.estimatedBytes;
    if (Object.prototype.hasOwnProperty.call(details, "sizeBytes"))
      patch.sizeBytes = details.sizeBytes;
    if (Object.prototype.hasOwnProperty.call(details, "bytesDownloaded"))
      patch.bytesDownloaded = details.bytesDownloaded;
    if (Object.prototype.hasOwnProperty.call(details, "filesTotal"))
      patch.filesTotal = details.filesTotal;
    if (Object.prototype.hasOwnProperty.call(details, "filesCompleted"))
      patch.filesCompleted = details.filesCompleted;
    if (Object.prototype.hasOwnProperty.call(details, "filesFailed"))
      patch.filesFailed = details.filesFailed;
    if (Object.prototype.hasOwnProperty.call(details, "currentFile"))
      patch.currentFile = details.currentFile;
    updateJobState(job, patch);

    const payload = {
      action: "progressUpdate",
      jobId: job.id,
      status,
      message,
      progress,
      filename: job.filename,
      estimatedBytes: job.state.estimatedBytes,
      bytesDownloaded: job.state.bytesDownloaded,
      sizeBytes: job.state.sizeBytes,
      filesTotal: job.state.filesTotal,
      filesCompleted: job.state.filesCompleted,
      filesFailed: job.state.filesFailed,
      currentFile: job.state.currentFile,
    };

    console.log(
      `[GSD] Dispatching update for ${job.id} (Tab: ${job.tabId || "NONE"}):`,
      status,
      message,
    );
    chrome.runtime.sendMessage(payload).catch(() => {});

    if (job.tabId) {
      const { blob, ...uiDetails } = details;
      chrome.tabs
        .sendMessage(job.tabId, { ...payload, ...uiDetails })
        .catch((err) => {
          console.warn(
            `[GSD] Failed to send to tab ${job.tabId}:`,
            err.message,
          );
        });
    }
  } catch (error) {
    console.error("[GSD] Critical error in updateProgress:", error);
  }
}

async function triggerClientDownload(job, blob, filename) {
  if (job.tabId) {
    try {
      await chrome.tabs.sendMessage(job.tabId, {
        action: "triggerDownload",
        blob: blob,
        filename: filename,
      });
      return true;
    } catch (e) {
      console.warn("[GSD] Could not send to tab, falling back to data URL:", e);
    }
  }

  const dataUrl = await blobToDataUrl(blob);
  chrome.downloads.download({
    url: dataUrl,
    filename: filename,
    conflictAction: "uniquify",
  });
  return false;
}

let offscreenCreating = null;
async function ensureOffscreenDocument() {
  try {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ["OFFSCREEN_DOCUMENT"],
    });
    if (contexts.length > 0) return;
  } catch (e) {
    console.warn(
      "[GSD] getContexts failed, attempting to create offscreen document anyway.",
    );
  }

  if (offscreenCreating) {
    await offscreenCreating;
    return;
  }

  offscreenCreating = chrome.offscreen.createDocument({
    url: "html/offscreen.html",
    reasons: ["BLOBS"],
    justification:
      "Generate and download large ZIP files without freezing the background or UI threads.",
  });

  try {
    await offscreenCreating;

    // Handshake to ensure the offscreen script is fully loaded and listening
    let ready = false;
    for (let i = 0; i < 50; i++) {
      try {
        const ping = await chrome.runtime.sendMessage({ action: "ping" });
        if (ping?.ready) {
          ready = true;
          break;
        }
      } catch (e) {}
      await delay(100);
    }
    if (!ready) throw new Error("Offscreen engine failed to initialize");
  } finally {
    offscreenCreating = null;
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchLatestCommitSha(owner, repo, ref = "HEAD", token = null) {
  const url = `https://api.github.com/repos/${owner}/${repo}/commits/${ref}?per_page=1`;
  const response = await fetchWithRetry(url, token);
  const data = await response.json();
  return data.sha;
}

async function fetchRepositoryMetadata(owner, repo, token = null, job = null) {
  try {
    console.log(`[GSD] Fetching repository metadata for ${owner}/${repo}...`);
    const url = `https://api.github.com/repos/${owner}/${repo}`;
    const response = await fetchWithRetry(url, token, {
      signal: job?.controller?.signal,
    });
    const data = await response.json();
    console.log(
      `[GSD] Metadata resolved. Default branch: ${data.default_branch}, Size: ${data.size}KB`,
    );
    return {
      defaultBranch: data.default_branch || "main",
      size: data.size || 0,
    };
  } catch (error) {
    console.warn(
      `[GSD] Metadata fetch failed, falling back to defaults:`,
      error,
    );
    return { defaultBranch: "main", size: 0 };
  }
}

function updateStatistics(entry) {
  chrome.storage.local.get(
    { statistics: { totalDownloads: 0, totalBytes: 0, filesDownloaded: 0 } },
    (result) => {
      const stats = result.statistics;
      stats.totalDownloads++;
      stats.totalBytes += typeof entry.size === "number" ? entry.size : 0;
      stats.filesDownloaded +=
        typeof entry.count === "number" ? entry.count : 0;
      chrome.storage.local.set({ statistics: stats });
    },
  );
}

function addToHistory(entry) {
  chrome.storage.local.get({ downloadHistory: [] }, (result) => {
    const history = result.downloadHistory;
    history.unshift({
      id: Date.now(),
      date: new Date().toISOString(),
      ...entry,
    });

    if (history.length > 50) history.length = 50;
    chrome.storage.local.set({ downloadHistory: history });
    updateStatistics(entry);
  });
}

async function generateKey(passphrase) {
  const enc = new TextEncoder();
  // Fixed salt ensures deterministic key derivation from the unique machine UUID
  const fixedSalt = new Uint8Array([
    1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16,
  ]);

  const baseKey = await crypto.subtle.importKey(
    "raw",
    enc.encode(passphrase),
    { name: "PBKDF2" },
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: fixedSalt,
      iterations: 100000,
      hash: "SHA-256",
    },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

async function decryptToken(key, data) {
  const combined = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
  const iv = combined.slice(0, 12);
  const ciphertext = combined.slice(12);
  const dec = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv },
    key,
    ciphertext,
  );
  return new TextDecoder().decode(dec);
}

async function getEncryptionKey() {
  return new Promise((resolve) => {
    chrome.storage.local.get("tokenKeyMaterial", async (res) => {
      let material = res.tokenKeyMaterial;
      if (!material) {
        material = crypto.randomUUID();
        await chrome.storage.local.set({ tokenKeyMaterial: material });
      }
      const key = await generateKey(material);
      resolve(key);
    });
  });
}

async function decryptStoredTokenOrThrow(encryptedToken) {
  if (!encryptedToken) return "";
  try {
    const key = await getEncryptionKey();
    return await decryptToken(key, encryptedToken);
  } catch (error) {
    throw new Error(
      "GitHub token could not be decrypted. Re-enter it in Settings.",
    );
  }
}

async function refreshStoredRateLimit() {
  const settings = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  const encryptedToken = settings.githubToken || "";
  let token = "";
  let tokenValid = false;
  let tokenError = null;

  if (encryptedToken) {
    try {
      token = await decryptStoredTokenOrThrow(encryptedToken);
    } catch (e) {
      tokenError = "Token decryption failed";
    }
  }

  if (tokenError) {
    const rateLimit = {
      limit: 60,
      remaining: 0,
      reset: Date.now() + 3600000,
      tokenValid: false,
      tokenError,
      hasToken: true,
    };
    await chrome.storage.local.set({ rateLimit });
    throw new Error(tokenError);
  }

  const headers = {};
  if (token) headers.Authorization = `token ${token}`;

  try {
    const response = await fetch("https://api.github.com/rate_limit", {
      headers,
    });
    if (response.status === 401) {
      tokenValid = false;
      tokenError = "Invalid or expired GitHub token";
    } else if (response.ok) {
      tokenValid = !!token;
      tokenError = null;
    } else {
      tokenError = `GitHub returned ${response.status}`;
    }

    if (response.ok || response.status === 401 || response.status === 403) {
      const data = await response.json();
      const core = data.resources?.core || data.rate;

      if (core) {
        const rateLimit = {
          limit: core.limit,
          remaining: core.remaining,
          reset: core.reset * 1000,
          tokenValid,
          tokenError,
          hasToken: !!token,
        };
        await chrome.storage.local.set({ rateLimit });
        return rateLimit;
      }
    }
    throw new Error(tokenError || "Unexpected rate limit response");
  } catch (error) {
    const rateLimit = {
      limit: token ? 5000 : 60,
      remaining: 0,
      reset: Date.now() + 3600000,
      tokenValid: false,
      tokenError: error.message,
      hasToken: !!token,
    };
    await chrome.storage.local.set({ rateLimit });
    throw error;
  }
}

async function downloadDirectory(repoInfo, settings, job) {
  const token = settings.githubToken;
  const basePath = repoInfo.path;

  // Collaborative Optimization: Check if a shared archive is already available or downloading
  const repoKey = getRepoKey(repoInfo, token);
  if (hotArchives.has(repoKey) || pendingArchives.has(repoKey)) {
    console.log(`[GSD] Reusing archive cache for ${repoKey}.`);
    return await downloadFilteredRepository(repoInfo, settings, [], job, [
      basePath,
    ]);
  }

  await ensureOffscreenDocument();
  const filename = generateZipFilename(repoInfo, settings.namingPolicy);

  const response = await chrome.runtime.sendMessage({
    action: "generateZipAndDownload",
    repoInfo: repoInfo,
    basePath: basePath,
    filename: filename,
    compressionType: settings.zipCompressionLevel === 0 ? "STORE" : "DEFLATE",
    compressionLevel: settings.zipCompressionLevel,
    token: token,
    jobId: job.id,
    mode: "scan_and_download",
  });

  if (response && !response.success)
    throw new Error(response.error || "Offscreen processing failed");

  updateProgress(job, "complete", "Download complete!", 100);
  refreshStoredRateLimit().catch(() => {});

  return { success: true, jobId: job.id };
}

async function downloadFullRepository(repoInfo, settings, job) {
  console.log(
    `[GSD] Starting Full Repository download via Offscreen engine for cache population.`,
  );
  return await downloadFilteredRepository(repoInfo, settings, [], job);
}

async function downloadFilteredRepository(
  repoInfo,
  settings,
  excludedTopLevelPaths,
  job,
  includedPaths,
) {
  const token = settings.githubToken;
  await ensureOffscreenDocument();

  const filename =
    job.filename ||
    sanitizeFilename(`${repoInfo.owner}_${repoInfo.repo}_filtered.zip`);
  job.filename = filename;

  // Delegate entire process to Offscreen to keep large binary buffers in a single context
  await chrome.runtime.sendMessage({
    action: "generateZipAndDownload",
    excludedPaths: excludedTopLevelPaths,
    filename: filename,
    compressionType: settings.zipCompressionLevel === 0 ? "STORE" : "DEFLATE",
    compressionLevel: settings.zipCompressionLevel,
    jobId: job.id,
    repoInfo: repoInfo,
    token: token,
    includedPaths: includedPaths,
    mode: "filtered_archive_fast",
  });

  return { success: true, jobId: job.id };
}

async function estimateSelectionSize(repoInfo, items, token) {
  const selectedPaths = (items || [])
    .map((item) => String(item.path || "").replace(/^\/+|\/+$/g, ""))
    .filter(Boolean);

  if (!repoInfo || selectedPaths.length === 0) {
    return { estimatedBytes: 0, filesTotal: 0 };
  }

  let ref = repoInfo.ref || "HEAD";
  if (ref === "HEAD" || !repoInfo.ref) {
    const metadata = await fetchRepositoryMetadata(
      repoInfo.owner,
      repoInfo.repo,
      token,
    );
    ref = metadata.defaultBranch;
  }

  const headers = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (token) headers.Authorization = `token ${token}`;

  const url = `${CONFIG.BASE_API_URL}/${repoInfo.owner}/${repoInfo.repo}/git/trees/${ref}?recursive=1`;
  const response = await fetch(url, { headers });
  if (!response.ok) {
    throw new Error(`GitHub returned ${response.status}`);
  }

  const data = await response.json();
  const tree = Array.isArray(data.tree) ? data.tree : [];
  let estimatedBytes = 0;
  let filesTotal = 0;

  for (const entry of tree) {
    if (entry.type !== "blob" || !entry.path) continue;
    const isSelected = selectedPaths.some(
      (selectedPath) =>
        entry.path === selectedPath ||
        entry.path.startsWith(`${selectedPath}/`),
    );
    if (!isSelected) continue;
    filesTotal++;
    if (typeof entry.size === "number" && Number.isFinite(entry.size)) {
      estimatedBytes += entry.size;
    }
  }

  return {
    estimatedBytes,
    filesTotal,
    truncated: Boolean(data.truncated),
  };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const { action } = message;

  if (action === "offscreenProgress") {
    const {
      jobId,
      completed,
      total,
      status,
      message: msg,
      progress,
      estimatedBytes,
      bytesDownloaded,
      sizeBytes,
      filesCompleted,
      filesTotal,
      filesFailed,
      currentFile,
    } = message;
    const job = downloadJobs.get(jobId);
    if (job) {
      const detailPatch = Object.fromEntries(
        Object.entries({
          estimatedBytes,
          bytesDownloaded,
          sizeBytes,
          filesCompleted,
          filesTotal,
          filesFailed,
          currentFile,
        }).filter(([, value]) => value !== undefined),
      );
      if (status === "enumerating") {
        updateProgress(
          job,
          "enumerating",
          msg || "Scanning repository...",
          progress || 10,
          detailPatch,
        );
        return false;
      }
      if (status === "complete") {
        const size = message.size || job.state.sizeBytes || 0;
        const count = message.count || job.state.filesCompleted || "Unknown";
        const ri = message.repoInfo || job.repoInfo;
        updateProgress(job, "complete", msg || "Download complete!", 100, {
          sizeBytes: size,
          bytesDownloaded: size,
          filesCompleted: Number(count) || job.state.filesCompleted,
          filesTotal: Number(count) || job.state.filesTotal,
        });

        if (ri) {
          addToHistory({
            type: ri.path ? "folder" : "repo",
            name: ri.path
              ? `${ri.owner}/${ri.repo}/${ri.path}`
              : `${ri.owner}/${ri.repo}`,
            count: count,
            size: size,
          });
        }
        finishDownloadJob(job);
        return false;
      }
      if (status === "downloading" || status === "zipping") {
        updateProgress(
          job,
          status,
          msg || "Processing...",
          progress || 50,
          detailPatch,
        );
        return false;
      }

      if (completed !== undefined && total !== undefined) {
        const percent = 30 + Math.round((completed / total) * 65);
        throttledUpdateProgress(
          job,
          "downloading",
          `Downloading ${completed}/${total} files...`,
          percent,
          {
            filesCompleted: completed,
            filesTotal: total,
            currentFile,
            estimatedBytes,
          },
        );
        if (completed === total)
          updateProgress(job, "zipping", "Finalizing ZIP package...", 95, {
            filesCompleted: completed,
            filesTotal: total,
          });
      }
      return false;
    }
  }

  if (action === "updateCacheState") {
    const { repoKey, state, sha } = message;
    if (state === "added") {
      hotArchives.set(repoKey, { sha, timestamp: Date.now() });
      pendingArchives.delete(repoKey);
      saveHotArchivesMetadata();
    } else if (state === "removed") {
      hotArchives.delete(repoKey);
      pendingArchives.delete(repoKey);
      saveHotArchivesMetadata();
    } else if (state === "starting") {
      pendingArchives.add(repoKey);
    }
    return false;
  }

  if (action === "estimateSelection") {
    chrome.storage.sync.get(DEFAULT_SETTINGS, async (settings) => {
      try {
        const token = await decryptStoredTokenOrThrow(settings.githubToken);
        const estimate = await estimateSelectionSize(
          message.repoInfo,
          message.items,
          token,
        );
        sendResponse({ success: true, ...estimate });
      } catch (error) {
        sendResponse({ success: false, error: error.message });
      }
    });
    return true;
  }

  if (action === "planStrategy") {
    chrome.storage.sync.get(["githubToken"], async (settings) => {
      const { repoInfo, input, jobId } = message;
      const token = settings.githubToken;

      let tempJob = null;
      if (jobId) {
        tempJob = createDownloadJob("planStrategy", sender.tab?.id, jobId);
        updateProgress(tempJob, "starting", "Analyzing repository...", 2);
      }

      let ref = repoInfo.ref || "HEAD";
      let repoSize = 0;

      if (ref === "HEAD" || !repoInfo.ref) {
        if (tempJob)
          updateProgress(tempJob, "starting", "Resolving metadata...", 5);
        const metadata = await fetchRepositoryMetadata(
          repoInfo.owner,
          repoInfo.repo,
          token,
          tempJob,
        );
        ref = metadata.defaultBranch;
        repoSize = metadata.size;
        repoInfo.ref = ref;
      }

      const repoKey = getRepoKey(repoInfo, token);
      let hasCachedArchive = false;
      let isArchivePending = pendingArchives.has(repoKey);

      // Verify that the cached SHA is still current before approving a cache-hit strategy
      if (hotArchives.has(repoKey)) {
        if (tempJob)
          updateProgress(tempJob, "starting", "Checking cache validity...", 8);
        const cached = hotArchives.get(repoKey);
        try {
          const latestSha = await fetchLatestCommitSha(
            repoInfo.owner,
            repoInfo.repo,
            ref,
            token,
          );
          if (latestSha === cached.sha) {
            hasCachedArchive = true;
          } else {
            console.log(
              `[GSD] Cache invalidated for ${repoKey}: SHA mismatch (${cached.sha} vs ${latestSha})`,
            );
            hotArchives.delete(repoKey);
            chrome.runtime
              .sendMessage({ action: "offscreenEvict", repoKey })
              .catch(() => {});
          }
        } catch (e) {
          hasCachedArchive = false;
        }
      }

      const plan = GitHubSmartDownloaderShared.planDownloadStrategy({
        ...input,
        hasCachedArchive,
        isArchivePending,
        totalRepoSizeKb: repoSize,
        compressionType:
          settings.zipCompressionLevel === 0 ? "STORE" : "DEFLATE",
      });

      plan.resolvedRef = ref;
      plan.resolvedSize = repoSize;

      if (tempJob) {
        // Planning complete; job continues in next action
      }

      sendResponse(plan);
    });
    return true;
  }

  if (action === "getProgress") {
    sendResponse(getLatestDownloadState());
    return false;
  }

  if (action === "cancelDownload") {
    const jobId = message.jobId || latestJobId;
    const job = jobId ? downloadJobs.get(jobId) : null;
    if (job) {
      job.controller.abort();
      if (job.downloadId) chrome.downloads.cancel(job.downloadId);
      chrome.runtime
        .sendMessage({ action: "offscreenCancel", jobId: job.id })
        .catch(() => {});
      updateProgress(job, "idle", "Download cancelled", 0);
      setTimeout(() => finishDownloadJob(job), 3000);
    }
    sendResponse({ success: true });
    return false;
  }

  if (action === "getAllJobs") {
    const jobs = Array.from(downloadJobs.values()).map((job) => ({
      id: job.id,
      state: job.state,
      repoInfo: job.repoInfo,
      filename: job.filename,
    }));
    sendResponse({ success: true, jobs });
    return false;
  }

  if (action === "refreshRateLimit") {
    refreshStoredRateLimit()
      .then((rateLimit) => sendResponse({ success: true, rateLimit }))
      .catch((error) => sendResponse({ success: false, error: error.message }));
    return true;
  }

  if (action === "downloadFilteredRepository") {
    const { repoInfo, excludedTopLevelPaths, includedPaths, jobId } = message;
    chrome.storage.sync.get(DEFAULT_SETTINGS, async (settings) => {
      const job = createDownloadJob(
        "downloadFilteredRepository",
        sender.tab?.id,
        jobId,
      );
      try {
        settings.githubToken = await decryptStoredTokenOrThrow(
          settings.githubToken,
        );

        if (repoInfo.ref === "HEAD" || !repoInfo.ref) {
          updateProgress(job, "starting", "Resolving metadata...", 2);
          const metadata = await fetchRepositoryMetadata(
            repoInfo.owner,
            repoInfo.repo,
            settings.githubToken,
            job,
          );
          repoInfo.ref = metadata.defaultBranch;
          repoInfo.totalRepoSizeKb = metadata.size;
        }
        job.repoInfo = repoInfo;

        const result = await downloadFilteredRepository(
          repoInfo,
          settings,
          excludedTopLevelPaths,
          job,
          includedPaths,
        );
        // downloadFilteredRepository handles finishing the job or delegating it
        sendResponse(result);
      } catch (error) {
        updateProgress(job, "error", error.message, 0);
        finishDownloadJob(job);
        sendResponse({ success: false, error: error.message, jobId: job.id });
      }
    });
    return true;
  }

  if (action === "startDownload") {
    const { url } = message;
    const repoInfo = parseGitHubUrl(url);
    if (!repoInfo) {
      sendResponse({ success: false, error: "Invalid GitHub URL" });
      return false;
    }

    chrome.storage.sync.get(DEFAULT_SETTINGS, async (settings) => {
      const job = createDownloadJob(
        "startDownload",
        sender.tab?.id,
        message.jobId,
      );
      try {
        settings.githubToken = await decryptStoredTokenOrThrow(
          settings.githubToken,
        );
        const namingPolicy = settings.namingPolicy || "fullPath";
        job.filename = GitHubSmartDownloaderShared.generateZipFilename(
          repoInfo,
          namingPolicy,
        );

        if (repoInfo.ref === "HEAD" || !repoInfo.ref) {
          updateProgress(job, "starting", "Resolving metadata...", 2);
          const metadata = await fetchRepositoryMetadata(
            repoInfo.owner,
            repoInfo.repo,
            settings.githubToken,
            job,
          );
          repoInfo.ref = metadata.defaultBranch;
          repoInfo.totalRepoSizeKb = metadata.size;
        }
        job.repoInfo = repoInfo;

        let result;
        if (!repoInfo.path || repoInfo.path === "") {
          result = await downloadFullRepository(repoInfo, settings, job);
        } else {
          result = await downloadDirectory(repoInfo, settings, job);
        }
        finishDownloadJob(job);
        sendResponse({ ...result, jobId: job.id });
      } catch (error) {
        if (error.name === "AbortError" || job.controller.signal.aborted) {
          updateProgress(job, "idle", "Download cancelled", 0);
          finishDownloadJob(job);
          sendResponse({ success: false, error: "Cancelled", jobId: job.id });
          return;
        }
        console.error("[GSD] Download error:", error);
        const errorMsg =
          error.message ||
          (typeof error === "string" ? error : "Internal extension error");
        updateProgress(job, "error", errorMsg, 0);
        finishDownloadJob(job);
        sendResponse({ success: false, error: errorMsg, jobId: job.id });
      }
    });
    return true;
  }

  if (action === "downloadItems") {
    const { items, repoInfo } = message;
    chrome.storage.sync.get(DEFAULT_SETTINGS, async (settings) => {
      const job = createDownloadJob(
        "downloadItems",
        sender.tab?.id,
        message.jobId,
      );
      try {
        settings.githubToken = await decryptStoredTokenOrThrow(
          settings.githubToken,
        );
        if (repoInfo.ref === "HEAD" || !repoInfo.ref) {
          updateProgress(job, "starting", "Resolving metadata...", 2);
          const metadata = await fetchRepositoryMetadata(
            repoInfo.owner,
            repoInfo.repo,
            settings.githubToken,
            job,
          );
          repoInfo.ref = metadata.defaultBranch;
          repoInfo.totalRepoSizeKb = metadata.size;
        }
        job.repoInfo = repoInfo;
        updateProgress(
          job,
          "downloading",
          "Connecting to download engine...",
          10,
        );
        await ensureOffscreenDocument();

        const namingPolicy = settings.namingPolicy || "fullPath";
        let filename =
          items.length === 1 && items[0].type === "file"
            ? sanitizeFilename(`${items[0].name}.zip`)
            : GitHubSmartDownloaderShared.generateZipFilename(
                repoInfo,
                namingPolicy,
              );
        job.filename = filename;

        const repoKey = getRepoKey(repoInfo, settings.githubToken);
        if (hotArchives.has(repoKey) || pendingArchives.has(repoKey)) {
          const result = await downloadFilteredRepository(
            repoInfo,
            settings,
            [],
            job,
            items.map((i) => i.path),
          );
          finishDownloadJob(job);
          sendResponse({ ...result, jobId: job.id });
          return;
        }

        await chrome.runtime.sendMessage({
          action: "generateZipAndDownload",
          repoInfo: repoInfo,
          items: items.map((item) => ({
            type: item.type,
            path: item.path,
            name: item.name,
            download_url: item.download_url,
          })),
          filename: filename,
          compressionType:
            settings.zipCompressionLevel === 0 ? "STORE" : "DEFLATE",
          compressionLevel: settings.zipCompressionLevel,
          token: settings.githubToken,
          jobId: job.id,
          mode: "scan_and_download_items",
        });
        finishDownloadJob(job);
        sendResponse({ success: true, jobId: job.id });
      } catch (error) {
        updateProgress(job, "error", error.message, 0);
        finishDownloadJob(job);
        sendResponse({ success: false, error: error.message, jobId: job.id });
      }
    });
    return true;
  }
});
