// Extension popup logic - Handles job monitoring and quick-actions.
(function () {
  "use strict";

  document.addEventListener("DOMContentLoaded", init);

  function init() {
    const repoOwner = document.getElementById("repoOwner");
    const repoName = document.getElementById("repoName");
    const downloadBtn = document.getElementById("downloadBtn");
    const settingsBtn = document.getElementById("settingsBtn");
    const copyUrlBtn = document.getElementById("copyUrlBtn");
    const copyBtnText = document.getElementById("copyBtnText");
    const context = document.getElementById("context");
    const jobsList = document.getElementById("jobsList");
    const popupRateCount = document.getElementById("popupRateCount");
    const popupRateReset = document.getElementById("popupRateReset");
    const popupRateBar = document.getElementById("popupRateBar");
    const popupRefreshRateBtn = document.getElementById("popupRefreshRateBtn");

    let currentTabUrl = "";
    let activeJobId = null;

    chrome.storage.sync.get(
      { themeMode: "system", buttonColor: "#8b5cf6" },
      (settings) => {
        applyPopupTheme(settings.themeMode);
        document.documentElement.style.setProperty(
          "--gd-accent",
          settings.buttonColor || "#8b5cf6",
        );
      },
    );

    settingsBtn.addEventListener("click", () => {
      chrome.runtime.openOptionsPage();
    });

    if (popupRefreshRateBtn) {
      popupRefreshRateBtn.addEventListener("click", () => refreshRateLimit());
    }

    copyUrlBtn.addEventListener("click", async () => {
      if (!currentTabUrl) return;
      try {
        await navigator.clipboard.writeText(currentTabUrl);
        copyBtnText.textContent = "Copied!";
        setTimeout(() => (copyBtnText.textContent = "Copy Repo URL"), 1500);
      } catch (e) {
        copyBtnText.textContent = "Failed to copy";
        setTimeout(() => (copyBtnText.textContent = "Copy Repo URL"), 1500);
      }
    });

    loadRateLimit();

    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs[0];
      if (!tab || !tab.url || !tab.url.includes("github.com")) {
        disableMainUI("Navigate to a GitHub repository", "Not on GitHub");
        return;
      }

      currentTabUrl = tab.url;
      const info = parseUrl(tab.url);
      if (!info) {
        disableMainUI("Open a repository page", "Invalid page");
        return;
      }

      repoOwner.textContent = info.owner;
      repoName.textContent = info.repo;

      if (info.path) {
        context.textContent = "Directory: /" + info.path;
        downloadBtn.innerHTML = `
          <svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor">
            <path d="M1.75 1A1.75 1.75 0 0 0 0 2.75v10.5C0 14.216.784 15 1.75 15h12.5A1.75 1.75 0 0 0 16 13.25v-8.5A1.75 1.75 0 0 0 14.25 3H7.5a.25.25 0 0 1-.2-.1l-.9-1.2c-.33-.44-.85-.7-1.4-.7H1.75Z"></path>
          </svg>
          Download Directory
        `;
      } else {
        context.textContent = "Full Repository";
      }

      downloadBtn.addEventListener("click", () => {
        downloadBtn.disabled = true;
        chrome.runtime.sendMessage(
          { action: "startDownload", url: tab.url },
          (response) => {
            if (response && response.jobId) activeJobId = response.jobId;
            updateJobsList();
            setTimeout(() => {
              if (downloadBtn) downloadBtn.disabled = false;
            }, 2000);
          },
        );
      });
    });

    setInterval(updateJobsList, 1000);
    updateJobsList();

    function updateJobsList() {
      chrome.runtime.sendMessage({ action: "getAllJobs" }, (response) => {
        if (!response || !response.success || !response.jobs) return;
        renderJobs(response.jobs);
      });
    }

    function renderJobs(jobs) {
      if (jobs.length === 0) {
        jobsList.innerHTML = '<div class="no-jobs">No active downloads</div>';
        return;
      }

      // Sort by creation time (implicitly by ID if ID is job-timestamp)
      const sortedJobs = jobs.sort((a, b) => b.id.localeCompare(a.id));

      jobsList.innerHTML = sortedJobs
        .map((job) => {
          const state = job.state || {};
          const progress = state.progress || 0;
          const name =
            job.filename ||
            (job.repoInfo
              ? `${job.repoInfo.owner}/${job.repoInfo.repo}`
              : "Repository Archive");
          const statusMsg = state.message || "Processing...";
          const metaMsg = getSizeMeta(state);

          return `
          <div class="job-card" id="job-${job.id}">
            <div class="job-top">
              <div class="job-main">
                <span class="job-title" title="${name}">${name}</span>
                <div class="job-msg">${statusMsg}</div>
              </div>
              ${
                state.status !== "idle" &&
                state.status !== "complete" &&
                state.status !== "error"
                  ? `<button class="job-cancel-btn" data-id="${job.id}">Cancel</button>`
                  : ""
              }
            </div>
            <div class="job-progress-container">
              <div class="job-progress-fill" style="width: ${progress}%"></div>
            </div>
            <div class="job-meta">
              <span>${progress}%</span>
              <span>${metaMsg}</span>
            </div>
          </div>
        `;
        })
        .join("");

      jobsList.querySelectorAll(".job-cancel-btn").forEach((btn) => {
        btn.onclick = () => {
          const jobId = btn.dataset.id;
          btn.disabled = true;
          btn.textContent = "...";
          chrome.runtime.sendMessage(
            { action: "cancelDownload", jobId },
            () => {
              updateJobsList();
            },
          );
        };
      });
    }

    function disableMainUI(msg, name) {
      repoOwner.textContent = "-";
      repoName.textContent = name;
      if (downloadBtn) downloadBtn.disabled = true;
      if (copyUrlBtn) copyUrlBtn.disabled = true;
      context.textContent = msg;
    }

    function parseUrl(url) {
      return window.GitDownerShared?.parseGitHubUrl(url) || null;
    }

    function applyPopupTheme(themeMode) {
      if (themeMode === "light" || themeMode === "dark") {
        document.documentElement.dataset.theme = themeMode;
      } else {
        delete document.documentElement.dataset.theme;
      }
    }

    function getSizeMeta(details) {
      const downloaded = Number(details.bytesDownloaded) || 0;
      const estimated = Number(details.estimatedBytes) || 0;
      if (downloaded > 0 && estimated > 0)
        return `${formatBytes(downloaded)} / ${formatBytes(estimated)}`;
      if (downloaded > 0) return `Downloaded: ${formatBytes(downloaded)}`;
      if (estimated > 0) return `~${formatBytes(estimated)}`;
      return "";
    }

    function formatBytes(bytes) {
      return window.GitDownerShared?.formatBytes(bytes) || "";
    }

    function loadRateLimit() {
      chrome.storage.local.get({ rateLimit: null }, (result) => {
        renderRateLimit(
          result.rateLimit || { limit: 60, remaining: 60, reset: 0 },
        );
        refreshRateLimit({ silent: true });
      });
    }

    function refreshRateLimit(options = {}) {
      if (!popupRefreshRateBtn) return;
      popupRefreshRateBtn.disabled = true;
      chrome.runtime.sendMessage({ action: "refreshRateLimit" }, (response) => {
        popupRefreshRateBtn.disabled = false;
        if (response?.success) renderRateLimit(response.rateLimit);
      });
    }

    function renderRateLimit(rateLimit) {
      if (!popupRateCount || !popupRateReset || !popupRateBar) return;
      const data = rateLimit || { limit: 60, remaining: 60, reset: 0 };
      const percent = window.GitDownerShared?.getRateLimitPercent(data) || 0;

      popupRateCount.textContent = `${data.remaining}/${data.limit}`;
      if (data.tokenError) {
        popupRateReset.textContent = data.tokenError;
        popupRateReset.style.color = "var(--gd-danger)";
      } else if (data.hasToken && data.tokenValid) {
        popupRateReset.textContent = `Token valid • resets ${window.GitDownerShared?.formatRateLimitReset(data.reset)}`;
        popupRateReset.style.color = "var(--gd-success)";
      } else {
        popupRateReset.textContent = data.reset
          ? `resets ${window.GitDownerShared?.formatRateLimitReset(data.reset)}`
          : "standard limit";
        popupRateReset.style.color = "";
      }

      popupRateBar.style.width = `${percent}%`;
      popupRateBar.style.background =
        percent < 20
          ? "var(--gd-danger)"
          : percent < 50
            ? "#bf8700"
            : "var(--gd-accent)";
    }
  }
})();
