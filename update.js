/**
 * updater.ts — Over-the-Air self-updater for Pinggy CLI
 *
 * Design principles:
 *  - NEVER block or crash the main CLI on any update failure
 *  - Write all update messages to stderr so stdout piping is never polluted
 *  - Cache the version check result (default: 24h) to avoid hitting GitHub on every run
 *  - On Unix  → atomic rename + re-exec with original argv (seamless resume)
 *  - On Windows → deferred bat-script replace + re-launch (OS locks running .exe)
 *  - Respects PINGGY_NO_UPDATE=1 and CI env vars
 */

const https = require("https");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { execFileSync, spawn } = require("child_process");

// ─── Constants ────────────────────────────────────────────────────────────────

const REPO = "Niladri2003/cli-test";
const GITHUB_API_BASE = "https://api.github.com";
const CACHE_DIR = path.join(os.homedir(), ".cli-test");
const CACHE_FILE = path.join(CACHE_DIR, "update-cache.json");

/** How long before we re-check GitHub (default 24h). Override via PINGGY_UPDATE_INTERVAL_MS */
const CHECK_INTERVAL_MS = parseInt(
  process.env.PINGGY_UPDATE_INTERVAL_MS ?? String(24 * 60 * 60 * 1000),
  10
);

/** Timeout for the GitHub API version check (ms) */
const VERSION_CHECK_TIMEOUT_MS = 5_000;

/** Timeout for the binary download (ms) — 5 min for ~100 MB on slow connections */
const DOWNLOAD_TIMEOUT_MS = 5 * 60 * 1000;

// ─── Platform helpers ─────────────────────────────────────────────────────────

/**
 * Returns the GitHub release asset name for the current platform/arch.
 * Matches the naming convention: pinggy-{os}-{arch}[.exe]
 */
function getAssetName() {
  const platformMap = {
    "linux-x64":    "pinggy-linux-x64",
  };

  const key = `${process.platform}-${process.arch}`;
  const name = platformMap[key];
  if (!name) {
    throw new UpdateError(
      `No release asset available for platform: ${key}`,
      "UNSUPPORTED_PLATFORM",
      false // not retryable — platform won't change
    );
  }
  return name;
}

/** Absolute path of the currently running binary */
function getCurrentBinaryPath() {
  // process.execPath is the Node/SEA binary path when pkg'd
  return process.execPath;
}

// ─── Custom error ─────────────────────────────────────────────────────────────

class UpdateError extends Error {
  constructor(message, code, retryable) {
    super(message);
    this.name = "UpdateError";
    this.code = code;
    this.retryable = retryable;
  }
}

// ─── Network helpers ──────────────────────────────────────────────────────────

/** Perform a GET request that follows redirects and resolves with parsed JSON */
function fetchJson(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const request = https.get(
      url,
      {
        headers: {
          "User-Agent": `pinggy-cli-updater`,
          Accept: "application/vnd.github+json",
        },
      },
      (res) => {
        // Follow redirects (301/302)
        if (
          (res.statusCode === 301 || res.statusCode === 302) &&
          res.headers.location
        ) {
          return fetchJson(res.headers.location, timeoutMs)
            .then(resolve)
            .catch(reject);
        }

        if (res.statusCode === 403 || res.statusCode === 429) {
          return reject(
            new UpdateError(
              "GitHub API rate limit reached. Try again later.",
              "RATE_LIMITED",
              true
            )
          );
        }

        if (res.statusCode !== 200) {
          return reject(
            new UpdateError(
              `GitHub API returned HTTP ${res.statusCode}`,
              "NETWORK_ERROR",
              true
            )
          );
        }

        let body = "";
        res.on("data", (chunk) => (body += chunk.toString()));
        res.on("end", () => {
          try {
            resolve(JSON.parse(body));
          } catch {
            reject(
              new UpdateError(
                "Failed to parse GitHub API response",
                "PARSE_ERROR",
                false
              )
            );
          }
        });
        res.on("error", (err) =>
          reject(new UpdateError(err.message, "NETWORK_ERROR", true))
        );
      }
    );

    request.setTimeout(timeoutMs, () => {
      request.destroy();
      reject(
        new UpdateError(
          `Version check timed out after ${timeoutMs / 1000}s`,
          "TIMEOUT",
          true
        )
      );
    });

    request.on("error", (err) =>
      reject(new UpdateError(err.message, "NETWORK_ERROR", true))
    );
  });
}

/** Download a URL to a file path, with progress callback and redirect support */
function downloadToFile(url, destPath, onProgress) {
  return new Promise((resolve, reject) => {
    const attempt = (currentUrl) => {
      const request = https.get(
        currentUrl,
        { headers: { "User-Agent": "pinggy-cli-updater" } },
        (res) => {
          if (
            (res.statusCode === 301 || res.statusCode === 302) &&
            res.headers.location
          ) {
            return attempt(res.headers.location);
          }

          if (res.statusCode !== 200) {
            return reject(
              new UpdateError(
                `Binary download failed: HTTP ${res.statusCode}`,
                "NETWORK_ERROR",
                true
              )
            );
          }

          const total = parseInt(res.headers["content-length"] ?? "0", 10);
          let downloaded = 0;
          const out = fs.createWriteStream(destPath);

          res.on("data", (chunk) => {
            downloaded += chunk.length;
            if (total > 0) onProgress(downloaded, total);
          });

          res.pipe(out);
          out.on("finish", () => out.close(() => resolve()));
          out.on("error", (err) => {
            reject(new UpdateError(err.message, "NETWORK_ERROR", true));
          });
          res.on("error", (err) => {
            reject(new UpdateError(err.message, "NETWORK_ERROR", true));
          });
        }
      );

      request.setTimeout(DOWNLOAD_TIMEOUT_MS, () => {
        request.destroy();
        reject(
          new UpdateError(
            `Download timed out after ${DOWNLOAD_TIMEOUT_MS / 1000 / 60} minutes`,
            "TIMEOUT",
            true
          )
        );
      });

      request.on("error", (err) =>
        reject(new UpdateError(err.message, "NETWORK_ERROR", true))
      );
    };

    attempt(url);
  });
}

// ─── Cache helpers ────────────────────────────────────────────────────────────

function readCache() {
  try {
    const raw = fs.readFileSync(CACHE_FILE, "utf-8");
    const data = JSON.parse(raw);
    if (Date.now() - data.checkedAt < CHECK_INTERVAL_MS) return data;
  } catch {
    // Missing or malformed cache — treat as expired
  }
  return null;
}

function writeCache(data) {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(
      CACHE_FILE,
      JSON.stringify({ ...data, checkedAt: Date.now() }),
      "utf-8"
    );
  } catch {
    // Cache write failure is non-fatal
  }
}

function invalidateCache() {
  try {
    fs.unlinkSync(CACHE_FILE);
  } catch {
    // Already missing — fine
  }
}

// ─── Semver comparison ────────────────────────────────────────────────────────

/**
 * Returns true if `candidate` is strictly newer than `current`.
 * Accepts versions with or without a leading "v".
 */
function isNewer(current, candidate) {
  const parse = (v) =>
    v
      .replace(/^v/, "")
      .split(".")
      .map((n) => parseInt(n, 10) || 0);

  const [cMaj, cMin, cPat] = parse(current);
  const [lMaj, lMin, lPat] = parse(candidate);

  return (
    lMaj > cMaj ||
    (lMaj === cMaj && lMin > cMin) ||
    (lMaj === cMaj && lMin === cMin && lPat > cPat)
  );
}

// ─── Checksum verification ────────────────────────────────────────────────────

/**
 * Verifies the SHA-256 hash of a file.
 * GitHub asset digest format: "sha256:abcdef1234..."
 */
function verifySha256(filePath, expectedDigest) {
  const expected = expectedDigest.replace(/^sha256:/i, "").toLowerCase();
  const buf = fs.readFileSync(filePath);
  const actual = crypto.createHash("sha256").update(buf).digest("hex");

  if (actual !== expected) {
    throw new UpdateError(
      `Checksum mismatch.\n  Expected: ${expected}\n  Got:      ${actual}\n  The download may be corrupted.`,
      "CHECKSUM_MISMATCH",
      true // retryable — re-download might fix it
    );
  }
}

// ─── Binary replacement ───────────────────────────────────────────────────────

/**
 * Atomically replaces the running binary with `newBinaryPath`, then
 * re-executes the new binary with the original argv so the user's
 * original command resumes seamlessly.
 *
 * On Windows, a bat script is used since the OS locks running executables.
 */
async function replaceSelfAndReexec(newBinaryPath) {
  const currentBin = getCurrentBinaryPath();
  const backupPath = `${currentBin}.bak`;

  if (process.platform === "win32") {
    return replaceSelfWindows(currentBin, newBinaryPath, backupPath);
  }

  return replaceSelfUnix(currentBin, newBinaryPath, backupPath);
}

function replaceSelfUnix(
  currentBin,
  newBinaryPath,
  backupPath
) {
  // Backup first for rollback
  fs.copyFileSync(currentBin, backupPath);

  try {
    fs.chmodSync(newBinaryPath, 0o755);
    // fs.renameSync is atomic on POSIX when src/dest are on the same filesystem.
    // /tmp is usually the same fs on Linux/macOS, but if not, we fall back to copy+unlink.
    try {
      fs.renameSync(newBinaryPath, currentBin);
    } catch (renameErr) {
      // Cross-device rename (EXDEV) — fall back to copy then unlink
      const err = renameErr;
      if (err.code === "EXDEV") {
        fs.copyFileSync(newBinaryPath, currentBin);
        fs.unlinkSync(newBinaryPath);
      } else {
        throw err;
      }
    }

    // Clean up backup on success
    try { fs.unlinkSync(backupPath); } catch { /* non-fatal */ }

  } catch (err) {
    // Rollback: restore from backup
    try {
      fs.renameSync(backupPath, currentBin);
    } catch {
      // Rollback also failed — leave backup in place, user can recover manually
    }
    const message = err instanceof Error ? err.message : String(err);
    throw new UpdateError(
      `Failed to replace binary: ${message}`,
      err instanceof UpdateError && err.code === "PERMISSION_DENIED"
        ? "PERMISSION_DENIED"
        : "REPLACE_FAILED",
      false
    );
  }

  // Re-exec the newly installed binary with the exact same arguments
  // stdio: 'inherit' → stdin/stdout/stderr all pass through seamlessly
  try {
    execFileSync(currentBin, process.argv.slice(2), { stdio: "inherit" });
  } catch (execErr) {
    // execFileSync throws if the child exits non-zero — that's fine,
    // mirror the exit code.
    const err = execErr;
    process.exit(err.status ?? 1);
  }

  process.exit(0);
}

function replaceSelfWindows(
  currentBin,
  newBinaryPath,
  _backupPath
) {
  // Windows locks running executables, so we must defer the replace.
  // Strategy: write a .bat that waits 2s, moves the new binary over, then re-launches.
  const batPath = path.join(os.tmpdir(), `_pinggy_update_${Date.now()}.bat`);
  const originalArgs = process.argv.slice(2).join(" ");

  const bat = [
    "@echo off",
    "timeout /t 2 /nobreak > NUL",
    `move /y "${newBinaryPath}" "${currentBin}"`,
    `if errorlevel 1 (`,
    `  echo Update failed: could not replace binary. Run "pinggy update" to retry.`,
    `) else (`,
    `  start "" "${currentBin}" ${originalArgs}`,
    `)`,
    `del "%~f0"`, // self-delete the bat
  ].join("\r\n");

  fs.writeFileSync(batPath, bat, "utf-8");
  spawn("cmd.exe", ["/c", batPath], {
    detached: true,
    stdio: "ignore",
  }).unref();

  // Exit current process — the bat will re-launch with original args after replace
  process.exit(0);
}

// ─── GitHub release fetching ──────────────────────────────────────────────────

async function fetchLatestRelease(assetName) {
  const release = await fetchJson(
    `${GITHUB_API_BASE}/repos/${REPO}/releases/latest`,
    VERSION_CHECK_TIMEOUT_MS
  );

  const asset = release.assets.find((a) => a.name === assetName);
  if (!asset) {
    throw new UpdateError(
      `No release asset found for "${assetName}" in the latest release (${release.tag_name}).`,
      "NO_ASSET_FOUND",
      false
    );
  }

  return {
    latestVersion: release.tag_name.replace(/^v/, ""),
    assetUrl: asset.browser_download_url,
    assetName: asset.name,
    sha256: asset.digest ?? null,
    size: asset.size,
    checkedAt: Date.now(),
  };
}

// ─── Progress display ─────────────────────────────────────────────────────────

function formatBytes(bytes) {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function renderProgressBar(downloaded, total) {
  const pct = Math.min(100, Math.floor((downloaded / total) * 100));
  const filled = Math.floor(pct / 5);
  const bar = "█".repeat(filled) + "░".repeat(20 - filled);
  return `   [${bar}] ${pct}% — ${formatBytes(downloaded)} / ${formatBytes(total)}`;
}

// ─── Main update logic ────────────────────────────────────────────────────────

/**
 * Entry point. Call this early in your CLI startup.
 *
 * On success with a new version: process re-execs into the new binary
 * and never returns. On any failure: logs a human-readable message and
 * returns normally so the existing binary continues running.
 */
async function checkAndUpdate(currentVersion, options = {}) {
  const { silent = false, force = false } = options;

  // ── Opt-out checks ──────────────────────────────────────────────────────────
  if (process.env.PINGGY_NO_UPDATE === "1") {
    return { status: "skipped", reason: "PINGGY_NO_UPDATE is set" };
  }
  if (process.env.CI) {
    return { status: "skipped", reason: "running in CI environment" };
  }
  // Don't update if running via ts-node / source (only update pkg'd binaries)
//   if (process.execPath.endsWith("node") || process.execPath.endsWith("node.exe")) {
//     return { status: "skipped", reason: "running from source (not a packaged binary)" };
//   }

  let assetName;
  try {
    assetName = getAssetName();
    console.log("assetname: " + assetName);
  } catch (err) {
    // Unsupported platform — skip silently
    return {
      status: "skipped",
      reason: err instanceof Error ? err.message : String(err),
    };
  }

  // ── Version check (cached) ──────────────────────────────────────────────────
  let releaseInfo = force ? null : readCache();

  if (!releaseInfo) {
    try {
      releaseInfo = await fetchLatestRelease(assetName);
      writeCache(releaseInfo);
    } catch (err) {
      const isRetryable = err instanceof UpdateError ? err.retryable : true;
      const reason = err instanceof Error ? err.message : String(err);

      if (!silent) {
        if (err instanceof UpdateError && err.code === "RATE_LIMITED") {
          console.log(
            "Could not check for updates: GitHub rate limit reached. " +
            "Run `pinggy update` later or set PINGGY_NO_UPDATE=1 to disable."
          );
        } else if (err instanceof UpdateError && err.code === "TIMEOUT") {
          // Timeout is very common on slow networks — stay silent by default
        } else {
          console.log(`Could not check for updates: ${reason}`);
        }
      }

      // ✅ CRITICAL: always return — never throw — so the CLI continues normally
      return { status: "failed", reason, retryable: isRetryable };
    }
  }

  // ── Already up to date ──────────────────────────────────────────────────────
  if (!isNewer(currentVersion, releaseInfo.latestVersion)) {
    return { status: "up-to-date" };
  }

  // ── New version available — download and install ────────────────────────────
  const fromVersion = currentVersion;
  const toVersion = releaseInfo.latestVersion;

  process.stderr.write(
    `\n🔄  Updating Pinggy CLI  v${fromVersion}  →  v${toVersion}\n`
  );

  const tmpPath = path.join(
    os.tmpdir(),
    `pinggy-update-${toVersion}-${Date.now()}${process.platform === "win32" ? ".exe" : ""}`
  );

  // ── Download ────────────────────────────────────────────────────────────────
  try {
    let lastRendered = -1;
    await downloadToFile(releaseInfo.assetUrl, tmpPath, (done, total) => {
      const pct = Math.floor((done / total) * 100);
      if (pct !== lastRendered) {
        process.stderr.write(`\r${renderProgressBar(done, total)}`);
        lastRendered = pct;
      }
    });
    process.stderr.write("\n"); // end the progress line
  } catch (err) {
    // Clean up partial download
    try { fs.unlinkSync(tmpPath); } catch { /* already gone */ }

    const reason = err instanceof Error ? err.message : String(err);
    const isRetryable = err instanceof UpdateError ? err.retryable : true;

    process.stderr.write("\n");
    console.log(
      `Update download failed: ${reason}\n` +
      (isRetryable
        ? `   ↳ Run \`pinggy update\` to try again, or visit https://github.com/${REPO}/releases`
        : `   ↳ Visit https://github.com/${REPO}/releases to download manually.`)
    );

    // Invalidate cache so next startup re-checks GitHub
    invalidateCache();

    return { status: "failed", reason, retryable: isRetryable };
  }

  // ── Checksum verification ───────────────────────────────────────────────────
  if (releaseInfo.sha256) {
    process.stderr.write("   Verifying checksum...\n");
    try {
      verifySha256(tmpPath, releaseInfo.sha256);
    } catch (err) {
      try { fs.unlinkSync(tmpPath); } catch { /* already gone */ }
      const reason = err instanceof Error ? err.message : String(err);

      console.log(
        `Update verification failed: ${reason}\n` +
        `   ↳ The downloaded file may be corrupted. Run \`pinggy update\` to retry.`
      );
      invalidateCache();
      return { status: "failed", reason, retryable: true };
    }
  }

  // ── Replace binary ──────────────────────────────────────────────────────────
  process.stderr.write("   Installing...\n\n");

  try {
    // This either re-execs (Unix) or schedules re-launch (Windows) — never returns normally
    await replaceSelfAndReexec(tmpPath);
  } catch (err) {
    try { fs.unlinkSync(tmpPath); } catch { /* already gone */ }
    const reason = err instanceof Error ? err.message : String(err);
    const isPermissionError =
      err instanceof UpdateError && err.code === "PERMISSION_DENIED";

    console.log(
      isPermissionError
        ? `Update failed: insufficient permissions to replace binary.\n` +
          `   ↳ Try: sudo pinggy update`
        : `Update failed: ${reason}\n` +
          `   ↳ Run \`pinggy update\` to retry.`
    );

    return { status: "failed", reason, retryable: !isPermissionError };
  }

  // Unreachable on Unix (replaceSelfAndReexec calls process.exit),
  // but TypeScript needs this for completeness.
  return { status: "updated", fromVersion, toVersion };
}
checkAndUpdate("0.0.0").then(result => {
  console.log("Update result:", result);
}).catch(err => {
  console.error("Unexpected error during update:", err);
});

module.exports = {
  checkAndUpdate,
};