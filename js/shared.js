(function (root) {
  "use strict";

  function getRepoKey(repoInfo, token) {
    if (!repoInfo) return "";
    const owner = repoInfo.owner.toLowerCase();
    const repo = repoInfo.repo.toLowerCase();
    const ref = repoInfo.ref || "HEAD";
    const tokenHash = token ? token.slice(-8) : "public";
    return `${owner}/${repo}/${ref}:${tokenHash}`;
  }

  // Common GitHub pages that are not repository root or contents
  const NON_REPO_PAGES = new Set([
    "settings",
    "search",
    "marketplace",
    "explore",
    "notifications",
    "new",
    "organizations",
    "pulls",
    "issues",
    "codespaces",
    "features",
    "topics",
    "trending",
  ]);

  const DEFAULT_SETTINGS = {
    themeMode: "system",
    buttonColor: "#8b5cf6",
    popupBgColor: "#f6f8fa",
    buttonText: "Download Repository",
    buttonStyle: "default",
    buttonPosition: "separate",
    namingPolicy: "fullPath",
    githubToken: "",
    zipCompressionLevel: 0,
    maxCacheSize: 100,
  };

  /**
   * Parses a GitHub URL into owner, repo, ref, and path components.
   * Handles tree/blob markers and handles encoded characters.
   */
  function parseGitHubUrl(url) {
    try {
      const urlObj = new URL(url);
      if (
        urlObj.hostname !== "github.com" &&
        urlObj.hostname !== "www.github.com"
      )
        return null;

      const parts = decodeURIComponent(urlObj.pathname)
        .split("/")
        .filter(Boolean);
      if (parts.length < 2 || NON_REPO_PAGES.has(parts[0])) return null;

      const owner = parts[0];
      const repo = parts[1];
      const marker = parts[2] || "";
      let ref = "HEAD";
      let path = "";
      let kind = "repo";
      let isDirectory = true;
      let isFile = false;

      // Extract ref and path if we're inside a tree or blob
      if ((marker === "tree" || marker === "blob") && parts.length > 3) {
        kind = marker === "blob" ? "file" : "directory";
        isDirectory = marker === "tree";
        isFile = marker === "blob";

        const remainder = parts.slice(3);
        const resolved = splitRefAndPath(remainder);
        ref = resolved.ref;
        path = resolved.path;
      }

      return {
        owner,
        repo,
        ref,
        path,
        kind,
        isRepoRoot: path === "",
        isDirectory,
        isFile,
      };
    } catch (e) {
      return null;
    }
  }

  /**
   * Attempts to distinguish between branch names and file paths.
   * Prioritizes common branch names and handles slash-containing branches (e.g. feature/foo).
   */
  function splitRefAndPath(parts) {
    if (!parts.length) return { ref: "HEAD", path: "" };

    const commonRefs = [
      "main",
      "master",
      "develop",
      "development",
      "dev",
      "trunk",
    ];
    const commonMatch = commonRefs.find((candidate) => parts[0] === candidate);
    if (commonMatch)
      return { ref: commonMatch, path: parts.slice(1).join("/") };

    const slashBranchPrefixes = new Set([
      "feature",
      "bugfix",
      "hotfix",
      "release",
      "fix",
      "chore",
      "docs",
      "dependabot",
      "patch",
      "experimental",
      "refactor",
      "test",
      "build",
      "ci",
      "version",
    ]);
    if (parts.length > 2 && slashBranchPrefixes.has(parts[0])) {
      return {
        ref: parts.slice(0, 2).join("/"),
        path: parts.slice(2).join("/"),
      };
    }

    return { ref: parts[0], path: parts.slice(1).join("/") };
  }

  function sanitizeFilename(name) {
    return String(name || "download").replace(/[<>:"/\\|?*]/g, "_");
  }

  function formatBytes(bytes) {
    if (bytes === "Unknown") return "Unknown";
    if (typeof bytes !== "number" || !Number.isFinite(bytes)) return "-";
    if (bytes === 0) return "0 B";

    const units = ["B", "KB", "MB", "GB", "TB"];
    let index = Math.min(
      Math.floor(Math.log(Math.abs(bytes)) / Math.log(1000)),
      units.length - 1,
    );
    let value = bytes / Math.pow(1000, index);
    let formatted = formatSignificant(value);

    // Roll up to next unit if rounding pushed it to 1000
    if (Math.abs(Number(formatted)) >= 1000 && index < units.length - 1) {
      index++;
      value = bytes / Math.pow(1000, index);
      formatted = formatSignificant(value);
    }
    return `${formatted} ${units[index]}`;
  }

  function formatSignificant(value) {
    if (Math.abs(value) < 1000 && Number.isInteger(value)) return String(value);
    return Number(value.toPrecision(3)).toString();
  }

  function generateZipFilename(repoInfo, namingPolicy) {
    const { owner, repo, ref, path } = repoInfo;

    let base;
    if (namingPolicy === "simpleName") {
      const parts = path ? path.split("/") : [];
      base = parts.length > 0 ? parts[parts.length - 1] : repo;
    } else {
      const cleanPath = path ? `_${path.replace(/\//g, "_")}` : "";
      base = `${owner}_${repo}${cleanPath}`;
    }

    const branchSuffix =
      ref && ref !== "HEAD" && ref !== "main" && ref !== "master"
        ? `_${ref}`
        : "";
    const finalName = `${base}${branchSuffix}.zip`;
    return sanitizeFilename(finalName || "github-smart-downloader.zip");
  }

  function getSelectableGitHubItem(currentUrl, itemHref, name) {
    const current = parseGitHubUrl(currentUrl);
    const item = parseGitHubUrl(new URL(itemHref, currentUrl).href);

    if (!current || !item) return null;
    if (current.owner !== item.owner || current.repo !== item.repo) return null;
    if (!item.path || (!item.isDirectory && !item.isFile)) return null;

    return {
      name: String(name || item.path.split("/").pop() || "").trim(),
      path: item.path,
      type: item.isDirectory ? "dir" : "file",
      href: new URL(itemHref, currentUrl).href,
    };
  }

  function buildArchiveUrl(repoInfo) {
    return `https://github.com/${repoInfo.owner}/${repoInfo.repo}/archive/${repoInfo.ref || "HEAD"}.zip`;
  }

  function buildRawUrl(repoInfo, path) {
    const ref = repoInfo.ref && repoInfo.ref !== "HEAD" ? repoInfo.ref : "main";
    const encodedPath = path.split("/").map(encodeURIComponent).join("/");
    return `https://raw.githubusercontent.com/${repoInfo.owner}/${repoInfo.repo}/${ref}/${encodedPath}`;
  }

  function dedupeFilesByPath(files) {
    const seen = new Set();
    return files.filter((file) => {
      const isDuplicate = seen.has(file.path);
      seen.add(file.path);
      return !isDuplicate;
    });
  }

  function getZipSizeEstimate(files) {
    return files.reduce(
      (total, file) =>
        total +
        (typeof file.size === "number" && Number.isFinite(file.size)
          ? file.size
          : 0),
      0,
    );
  }

  function parseRateLimitHeaders(headers) {
    const limit = toInteger(headers.get("x-ratelimit-limit"));
    const remaining = toInteger(headers.get("x-ratelimit-remaining"));
    const resetSeconds = toInteger(headers.get("x-ratelimit-reset"));
    const retryAfter = toInteger(headers.get("retry-after"));

    return {
      limit,
      remaining,
      reset: resetSeconds ? resetSeconds * 1000 : 0,
      retryAfter,
    };
  }

  function getRateLimitPercent(rateLimit) {
    const limit = Number(rateLimit?.limit);
    const remaining = Number(rateLimit?.remaining);
    if (!Number.isFinite(limit) || limit <= 0 || !Number.isFinite(remaining))
      return 0;
    return Math.max(0, Math.min(100, (remaining / limit) * 100));
  }

  function formatRateLimitReset(reset, now = Date.now()) {
    if (!reset) return "-";
    const timestamp = reset instanceof Date ? reset.getTime() : Number(reset);
    if (!Number.isFinite(timestamp)) return "-";
    const remainingMs = timestamp - now;
    if (remainingMs <= 0) return "now";
    const minutes = Math.ceil(remainingMs / 60000);
    if (minutes < 60) return `in ${minutes}m`;
    const hours = Math.floor(minutes / 60);
    const leftoverMinutes = minutes % 60;
    return leftoverMinutes
      ? `in ${hours}h ${leftoverMinutes}m`
      : `in ${hours}h`;
  }

  function toInteger(value) {
    if (value === null || value === undefined || value === "") return null;
    const parsed = parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : null;
  }

  function describeRateLimitWait(rateLimit, now) {
    const waitMs = rateLimit.retryAfter
      ? rateLimit.retryAfter * 1000
      : Math.max(0, (rateLimit.reset || 0) - now);
    if (!waitMs) return "Try again later.";
    const seconds = Math.ceil(waitMs / 1000);
    if (seconds < 60) return `Try again in ${seconds}s.`;
    return `Try again in ${Math.ceil(seconds / 60)}m.`;
  }

  function planDownloadStrategy(input) {
    const totalVisible = Math.max(0, input.totalVisible || 0);
    const selectedCount = Math.max(0, input.selectedCount || 0);
    const excludedCount = Math.max(
      0,
      input.excludedCount || Math.max(0, totalVisible - selectedCount),
    );
    const selectedDirs = Math.max(0, input.selectedDirs || 0);
    const selectedFiles = Math.max(0, input.selectedFiles || 0);
    const excludedTopLevelCount = Math.max(0, input.excludedTopLevelCount || 0);
    const selectedRatio = totalVisible ? selectedCount / totalVisible : 0;
    const apiRemaining = Number.isFinite(input.apiRemaining)
      ? input.apiRemaining
      : 60;
    const isRepoRoot = Boolean(input.isRepoRoot);
    const isSingleFile =
      selectedCount === 1 && selectedFiles === 1 && selectedDirs === 0;
    const compressionType = input.compressionType || "STORE";

    const candidates = [];

    // Strategy 1: Single Item (The most direct path)
    if (isSingleFile) {
      candidates.push({
        strategy: "singleItemZip",
        score: 100,
        reason: "direct file access",
      });
    }

    // Strategy 2: Full Repository Archive (Native GitHub redirect)
    if (isRepoRoot && totalVisible > 0 && selectedCount === totalVisible) {
      candidates.push({
        strategy: "fullArchive",
        score: 150,
        reason: "native repository redirect",
      });
    }

    // Strategy 3: filtered archive from the shared repo ZIP
    // Efficiency: High for dense selections, extremely high for cache hits
    if (isRepoRoot || input.hasCachedArchive || input.isArchivePending) {
      let archiveBaseScore = 220;

      // The "Instant" Bonus: If it's already in local memory/DB, it's king.
      if (input.hasCachedArchive) {
        archiveBaseScore -= 600;
      } else if (input.isArchivePending) {
        // Shared stream: join the team
        archiveBaseScore -= 200;
      }

      // High density selections favor archives
      if (selectedRatio > 0.3) {
        archiveBaseScore -= 50;
      }

      // Scale Penalty: Larger archives take more time to download/extract
      // 100MB+ archives start incurring significant penalties
      const repoSizeMb = input.totalRepoSizeKb
        ? input.totalRepoSizeKb / 1024
        : 0;
      const scalePenalty =
        repoSizeMb > 0
          ? Math.min(600, repoSizeMb * 0.8)
          : Math.min(300, totalVisible / 100);

      // Compression Penalty: Re-deflating a massive repo is slow compared to a sparse recursive scan
      const compressionPenalty =
        compressionType === "DEFLATE"
          ? repoSizeMb > 0
            ? Math.min(500, repoSizeMb * 0.5)
            : Math.min(400, totalVisible / 50)
          : 0;

      candidates.push({
        strategy: "filteredArchive",
        score: Math.round(
          archiveBaseScore +
            scalePenalty +
            compressionPenalty +
            excludedTopLevelCount * 10,
        ),
        reason: input.hasCachedArchive
          ? "instant surgical extraction"
          : input.isArchivePending
            ? "shared archive stream"
            : "filtered archive",
      });
    }

    // Strategy 4: Recursive API Scanning (Atomic downloads)
    // Cost: Latency per Directory + Transfer per File
    const recursiveLatencyMs = selectedDirs * 2500 + selectedFiles * 150;
    const apiQuotaPenalty = apiRemaining < selectedDirs * 3 ? 1500 : 0;
    const scaleBarrier = totalVisible > 10000 ? 1000 : 0;

    candidates.push({
      strategy: "selectedRecursiveZip",
      score: Math.round(
        350 + recursiveLatencyMs / 100 + apiQuotaPenalty + scaleBarrier,
      ),
      reason: "targeted recursive scan",
    });

    candidates.sort((a, b) => a.score - b.score);
    return { ...candidates[0], scores: candidates, selectedRatio };
  }

  async function fetchWithRetry(url, token, options = {}, maxRetries = 3) {
    const { signal, returnBlob = false } = options;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const headers = {
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        };
        if (token) headers["Authorization"] = `token ${token}`;

        const response = await fetch(url, { headers, signal });

        const rateLimit = parseRateLimitHeaders(response.headers);
        if (
          rateLimit.limit !== null &&
          typeof chrome !== "undefined" &&
          chrome.storage
        ) {
          chrome.storage.local.set({ rateLimit });
        }

        if (response.status === 429 || response.status === 403) {
          const isRateLimit =
            response.headers.get("x-ratelimit-remaining") === "0" ||
            response.status === 429;

          if (isRateLimit) {
            const waitTime =
              (parseInt(response.headers.get("retry-after")) ||
                Math.pow(2, attempt)) * 1000;

            if (waitTime > 15000) {
              throw new Error(
                `Rate limit exceeded. Try again in ${Math.ceil(waitTime / 1000)}s or use a GitHub Token.`,
              );
            }

            if (attempt < maxRetries) {
              await new Promise((r) => setTimeout(r, waitTime));
              continue;
            }
          }
        }

        if (response.status === 401) throw new Error("Invalid GitHub Token");
        if (response.status === 404) throw new Error("Repository not found");

        if (!response.ok) throw new Error(`HTTP Error ${response.status}`);

        return returnBlob ? await response.blob() : response;
      } catch (error) {
        if (attempt === maxRetries || error.name === "AbortError") throw error;

        // Don't retry on certain errors
        if (
          error.message.includes("Invalid GitHub Token") ||
          error.message.includes("not found") ||
          error.message.includes("Rate limit")
        ) {
          throw error;
        }

        // Exponential backoff for network/transient errors
        await new Promise((r) => setTimeout(r, Math.pow(2, attempt) * 1000));
      }
    }
  }

  const api = {
    DEFAULT_SETTINGS,
    buildArchiveUrl,
    describeRateLimitWait,
    formatBytes,
    formatRateLimitReset,
    generateZipFilename,
    getRateLimitPercent,
    getSelectableGitHubItem,
    getZipSizeEstimate,
    parseGitHubUrl,
    parseRateLimitHeaders,
    planDownloadStrategy,
    sanitizeFilename,
    buildRawUrl,
    dedupeFilesByPath,
    getRepoKey,
    fetchWithRetry,
  };

  root.GitHubSmartDownloaderShared = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
