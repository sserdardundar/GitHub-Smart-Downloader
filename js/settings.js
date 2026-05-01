// Options page logic - Manages user preferences and persistent state.
(function () {
  "use strict";

  const SHARED_DEFAULTS = window.GitDownerShared?.DEFAULT_SETTINGS || {
    themeMode: "system",
    buttonColor: "#8b5cf6",
    buttonText: "Download Repository",
    buttonStyle: "default",
    namingPolicy: "fullPath",
    githubToken: "",
  };

  document.addEventListener("DOMContentLoaded", init);

  function init() {
    const navBtns = document.querySelectorAll(".nav-btn");
    const tabs = document.querySelectorAll(".tab");

    const tokenInput = document.getElementById("tokenInput");
    const saveTokenBtn = document.getElementById("saveTokenBtn");
    const validateTokenBtn = document.getElementById("validateTokenBtn");
    const removeTokenBtn = document.getElementById("removeTokenBtn");
    const tokenStatus = document.getElementById("tokenStatus");

    const namingRadios = document.querySelectorAll('input[name="naming"]');

    const themeSelect = document.getElementById("themeSelect");
    const buttonColor = document.getElementById("buttonColor");
    const buttonText = document.getElementById("buttonText");
    const buttonStyle = document.getElementById("buttonStyle");
    const buttonPosition = document.getElementById("buttonPosition");

    const zipCompressionLevel = document.getElementById("zipCompressionLevel");
    const compressionValue = document.getElementById("compressionValue");
    const maxCacheSizeSlider = document.getElementById("maxCacheSize");
    const cacheValueDisplay = document.getElementById("cacheValue");

    const rateCount = document.getElementById("rateCount");
    const rateBar = document.getElementById("rateBar");
    const rateReset = document.getElementById("rateReset");
    const refreshRateBtn = document.getElementById("refreshRateBtn");

    const exportBtn = document.getElementById("exportBtn");
    const importBtn = document.getElementById("importBtn");
    const importFile = document.getElementById("importFile");

    const historyTable = document.getElementById("historyTable");
    const historyToggleBtn = document.getElementById("historyToggleBtn");
    const historyCollapsible = document.getElementById("historyCollapsible");
    const resetAllDataBtn = document.getElementById("resetAllDataBtn");
    const refreshHistoryBtn = document.getElementById("refreshHistoryBtn");
    const toastContainer = document.getElementById("toastContainer");

    function showToast(message, type = "success") {
      if (!toastContainer) return;

      // Limit to 3 visible toasts - remove oldest if needed
      const currentToasts = toastContainer.querySelectorAll(".gd-toast");
      if (currentToasts.length >= 3) {
        currentToasts[0].remove();
      }

      const toast = document.createElement("div");
      toast.className = `gd-toast ${type}`;
      const icon = type === "success" ? "✅" : "❌";
      toast.innerHTML = `<span>${icon}</span> <span>${message}</span>`;
      toastContainer.appendChild(toast);

      setTimeout(() => {
        if (toast.parentElement) {
          toast.style.opacity = "0";
          toast.style.transform = "translateX(20px)";
          setTimeout(() => toast.remove(), 300);
        }
      }, 4000);
    }

    navBtns.forEach((btn) => {
      btn.addEventListener("click", () => {
        const tabId = btn.dataset.tab;

        // Sync Nav Buttons
        navBtns.forEach((b) => {
          const isActive = b.dataset.tab === tabId;
          b.classList.toggle("active", isActive);
          b.setAttribute("aria-selected", isActive);
        });

        // Sync Tab Panels
        tabs.forEach((t) => {
          const isActive = t.id === tabId;
          t.classList.toggle("active", isActive);
        });
      });
    });

    if (historyToggleBtn && historyCollapsible) {
      historyToggleBtn.addEventListener("click", () => {
        const isActive = historyToggleBtn.classList.toggle("active");
        historyCollapsible.classList.toggle("active", isActive);
        historyToggleBtn.textContent = isActive
          ? "Hide Download History"
          : "View Download History";
      });
    }

    loadSettings();

    saveTokenBtn?.addEventListener("click", async () => {
      const token = tokenInput?.value.trim();
      if (!token) {
        showToast("Please enter a token", "error");
        return;
      }

      if (
        !token.startsWith("ghp_") &&
        !token.startsWith("github_pat_") &&
        !token.startsWith("gho_")
      ) {
        showToast("Invalid token format", "error");
        return;
      }

      try {
        const encrypted = await encryptToken(token);
        await chrome.storage.sync.set({ githubToken: encrypted });

        if (tokenInput) {
          tokenInput.value = "";
          tokenInput.placeholder = "••••••••••••••••";
        }
        showToast("Token saved securely!");
        updateTokenDisplayStatus("Token saved", false);
      } catch (e) {
        showToast("Error saving token", "error");
      }
    });

    validateTokenBtn?.addEventListener("click", validateToken);

    removeTokenBtn?.addEventListener("click", async () => {
      await chrome.storage.sync.remove("githubToken");
      if (tokenInput) {
        tokenInput.value = "";
        tokenInput.placeholder = "ghp_xxxxxxxxxxxxxxxxxxxx";
      }
      showToast("Token removed");
      updateTokenDisplayStatus("", false);
    });

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

    async function generateKey(passphrase) {
      const enc = new TextEncoder();
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

    async function encryptToken(token) {
      const key = await getEncryptionKey();
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const enc = new TextEncoder();
      const ciphertext = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv },
        key,
        enc.encode(token),
      );
      const combined = new Uint8Array(iv.length + ciphertext.byteLength);
      combined.set(iv);
      combined.set(new Uint8Array(ciphertext), iv.length);
      return btoa(String.fromCharCode(...combined));
    }

    async function decryptToken(data) {
      const key = await getEncryptionKey();
      const combined = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
      const iv = combined.slice(0, 12);
      const ciphertext = combined.slice(12);
      const plaintext = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv },
        key,
        ciphertext,
      );
      return new TextDecoder().decode(plaintext);
    }

    async function getTokenForValidation() {
      const rawToken = tokenInput?.value.trim();
      if (rawToken) return rawToken;

      const settings = await chrome.storage.sync.get({ githubToken: "" });
      if (!settings.githubToken) {
        throw new Error("Enter or save a token first");
      }

      return decryptToken(settings.githubToken);
    }

    async function validateToken() {
      if (!validateTokenBtn) return;

      validateTokenBtn.disabled = true;
      const originalText = validateTokenBtn.textContent;
      validateTokenBtn.textContent = "Checking...";

      try {
        const token = await getTokenForValidation();
        const response = await fetch("https://api.github.com/rate_limit", {
          headers: { Authorization: `token ${token}` },
        });

        if (response.status === 401) throw new Error("Invalid token");
        if (!response.ok) throw new Error(`Status ${response.status}`);

        const data = await response.json();
        const core = data.resources?.core || data.rate;
        showToast("Token is valid!");
        updateTokenDisplayStatus(
          `Valid. API limit: ${core.remaining}/${core.limit}`,
          false,
        );
        loadRateLimit();
      } catch (e) {
        showToast(e.message, "error");
        updateTokenDisplayStatus(`Check failed: ${e.message}`, true);
      } finally {
        validateTokenBtn.disabled = false;
        validateTokenBtn.textContent = originalText;
      }
    }

    function updateCompressionDisplay(level) {
      if (!compressionValue) return;
      const val = parseInt(level, 10);
      if (val === 0) {
        compressionValue.textContent = "Store (0)";
      } else {
        compressionValue.textContent = `Level ${val}`;
      }
    }

    if (zipCompressionLevel) {
      zipCompressionLevel.addEventListener("input", () => {
        const val = zipCompressionLevel.value;
        updateCompressionDisplay(val);
      });
      zipCompressionLevel.addEventListener("change", () => {
        chrome.storage.sync.set({
          zipCompressionLevel: parseInt(zipCompressionLevel.value, 10),
        });
      });
    }

    if (maxCacheSizeSlider) {
      maxCacheSizeSlider.addEventListener("input", () => {
        if (cacheValueDisplay)
          cacheValueDisplay.textContent = `${maxCacheSizeSlider.value} MB`;
      });
      maxCacheSizeSlider.addEventListener("change", () => {
        chrome.storage.sync.set({
          maxCacheSize: parseInt(maxCacheSizeSlider.value, 10),
        });
      });
    }

    namingRadios.forEach((radio) => {
      radio.addEventListener("change", () => {
        chrome.storage.sync.set({ namingPolicy: radio.value });
        showToast("Naming policy updated");
      });
    });

    if (themeSelect) themeSelect.addEventListener("change", saveAppearance);
    if (buttonColor) buttonColor.addEventListener("input", saveAppearance);
    if (buttonText) buttonText.addEventListener("input", saveAppearance);
    if (buttonStyle) buttonStyle.addEventListener("change", saveAppearance);
    if (buttonPosition)
      buttonPosition.addEventListener("change", saveAppearance);

    exportBtn?.addEventListener("click", async () => {
      const settings = await chrome.storage.sync.get(null);
      const blob = new Blob([JSON.stringify(settings, null, 2)], {
        type: "application/json",
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "github-smart-downloader-settings.json";
      a.click();
      URL.revokeObjectURL(url);
      showToast("Settings exported");
    });

    importBtn?.addEventListener("click", () => importFile?.click());

    importFile?.addEventListener("change", async () => {
      const file = importFile?.files?.[0];
      if (!file) return;

      try {
        const text = await file.text();
        const settings = sanitizeImportedSettings(JSON.parse(text));
        await chrome.storage.sync.clear();
        await chrome.storage.sync.set(settings);
        showToast("Settings imported! Reloading...");
        setTimeout(() => location.reload(), 1500);
      } catch (e) {
        showToast("Invalid settings file", "error");
      }
    });

    resetAllDataBtn?.addEventListener("click", async () => {
      if (
        confirm(
          "Are you sure you want to clear ALL download history and statistics? This cannot be undone.",
        )
      ) {
        await chrome.storage.local.set({
          downloadHistory: [],
          statistics: { totalDownloads: 0, totalBytes: 0, filesDownloaded: 0 },
        });
        loadHistory();
        loadStatistics();
        showToast("All history and statistics cleared");
      }
    });

    if (refreshRateBtn) {
      refreshRateBtn.addEventListener("click", refreshRateLimit);
    }

    if (refreshHistoryBtn) {
      refreshHistoryBtn.addEventListener("click", () => {
        loadHistory();
        loadStatistics();
        showToast("History & Statistics updated");

        // Visual feedback - rotate the SVG icon
        const svg = refreshHistoryBtn.querySelector("svg");
        if (svg) {
          svg.style.transform = "rotate(360deg)";
          setTimeout(() => {
            svg.style.transform = "";
          }, 500);
        }
      });
    }

    const statDownloads = document.getElementById("statDownloads");
    const statFiles = document.getElementById("statFiles");
    const statSize = document.getElementById("statSize");

    function loadStatistics() {
      chrome.storage.local.get(
        {
          statistics: { totalDownloads: 0, totalBytes: 0, filesDownloaded: 0 },
        },
        (result) => {
          const stats = result.statistics || {
            totalDownloads: 0,
            totalBytes: 0,
            filesDownloaded: 0,
          };
          if (statDownloads) statDownloads.textContent = stats.totalDownloads;
          if (statFiles) statFiles.textContent = stats.filesDownloaded;
          if (statSize) statSize.textContent = formatBytes(stats.totalBytes);
        },
      );
    }

    loadHistory();
    loadRateLimit();
    loadStatistics();

    async function loadSettings() {
      try {
        const settings = await chrome.storage.sync.get(SHARED_DEFAULTS);

        if (settings.githubToken && tokenInput) {
          tokenInput.placeholder = "••••••••••••••••";
          updateTokenDisplayStatus("Token saved", false);
        }

        const radio = document.querySelector(
          `input[name="naming"][value="${settings.namingPolicy}"]`,
        );
        if (radio) radio.checked = true;

        if (themeSelect) themeSelect.value = settings.themeMode;
        if (buttonColor) buttonColor.value = settings.buttonColor;
        if (buttonText) buttonText.value = settings.buttonText;
        if (buttonStyle) buttonStyle.value = settings.buttonStyle;
        if (buttonPosition) buttonPosition.value = settings.buttonPosition;
        if (zipCompressionLevel) {
          zipCompressionLevel.value = settings.zipCompressionLevel;
          updateCompressionDisplay(settings.zipCompressionLevel);
        }

        if (maxCacheSizeSlider) {
          maxCacheSizeSlider.value = settings.maxCacheSize || 100;
          if (cacheValueDisplay)
            cacheValueDisplay.textContent = `${maxCacheSizeSlider.value} MB`;
        }

        applyTheme(settings.themeMode);
        applyAccent(settings.buttonColor);
      } catch (e) {
        console.error("Failed to load settings:", e);
      }
    }

    function saveAppearance() {
      const settings = {
        buttonColor: buttonColor?.value || SHARED_DEFAULTS.buttonColor,
        buttonText: buttonText?.value || SHARED_DEFAULTS.buttonText,
        buttonStyle: buttonStyle?.value || SHARED_DEFAULTS.buttonStyle,
        buttonPosition: buttonPosition?.value || SHARED_DEFAULTS.buttonPosition,
      };
      if (themeSelect) settings.themeMode = themeSelect.value;
      applyTheme(settings.themeMode || SHARED_DEFAULTS.themeMode);
      applyAccent(settings.buttonColor);
      chrome.storage.sync.set(settings);
    }

    function sanitizeImportedSettings(raw) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        throw new Error("Invalid format");
      }

      const allowed = {
        themeMode: (value) =>
          ["system", "light", "dark"].includes(value)
            ? value
            : SHARED_DEFAULTS.themeMode,
        buttonColor: (value) =>
          /^#[0-9a-f]{6}$/i.test(value) ? value : SHARED_DEFAULTS.buttonColor,
        buttonText: (value) =>
          typeof value === "string" && value.trim()
            ? value.trim().slice(0, 80)
            : SHARED_DEFAULTS.buttonText,
        buttonStyle: (value) =>
          ["none", "default", "outline", "rounded", "pill"].includes(value)
            ? value
            : SHARED_DEFAULTS.buttonStyle,
        buttonPosition: (value) =>
          ["separate", "integrated"].includes(value)
            ? value
            : SHARED_DEFAULTS.buttonPosition,
        namingPolicy: (value) =>
          ["fullPath", "simpleName"].includes(value)
            ? value
            : SHARED_DEFAULTS.namingPolicy,
        githubToken: (value) => (typeof value === "string" ? value : ""),
        zipCompressionLevel: (value) => {
          const val = parseInt(value, 10);
          return isNaN(val) ? 0 : Math.max(0, Math.min(9, val));
        },
        maxCacheSize: (value) => {
          const val = parseInt(value, 10);
          return isNaN(val) ? 100 : Math.max(50, Math.min(1000, val));
        },
      };

      return Object.fromEntries(
        Object.entries(allowed).map(([key, normalize]) => [
          key,
          normalize(raw[key]),
        ]),
      );
    }

    function applyTheme(themeMode) {
      if (themeMode === "light" || themeMode === "dark") {
        document.documentElement.dataset.theme = themeMode;
      } else {
        delete document.documentElement.dataset.theme;
      }
    }

    function applyAccent(color) {
      document.documentElement.style.setProperty(
        "--gd-accent",
        color || SHARED_DEFAULTS.buttonColor,
      );
    }

    function updateTokenDisplayStatus(message, isError) {
      if (!tokenStatus) return;
      tokenStatus.textContent = message;
      tokenStatus.className = "status-text " + (isError ? "error" : "success");
    }

    function loadRateLimit() {
      chrome.storage.local.get("rateLimit", (result) => {
        const data = result.rateLimit || { limit: 60, remaining: 60, reset: 0 };
        const percent = getRateLimitPercent(data);

        if (rateCount)
          rateCount.textContent = data.remaining + " / " + data.limit;
        if (rateBar) {
          rateBar.style.width = percent + "%";

          // Color based on limit
          if (percent < 20) {
            rateBar.style.background = "var(--gd-danger)";
            rateBar.classList.add("pulse-warning");
          } else if (percent < 50) {
            rateBar.style.background = "#bf8700";
            rateBar.classList.remove("pulse-warning");
          } else {
            rateBar.style.background = "var(--gd-accent)";
            rateBar.classList.remove("pulse-warning");
          }
        }

        if (rateReset) {
          rateReset.textContent = data.reset
            ? formatRateLimitReset(data.reset)
            : "-";
        }
      });
    }

    async function refreshRateLimit() {
      if (!refreshRateBtn) return;
      refreshRateBtn.disabled = true;
      const originalText = refreshRateBtn.textContent;
      refreshRateBtn.textContent = "Refreshing...";

      chrome.runtime.sendMessage({ action: "refreshRateLimit" }, (response) => {
        refreshRateBtn.disabled = false;
        refreshRateBtn.textContent = originalText;
        if (!chrome.runtime.lastError && response?.success) {
          loadRateLimit();
          showToast("Rate limit updated");
        } else {
          showToast("Failed to refresh limit", "error");
        }
      });
    }

    function loadHistory() {
      chrome.storage.local.get({ downloadHistory: [] }, (result) => {
        const history = result.downloadHistory;
        if (!historyTable) return;

        if (history.length === 0) {
          historyTable.innerHTML = `
            <tr class="empty-row">
              <td colspan="5">
                <div class="empty-history-visual">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="21 8 21 21 3 21 3 8"></polyline><rect x="1" y="3" width="22" height="5"></rect><line x1="10" y1="12" x2="14" y2="12"></line></svg>
                  <span>No download history available yet</span>
                </div>
              </td>
            </tr>
          `;
          return;
        }

        historyTable.innerHTML = "";
        history.forEach((item) => {
          const row = document.createElement("tr");
          row.innerHTML = `
            <td>${escapeHtml(item.name)}</td>
            <td><span class="badge">${item.type}</span></td>
            <td>${item.count}</td>
            <td>${formatBytes(item.size)}</td>
            <td>${new Date(item.date).toLocaleDateString()}</td>
          `;
          historyTable.appendChild(row);
        });
      });
    }

    function formatBytes(bytes) {
      return window.GitDownerShared?.formatBytes(bytes) || "-";
    }

    function getRateLimitPercent(rateLimit) {
      return window.GitDownerShared?.getRateLimitPercent(rateLimit) || 0;
    }

    function formatRateLimitReset(reset) {
      return window.GitDownerShared?.formatRateLimitReset(reset) || "-";
    }

    function escapeHtml(str) {
      if (!str) return "";
      return str
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
    }
  }
})();
