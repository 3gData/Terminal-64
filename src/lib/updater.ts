import { check, type DownloadEvent, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import packageJson from "../../package.json";

const REPO = "Pugbread/Terminal-64";
const CURRENT_VERSION = packageJson.version;

export interface UpdateInfo {
  version: string;
  url?: string | undefined;
  notes: string;
  date?: string | undefined;
  source: "tauri" | "github";
}

export interface UpdateProgress {
  downloaded: number;
  contentLength: number;
  percent: number | null;
}

let pendingTauriUpdate: Update | null = null;

function updateInfoFromTauri(update: Update): UpdateInfo {
  const meta = update as Update & { body?: string | undefined; date?: string | undefined };
  return {
    version: update.version,
    notes: meta.body ?? "",
    date: meta.date,
    source: "tauri",
  };
}

async function checkGitHubRelease(): Promise<UpdateInfo | null> {
  const res = await fetch(
    `https://api.github.com/repos/${REPO}/releases/latest`,
    { headers: { Accept: "application/vnd.github.v3+json" } },
  );
  if (!res.ok) return null;
  const data = await res.json();
  const latest = String(data.tag_name || "").replace(/^v/, "");
  if (latest && latest !== CURRENT_VERSION) {
    return {
      version: latest,
      url: data.html_url,
      notes: data.body || "",
      source: "github",
    };
  }
  return null;
}

export async function checkForUpdate(): Promise<UpdateInfo | null> {
  pendingTauriUpdate = null;
  try {
    const update = await check();
    if (update) {
      pendingTauriUpdate = update;
      return updateInfoFromTauri(update);
    }
  } catch (e) {
    console.warn("[updater] Tauri update check failed; falling back to GitHub Releases:", e);
  }

  try {
    return await checkGitHubRelease();
  } catch (e) {
    console.warn("[updater] Failed to check GitHub Releases:", e);
  }
  return null;
}

export async function downloadAndInstallUpdate(
  onProgress?: (progress: UpdateProgress) => void,
): Promise<void> {
  let update = pendingTauriUpdate;
  if (!update) {
    update = await check();
    pendingTauriUpdate = update;
  }
  if (!update) {
    throw new Error("No Tauri update is available to install.");
  }

  let downloaded = 0;
  let contentLength = 0;
  await update.downloadAndInstall((event: DownloadEvent) => {
    if (event.event === "Started") {
      contentLength = event.data.contentLength ?? 0;
      downloaded = 0;
    } else if (event.event === "Progress") {
      downloaded += event.data.chunkLength;
    } else if (event.event === "Finished") {
      downloaded = contentLength || downloaded;
    }

    onProgress?.({
      downloaded,
      contentLength,
      percent: contentLength > 0 ? Math.min(100, Math.round((downloaded / contentLength) * 100)) : null,
    });
  });
}

export async function relaunchApp(): Promise<void> {
  await relaunch();
}
