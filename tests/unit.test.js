const {
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
} = require("../js/shared");

function headers(values) {
  return {
    get(name) {
      return values[name.toLowerCase()] ?? null;
    },
  };
}

describe("shared URL parsing", () => {
  test("parses repository root URLs with HEAD as the archive ref", () => {
    expect(parseGitHubUrl("https://github.com/openai/codex")).toEqual({
      owner: "openai",
      repo: "codex",
      ref: "HEAD",
      path: "",
      kind: "repo",
      isRepoRoot: true,
      isDirectory: true,
      isFile: false,
    });
  });

  test("parses tree URLs", () => {
    expect(
      parseGitHubUrl("https://github.com/openai/codex/tree/main/packages/app"),
    ).toMatchObject({
      owner: "openai",
      repo: "codex",
      ref: "main",
      path: "packages/app",
      kind: "directory",
      isDirectory: true,
      isFile: false,
    });
  });

  test("parses blob URLs", () => {
    expect(
      parseGitHubUrl("https://github.com/openai/codex/blob/main/README.md"),
    ).toMatchObject({
      ref: "main",
      path: "README.md",
      kind: "file",
      isDirectory: false,
      isFile: true,
    });
  });

  test("keeps common slash branch prefixes together", () => {
    expect(
      parseGitHubUrl(
        "https://github.com/acme/repo/tree/feature/new-ui/src/index.js",
      ),
    ).toMatchObject({
      ref: "feature/new-ui",
      path: "src/index.js",
    });
  });

  test("rejects non-repository GitHub pages", () => {
    expect(parseGitHubUrl("https://github.com/settings/tokens")).toBeNull();
    expect(parseGitHubUrl("https://github.com/search?q=test")).toBeNull();
  });
});

describe("shared formatting and filenames", () => {
  test("sanitizes Windows-hostile filename characters", () => {
    expect(sanitizeFilename("owner/repo:path*name?.zip")).toBe(
      "owner_repo_path_name_.zip",
    );
  });

  test("formats bytes predictably", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(999)).toBe("999 B");
    expect(formatBytes(1024)).toBe("1.02 KB");
    expect(formatBytes(1000000)).toBe("1 MB");
    expect(formatBytes(1234567)).toBe("1.23 MB");
    expect(formatBytes("Unknown")).toBe("Unknown");
  });

  test("generates full-path and simple ZIP filenames", () => {
    const repoInfo = { owner: "acme", repo: "repo", path: "src/components" };

    expect(generateZipFilename(repoInfo, "fullPath")).toBe(
      "acme_repo_src_components.zip",
    );
    expect(generateZipFilename(repoInfo, "simpleName")).toBe("components.zip");
  });
});

describe("selectable GitHub item detection", () => {
  const currentUrl = "https://github.com/acme/repo/tree/main/examples";

  test("accepts file and directory links from the current repo", () => {
    expect(
      getSelectableGitHubItem(
        currentUrl,
        "/acme/repo/tree/main/examples/cv",
        "cv",
      ),
    ).toEqual({
      name: "cv",
      path: "examples/cv",
      type: "dir",
      href: "https://github.com/acme/repo/tree/main/examples/cv",
    });

    expect(
      getSelectableGitHubItem(
        currentUrl,
        "/acme/repo/blob/main/examples/readme.md",
        "readme.md",
      ),
    ).toMatchObject({
      name: "readme.md",
      path: "examples/readme.md",
      type: "file",
    });
  });

  test("accepts rows from the live ossources root and subdirectory pages", () => {
    expect(
      getSelectableGitHubItem(
        "https://github.com/onursehitoglu/ossources/tree/master",
        "/onursehitoglu/ossources/tree/master/cv",
        "cv",
      ),
    ).toMatchObject({
      name: "cv",
      path: "cv",
      type: "dir",
    });

    expect(
      getSelectableGitHubItem(
        "https://github.com/onursehitoglu/ossources/tree/master/interactive",
        "/onursehitoglu/ossources/tree/master/interactive/filedemo",
        "filedemo",
      ),
    ).toMatchObject({
      name: "filedemo",
      path: "interactive/filedemo",
      type: "dir",
    });
  });

  test("rejects commit/header links and other repositories", () => {
    expect(
      getSelectableGitHubItem(
        currentUrl,
        "/acme/repo/commit/c674db2",
        "18 Commits",
      ),
    ).toBeNull();
    expect(
      getSelectableGitHubItem(
        currentUrl,
        "/other/repo/tree/main/examples/cv",
        "cv",
      ),
    ).toBeNull();
  });
});

describe("rate limit and size helpers", () => {
  test("parses GitHub rate limit headers", () => {
    const parsed = parseRateLimitHeaders(
      headers({
        "x-ratelimit-limit": "5000",
        "x-ratelimit-remaining": "42",
        "x-ratelimit-reset": "2000",
        "retry-after": "30",
      }),
    );

    expect(parsed).toEqual({
      limit: 5000,
      remaining: 42,
      reset: 2000000,
      retryAfter: 30,
    });
  });

  test("describes retry-after waits first", () => {
    expect(
      describeRateLimitWait(
        { retryAfter: 45, reset: Date.now() + 600000 },
        Date.now(),
      ),
    ).toBe("Try again in 45s.");
  });

  test("formats rate limit percent and reset time", () => {
    expect(getRateLimitPercent({ remaining: 25, limit: 100 })).toBe(25);
    expect(getRateLimitPercent({ remaining: 120, limit: 100 })).toBe(100);
    expect(getRateLimitPercent({ remaining: -5, limit: 100 })).toBe(0);
    expect(
      formatRateLimitReset(1_700_000_000_000 + 90 * 60000, 1_700_000_000_000),
    ).toBe("in 1h 30m");
  });

  test("estimates known file bytes", () => {
    expect(
      getZipSizeEstimate([
        { path: "a.txt", size: 100 },
        { path: "b.txt", size: 250 },
        { path: "unknown.txt" },
      ]),
    ).toBe(350);
  });
});

describe("download strategy planner", () => {
  test("uses full archive when every visible root item is selected", () => {
    expect(
      planDownloadStrategy({
        isRepoRoot: true,
        totalVisible: 10,
        selectedCount: 10,
        selectedDirs: 8,
        selectedFiles: 2,
        excludedTopLevelCount: 0,
      }).strategy,
    ).toBe("fullArchive");
  });

  test("uses filtered archive for mostly selected root repos with few top-level exclusions", () => {
    const plan = planDownloadStrategy({
      isRepoRoot: true,
      totalVisible: 10,
      selectedCount: 8,
      selectedDirs: 7,
      selectedFiles: 1,
      excludedCount: 2,
      excludedTopLevelCount: 2,
      apiRemaining: 60,
    });

    expect(plan.strategy).toBe("filteredArchive");
    expect(plan.score).toBeLessThan(
      plan.scores.find(
        (candidate) => candidate.strategy === "selectedRecursiveZip",
      ).score,
    );
  });

  test("keeps recursive ZIP for narrow partial selections", () => {
    expect(
      planDownloadStrategy({
        isRepoRoot: true,
        totalVisible: 20,
        selectedCount: 2,
        selectedDirs: 1,
        selectedFiles: 1,
        excludedCount: 18,
        excludedTopLevelCount: 18,
      }).strategy,
    ).toBe("selectedRecursiveZip");
  });
});
describe("offscreen document", () => {
  const fs = require("fs");
  const path = require("path");

  test("loads required scripts", () => {
    const html = fs.readFileSync(
      path.join(__dirname, "../html/offscreen.html"),
      "utf8",
    );

    expect(html).toContain("../lib/jszip.min.js");
    expect(html).toContain("../js/shared.js");
    expect(html).toContain("../js/offscreen.js");
  });
});
