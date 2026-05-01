const {
  parseRateLimitHeaders,
  buildRawUrl,
  dedupeFilesByPath,
  fetchWithRetry,
} = GitDownerShared;

const CONFIG = {
  BASE_API_URL: "https://api.github.com/repos",
  DEFAULT_CONCURRENCY: 25,
};

const activeOffscreenJobs = new Map();

// IndexedDB interface for persisting repository archives across background suspension cycles
const ArchiveDB = {
  DB_NAME: "GitDownerArchives",
  STORE_NAME: "archives",
  VERSION: 1,

  async getDB() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.DB_NAME, this.VERSION);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);
      request.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(this.STORE_NAME)) {
          db.createObjectStore(this.STORE_NAME, { keyPath: "repoKey" });
        }
      };
    });
  },

  async save(repoKey, buffer, sha) {
    const db = await this.getDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(this.STORE_NAME, "readwrite");
      const store = tx.objectStore(this.STORE_NAME);
      store.put({ repoKey, buffer, sha, timestamp: Date.now() });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  },

  async get(repoKey) {
    const db = await this.getDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(this.STORE_NAME, "readonly");
      const store = tx.objectStore(this.STORE_NAME);
      const request = store.get(repoKey);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  },

  async delete(repoKey) {
    const db = await this.getDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(this.STORE_NAME, "readwrite");
      const store = tx.objectStore(this.STORE_NAME);
      store.delete(repoKey);
      tx.oncomplete = () => resolve();
    });
  },

  async clearExpired(ttl) {
    const db = await this.getDB();
    const now = Date.now();
    const tx = db.transaction(this.STORE_NAME, "readwrite");
    const store = tx.objectStore(this.STORE_NAME);
    const request = store.openCursor();
    request.onsuccess = (e) => {
      const cursor = e.target.result;
      if (cursor) {
        if (now - cursor.value.timestamp > ttl) {
          cursor.delete();
        }
        cursor.continue();
      }
    };
  },
};

// Shared Archive Pooling: Prevents redundant downloads of the same repo archive
// during concurrent filtered downloads.
const sharedArchivePool = {
  promises: new Map(), // repoKey -> Promise<Uint8Array>
  cache: new Map(), // repoKey -> { buffer, refCount, expiryTimer }
  waiters: new Map(), // repoKey -> Set<jobId>
  enumeratePromises: new Map(), // repoKey:path -> Promise<Array>
};

function getRepoKey(repoInfo, token) {
  const base = `${repoInfo.owner}/${repoInfo.repo}/${repoInfo.ref || "HEAD"}`;
  const tokenHash = token ? token.slice(-8) : "public";
  return `${base}:${tokenHash}`;
}

function updateBackgroundCacheState(repoKey, state, sha = null) {
  chrome.runtime.sendMessage({
    action: "updateCacheState",
    repoKey,
    state,
    sha,
  });
}

// Global Orchestrator handles deduplication of individual file downloads across all active jobs
const GlobalOrchestrator = {
  downloads: new Map(),
  queue: [],
  activeWorkerCount: 0,
  MAX_CONCURRENCY: CONFIG.DEFAULT_CONCURRENCY,

  getFileKey(repoInfo, path, token) {
    return `${getRepoKey(repoInfo, token)}:${path}`;
  },

  async requestFile(file, repoInfo, token, jobId, signal) {
    const key = this.getFileKey(repoInfo, file.path, token);

    // Join existing download if already in flight
    if (this.downloads.has(key)) {
      const entry = this.downloads.get(key);
      entry.refCount++;
      entry.jobIds.add(jobId);
      try {
        return await entry.promise;
      } finally {
        this.releaseFile(key, jobId);
      }
    }

    const entry = {
      refCount: 1,
      status: "queued",
      promise: null,
      jobIds: new Set([jobId]),
    };

    entry.promise = new Promise((resolve, reject) => {
      const sharedController = new AbortController();
      entry.controller = sharedController;
      this.queue.push({
        file,
        token,
        jobId,
        resolve,
        reject,
        key,
        signal: sharedController.signal,
      });
      this.processQueue();
    });

    this.downloads.set(key, entry);
    try {
      return await entry.promise;
    } finally {
      this.releaseFile(key);
    }
  },

  releaseFile(key, jobId) {
    const entry = this.downloads.get(key);
    if (!entry) return;
    entry.refCount--;
    if (jobId) entry.jobIds.delete(jobId);

    // Abort network request if no jobs are left interested
    if (entry.refCount <= 0 && entry.controller) {
      entry.controller.abort();
    }

    if (entry.refCount <= 0) {
      setTimeout(() => {
        if (entry.refCount <= 0) this.downloads.delete(key);
      }, 30000);
    }
  },

  async processQueue() {
    if (
      this.activeWorkerCount >= this.MAX_CONCURRENCY ||
      this.queue.length === 0
    )
      return;
    this.activeWorkerCount++;
    const task = this.queue.shift();

    try {
      if (task.signal.aborted) {
        task.reject(new DOMException("Aborted", "AbortError"));
      } else {
        const blob = await fetchWithRetry(task.file.download_url, task.token, {
          signal: task.signal,
          returnBlob: true,
        });
        task.resolve(blob);
      }
    } catch (err) {
      task.reject(err);
    } finally {
      this.activeWorkerCount--;
      this.processQueue();
    }
  },
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "ping") {
    sendResponse({ success: true, ready: true });
    return false;
  }
  if (message.action === "offscreenCancel") {
    const controller = activeOffscreenJobs.get(message.jobId);
    if (controller) {
      controller.abort();
      activeOffscreenJobs.delete(message.jobId);
    }
    sendResponse({ success: true });
    return false;
  }
  if (message.action === "offscreenEvict") {
    const { repoKey } = message;
    if (sharedArchivePool.cache.has(repoKey)) {
      const entry = sharedArchivePool.cache.get(repoKey);
      if (entry.expiryTimer) clearTimeout(entry.expiryTimer);
      sharedArchivePool.cache.delete(repoKey);
      console.log(`[Offscreen] Remotely evicted stale archive for ${repoKey}`);
    }
    sendResponse({ success: true });
    return false;
  }
  if (message.action === "generateZipAndDownload") {
    const signal =
      message.signal || activeOffscreenJobs.get(message.jobId)?.signal;
    const token = message.token;
    const maxMemoryLimit = message.maxCacheSize
      ? message.maxCacheSize * 1024 * 1024 * 2.5
      : 250 * 1024 * 1024;

    handleGenerateZip(message, signal, token, maxMemoryLimit)
      .then(() => sendResponse({ success: true }))
      .catch((error) => {
        if (error.name === "AbortError") {
          console.log(`[Offscreen] Job ${message.jobId} cancelled`);
          sendResponse({ success: false, error: "Cancelled" });
        } else {
          console.error("[Offscreen] Unexpected Error:", error);
          sendResponse({ success: false, error: error.message });
        }
      });
    return true;
  }
});

async function handleGenerateZip(
  message,
  signalFromMessage,
  tokenFromMessage,
  maxMemoryLimit,
) {
  const {
    files: initialFiles,
    repoInfo,
    basePath,
    filename,
    compressionType,
    token: tokenFromMsg,
    jobId,
    mode,
    items,
  } = message;
  const token = tokenFromMessage || tokenFromMsg;
  const zip = new JSZip();
  let filesToDownload = initialFiles || [];
  let totalFilesCount = 0;

  const controller = new AbortController();
  activeOffscreenJobs.set(jobId, controller);
  const signal = signalFromMessage || controller.signal;

  try {
    if (mode === "scan_and_download" && repoInfo) {
      chrome.runtime.sendMessage({
        action: "offscreenProgress",
        jobId,
        status: "enumerating",
        message: "Scanning repository...",
        progress: 10,
      });
      filesToDownload = await enumerateFiles(
        repoInfo,
        basePath,
        token,
        jobId,
        signal,
      );
    } else if (mode === "scan_and_download_items" && repoInfo && items) {
      chrome.runtime.sendMessage({
        action: "offscreenProgress",
        jobId,
        status: "enumerating",
        message: "Expanding selection...",
        progress: 10,
      });
      filesToDownload = await expandItems(
        repoInfo,
        items,
        token,
        jobId,
        signal,
      );
    } else if (mode === "filtered_archive" && repoInfo) {
      chrome.runtime.sendMessage({
        action: "offscreenProgress",
        jobId,
        status: "enumerating",
        message: "Filtering repository...",
        progress: 10,
      });
      filesToDownload = await filterRepository(
        repoInfo,
        message.excludedTopLevelPaths || [],
        token,
        jobId,
        signal,
      );
    } else if (mode === "filtered_archive_fast") {
      const repoKey = getRepoKey(repoInfo, token);
      let archiveBuffer;

      // Tiered Cache Lookup: RAM -> IndexedDB -> Network
      if (sharedArchivePool.cache.has(repoKey)) {
        const entry = sharedArchivePool.cache.get(repoKey);
        archiveBuffer = entry.buffer;
        if (entry.expiryTimer) clearTimeout(entry.expiryTimer);
        entry.expiryTimer = null;
        updateBackgroundCacheState(repoKey, "added", entry.sha);
      } else {
        try {
          const stored = await ArchiveDB.get(repoKey);
          if (stored && Date.now() - stored.timestamp < 600000) {
            console.log(
              `[Offscreen] Found ${repoKey} in IndexedDB. Restoring to memory.`,
            );
            archiveBuffer = stored.buffer;
            sharedArchivePool.cache.set(repoKey, {
              buffer: archiveBuffer,
              refCount: 0,
              expiryTimer: null,
              sha: stored.sha,
            });
            await ArchiveDB.save(repoKey, archiveBuffer, stored.sha); // Refresh timestamp
            updateBackgroundCacheState(repoKey, "added", stored.sha);
          }
        } catch (e) {
          console.warn("[Offscreen] IndexedDB access failed:", e);
        }
      }

      if (!archiveBuffer && sharedArchivePool.promises.has(repoKey)) {
        const waiters = sharedArchivePool.waiters.get(repoKey) || new Set();
        waiters.add(jobId);
        sharedArchivePool.waiters.set(repoKey, waiters);
        chrome.runtime.sendMessage({
          action: "offscreenProgress",
          jobId,
          status: "downloading",
          message: "Waiting for shared archive...",
          progress: 20,
        });
        archiveBuffer = await sharedArchivePool.promises.get(repoKey);
      } else if (!archiveBuffer) {
        const downloadPromise = (async () => {
          try {
            const archiveUrl =
              window.GitDownerShared?.buildArchiveUrl(repoInfo);
            if (!archiveUrl) throw new Error("Could not build archive URL");
            updateBackgroundCacheState(repoKey, "starting");
            chrome.runtime.sendMessage({
              action: "offscreenProgress",
              jobId,
              status: "downloading",
              message: "Downloading shared repository archive...",
              progress: 15,
            });

            const headers = {};
            if (token) headers["Authorization"] = `token ${token}`;
            const response = await fetch(archiveUrl, { headers });
            if (!response.ok)
              throw new Error(`GitHub Archive API error: ${response.status}`);

            const reader = response.body.getReader();
            const contentLength = +response.headers.get("Content-Length") || 0;
            let receivedLength = 0;
            const chunks = [];
            let lastReportedMB = -1;
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              chunks.push(value);
              receivedLength += value.length;
              const currentMB = Math.floor(receivedLength / (1024 * 1024));
              if (
                currentMB !== lastReportedMB ||
                receivedLength === contentLength
              ) {
                lastReportedMB = currentMB;
                const progress = contentLength
                  ? Math.floor((receivedLength / contentLength) * 40)
                  : 0;
                const currentWaiters =
                  sharedArchivePool.waiters.get(repoKey) || new Set();
                const allInterested = new Set([jobId, ...currentWaiters]);
                for (const id of allInterested) {
                  chrome.runtime.sendMessage({
                    action: "offscreenProgress",
                    jobId: id,
                    status: "downloading",
                    message: `Downloading shared archive (${currentMB}MB)...`,
                    progress: 15 + progress,
                  });
                }
              }
            }
            const buffer = new Uint8Array(receivedLength);
            let pos = 0;
            for (let chunk of chunks) {
              buffer.set(chunk, pos);
              pos += chunk.length;
            }
            return buffer;
          } catch (err) {
            sharedArchivePool.promises.delete(repoKey);
            throw err;
          }
        })();

        sharedArchivePool.promises.set(repoKey, downloadPromise);
        try {
          archiveBuffer = await downloadPromise;
          let extractedSha = null;
          try {
            const tempZip = await JSZip.loadAsync(archiveBuffer);
            const firstEntry = Object.keys(tempZip.files)[0];
            if (firstEntry)
              extractedSha = firstEntry.split("-").pop().replace(/\/$/, "");
          } catch (e) {}
          sharedArchivePool.cache.set(repoKey, {
            buffer: archiveBuffer,
            refCount: 0,
            expiryTimer: null,
            sha: extractedSha,
          });
          await ArchiveDB.save(repoKey, archiveBuffer, extractedSha);
          updateBackgroundCacheState(repoKey, "added", extractedSha);
        } finally {
          sharedArchivePool.promises.delete(repoKey);
        }
      }

      const cacheEntry = sharedArchivePool.cache.get(repoKey);
      if (cacheEntry) cacheEntry.refCount++;

      try {
        chrome.runtime.sendMessage({
          action: "offscreenProgress",
          jobId,
          status: "zipping",
          message: "Filtering shared archive...",
          progress: 60,
        });
        const archiveZip = await JSZip.loadAsync(archiveBuffer);
        const excluded = new Set(
          (message.excludedPaths || []).map((path) =>
            path.replace(/^\/+|\/+$/g, ""),
          ),
        );
        const included = message.includedPaths
          ? new Set(
              message.includedPaths.map((path) =>
                path.replace(/^\/+|\/+$/g, ""),
              ),
            )
          : null;

        let count = 0;
        archiveZip.forEach((relativePath) => {
          const withoutRoot = relativePath
            .split("/")
            .slice(1)
            .join("/")
            .replace(/\/$/g, "");
          if (!withoutRoot) return;
          if (included) {
            const isSelected = [...included].some(
              (p) => withoutRoot === p || withoutRoot.startsWith(p + "/"),
            );
            if (!isSelected) archiveZip.remove(relativePath);
            else count++;
          } else {
            const topLevel = withoutRoot.split("/")[0];
            if (topLevel && excluded.has(topLevel))
              archiveZip.remove(relativePath);
            else count++;
          }
        });
        zip.files = archiveZip.files;
        totalFilesCount = count;
      } finally {
        if (cacheEntry) {
          cacheEntry.refCount--;
          if (cacheEntry.refCount <= 0) {
            cacheEntry.expiryTimer = setTimeout(async () => {
              sharedArchivePool.cache.delete(repoKey);
              await ArchiveDB.delete(repoKey);
              updateBackgroundCacheState(repoKey, "removed");
            }, 600000); // 10 minute sliding TTL
          }
        }
      }
    }

    if (signal.aborted) throw new DOMException("Aborted", "AbortError");

    if (mode !== "filtered_archive_fast") {
      if (!filesToDownload || filesToDownload.length === 0)
        throw new Error("No files found.");
      const concurrency = CONFIG.DEFAULT_CONCURRENCY;
      let index = 0,
        completed = 0;
      const worker = async () => {
        while (index < filesToDownload.length && !signal.aborted) {
          const file = filesToDownload[index++];
          if (!file) continue;
          try {
            const blob = await GlobalOrchestrator.requestFile(
              file,
              repoInfo,
              token,
              jobId,
              signal,
            );
            zip.file(file.path, blob);
            completed++;
            if (completed % 5 === 0 || completed === filesToDownload.length) {
              chrome.runtime.sendMessage({
                action: "offscreenProgress",
                jobId: jobId,
                completed: completed,
                total: filesToDownload.length,
                currentFile: file.name,
              });
            }
          } catch (error) {
            if (error.name === "AbortError") throw error;
            completed++;
          }
        }
      };
      totalFilesCount = filesToDownload.length;
      if (initialFiles?.length) {
        initialFiles.forEach((file) => {
          if (file.isDir) zip.folder(file.path);
          else if (file.data) {
            zip.file(file.path, file.data);
            completed++;
          }
        });
        filesToDownload = filesToDownload.filter((f) => !f.data && !f.isDir);
      }
      if (filesToDownload.length > 0) {
        await Promise.all(
          Array.from(
            { length: Math.min(concurrency, filesToDownload.length) },
            () => worker(),
          ),
        );
      }
    }

    if (signal.aborted) throw new DOMException("Aborted", "AbortError");
    chrome.runtime.sendMessage({
      action: "offscreenProgress",
      jobId,
      status: "zipping",
      message: "Generating ZIP file...",
      progress: 95,
    });

    // Safety check for massive repositories based on user memory limit
    // Each file in JSZip roughly takes 1.5KB of metadata overhead in memory
    const estimatedMetadataSize = totalFilesCount * 1536;
    if (maxMemoryLimit && estimatedMetadataSize > maxMemoryLimit) {
      console.warn(
        `[Offscreen] Warning: ZIP structure (approx ${Math.round(estimatedMetadataSize / 1024 / 1024)}MB) approaches or exceeds user memory limit (${Math.round(maxMemoryLimit / 1024 / 1024)}MB).`,
      );
      if (totalFilesCount > 50000) {
        throw new Error(
          `Repository is too large for the current memory limit (${totalFilesCount} files). Please increase the Memory Limit in Advanced Settings.`,
        );
      }
    }

    const content = await zip.generateAsync({
      type: "blob",
      compression: message.compressionType || "STORE",
      compressionOptions:
        message.compressionType === "DEFLATE"
          ? { level: message.compressionLevel || 6 }
          : undefined,
    });

    if (signal.aborted) throw new DOMException("Aborted", "AbortError");
    const url = URL.createObjectURL(content);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();

    setTimeout(() => {
      if (document.body.contains(a)) document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 10000);
    chrome.runtime.sendMessage({
      action: "offscreenProgress",
      jobId: jobId,
      status: "complete",
      message: "Download ready!",
      progress: 100,
      size: content.size,
      count: totalFilesCount,
      repoInfo: repoInfo,
    });
  } finally {
    activeOffscreenJobs.delete(jobId);
  }
  return true;
}

async function filterRepository(repoInfo, excludedPaths, token, jobId, signal) {
  const allFiles = await enumerateFiles(repoInfo, "", token, jobId, signal);
  const excluded = new Set(
    excludedPaths.map((p) => p.replace(/^\/+|\/+$/g, "")),
  );
  return allFiles.filter((file) => !excluded.has(file.path.split("/")[0]));
}

async function expandItems(repoInfo, items, token, jobId, signal) {
  const allFiles = [];
  for (const item of items) {
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");
    if (item.type === "file") {
      allFiles.push({
        name: item.name,
        path: item.path,
        download_url: item.download_url || buildRawUrl(repoInfo, item.path),
      });
    } else if (item.type === "dir") {
      const dirFiles = await enumerateFiles(
        repoInfo,
        item.path,
        token,
        jobId,
        signal,
      );
      allFiles.push(...dirFiles);
    }
  }
  return dedupeFilesByPath(allFiles);
}

async function enumerateFiles(repoInfo, dirPath, token, jobId, signal) {
  if (repoInfo.isFile) {
    return [
      {
        name: repoInfo.path.split("/").pop(),
        path: repoInfo.path,
        download_url: buildRawUrl(repoInfo, repoInfo.path),
      },
    ];
  }
  const repoKey = getRepoKey(repoInfo, token);
  const scanKey = `${repoKey}:${dirPath || "root"}`;
  if (sharedArchivePool.enumeratePromises.has(scanKey))
    return await sharedArchivePool.enumeratePromises.get(scanKey);

  const scanPromise = (async () => {
    try {
      const treeRef = repoInfo.ref || "HEAD";
      const url = `${CONFIG.BASE_API_URL}/${repoInfo.owner}/${repoInfo.repo}/git/trees/${treeRef}?recursive=1`;
      const headers = {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      };
      if (token) headers["Authorization"] = `token ${token}`;
      const response = await fetch(url, { headers, signal });
      const data = await response.json();

      if (data.tree && !data.truncated) {
        const prefix = dirPath
          ? dirPath.endsWith("/")
            ? dirPath
            : dirPath + "/"
          : "";
        return data.tree
          .filter(
            (item) => item.type === "blob" && item.path.startsWith(prefix),
          )
          .map((item) => ({
            name: item.path.split("/").pop(),
            path: item.path,
            download_url: buildRawUrl(repoInfo, item.path),
          }));
      }
    } catch (error) {
      if (error.name === "AbortError") throw error;
    }
    return await sequentialScan(repoInfo, dirPath, token, jobId, signal);
  })();

  sharedArchivePool.enumeratePromises.set(scanKey, scanPromise);
  try {
    return await scanPromise;
  } finally {
    setTimeout(
      () => sharedArchivePool.enumeratePromises.delete(scanKey),
      120000,
    );
  }
}

async function sequentialScan(repoInfo, dirPath, token, jobId, signal) {
  const files = [];
  const queue = [dirPath];
  let dirsProcessed = 0;
  while (queue.length > 0) {
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");
    const currentPath = queue.shift();
    try {
      const url = `${CONFIG.BASE_API_URL}/${repoInfo.owner}/${repoInfo.repo}/contents/${currentPath || ""}?ref=${repoInfo.ref || "HEAD"}`;
      const headers = {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      };
      if (token) headers["Authorization"] = `token ${token}`;
      const response = await fetch(url, { headers, signal });
      const contents = await response.json();
      for (const item of contents) {
        if (item.type === "file")
          files.push({
            name: item.name,
            path: item.path,
            download_url: item.download_url || buildRawUrl(repoInfo, item.path),
          });
        else if (item.type === "dir") queue.push(item.path);
      }
      if (++dirsProcessed % 5 === 0)
        chrome.runtime.sendMessage({
          action: "offscreenProgress",
          jobId,
          status: "enumerating",
          message: `Found ${files.length} files...`,
          progress: 15,
        });
    } catch (e) {
      if (e.name === "AbortError") throw e;
    }
  }
  return files;
}
