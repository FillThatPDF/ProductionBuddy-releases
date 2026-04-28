// Electron main process for Production Buddy.
// Spawns a Python orchestrator that runs the InDesign / Illustrator edit +
// QA pipeline. Includes auto-update via electron-updater (GitHub releases).

const { app, BrowserWindow, ipcMain, dialog, screen } = require("electron");
const path = require("path");
const { spawn } = require("child_process");
const fs = require("fs");

let mainWindow;

// Resolve how to invoke the orchestrator:
//   - Packaged: a self-contained PyInstaller bundle ships at
//     Contents/Resources/python-engine/orchestrate. No system Python needed.
//   - Dev (npm start): fall back to running orchestrate.py with the host
//     python3 (faster iteration than rebuilding the bundle every change).
//
// Returns { command, args } that can be passed straight to spawn().
function getOrchestratorSpawn(payloadJSON) {
  if (app.isPackaged) {
    const bundled = path.join(process.resourcesPath, "python-engine", "orchestrate");
    return { command: bundled, args: [payloadJSON] };
  }
  // Dev mode — try the bundled binary first if it's been built locally,
  // otherwise spawn python3 directly.
  const localBundle = path.join(__dirname, "python", "dist", "orchestrate", "orchestrate");
  if (fs.existsSync(localBundle)) {
    return { command: localBundle, args: [payloadJSON] };
  }
  const py = ["/opt/homebrew/bin/python3", "/usr/local/bin/python3", "/usr/bin/python3"]
    .find((p) => { try { return fs.existsSync(p); } catch { return false; } }) || "python3";
  return {
    command: py,
    args: [path.join(__dirname, "python", "orchestrate.py"), payloadJSON],
  };
}

function setupAutoUpdater() {
  const { autoUpdater } = require("electron-updater");
  try {
    const log = require("electron-log");
    log.transports.file.level = "info";
    autoUpdater.logger = log;
  } catch (_) {}
  autoUpdater.on("checking-for-update", () => console.log("[auto-updater] checking…"));
  autoUpdater.on("update-not-available", (info) => console.log("[auto-updater] up to date:", info && info.version));
  autoUpdater.on("update-available", (info) => {
    if (mainWindow) mainWindow.webContents.send("update-available", info && info.version);
  });
  autoUpdater.on("download-progress", (p) => {
    if (mainWindow) mainWindow.webContents.send("update-download-progress", Math.round(p.percent));
  });
  autoUpdater.on("update-downloaded", (info) => {
    if (mainWindow) mainWindow.webContents.send("update-downloaded", info && info.version);
  });
  autoUpdater.on("error", (err) => console.error("[auto-updater] error:", err));

  ipcMain.handle("install-update", () => autoUpdater.quitAndInstall());
  return autoUpdater;
}

function createWindow() {
  const primary = screen.getPrimaryDisplay();
  const w = 1100, h = 820;
  const x = primary.workArea.x + Math.max(0, Math.floor((primary.workArea.width - w) / 2));
  const y = primary.workArea.y + Math.max(0, Math.floor((primary.workArea.height - h) / 2));
  mainWindow = new BrowserWindow({
    x, y, width: w, height: h,
    title: "Production Buddy",
    icon: path.join(__dirname, "assets", "icon.png"),
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  });
  mainWindow.loadFile("index.html");
  mainWindow.focus();
  if (process.argv.includes("--dev")) mainWindow.webContents.openDevTools();

  // Kick off the auto-update check shortly after the renderer is ready, so
  // its IPC listeners are registered before update-available can fire.
  if (app.isPackaged) {
    const auto = setupAutoUpdater();
    const run = () => auto.checkForUpdatesAndNotify().catch((err) => {
      console.error("[auto-updater] check failed:", err);
    });
    if (mainWindow.webContents.isLoading()) {
      mainWindow.webContents.once("did-finish-load", () => setTimeout(run, 1500));
    } else {
      setTimeout(run, 1500);
    }
  }
}

app.whenReady().then(createWindow);
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

// File / folder pickers
ipcMain.handle("pick-file", async (_evt, filters) => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ["openFile"],
    filters: filters || [],
  });
  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle("pick-folder", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ["openDirectory"],
  });
  return result.canceled ? null : result.filePaths[0];
});

// Run the orchestrator. Streams stdout to renderer for live progress.
ipcMain.handle("run-orchestrator", async (evt, payload) => {
  const { command, args } = getOrchestratorSpawn(JSON.stringify(payload));
  return new Promise((resolve) => {
    const env = { ...process.env, PB_RESOURCES_DIR: app.isPackaged ? process.resourcesPath : __dirname };
    const p = spawn(command, args, { env });
    let stdout = "";
    let stderr = "";
    let workDir = null;  // parsed from "[work_dir] <path>" marker on stdout
    p.stdout.on("data", (d) => {
      const text = d.toString();
      stdout += text;
      if (!workDir) {
        const m = text.match(/\[work_dir\]\s+(.+?)(?:\r?\n|$)/);
        if (m) workDir = m[1].trim();
      }
      evt.sender.send("orchestrator-progress", text);
    });
    p.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    p.on("close", (code) => {
      // findings.json and result.json now live in workDir (the cache scratch
      // dir); deliverables (.indd/.pdf) live in payload.outputDir.
      let findings = null;
      let result = null;
      const readDir = workDir || payload.outputDir;
      try {
        const findingsPath = path.join(readDir, "findings.json");
        if (fs.existsSync(findingsPath)) findings = JSON.parse(fs.readFileSync(findingsPath, "utf-8"));
      } catch (e) {}
      try {
        const resultPath = path.join(readDir, "result.json");
        if (fs.existsSync(resultPath)) result = JSON.parse(fs.readFileSync(resultPath, "utf-8"));
      } catch (e) {}
      resolve({ exitCode: code, stdout, stderr, findings, result, workDir });
    });
  });
});

// Open the output PDF in the default viewer
ipcMain.handle("open-file", async (_evt, filePath) => {
  const { shell } = require("electron");
  return shell.openPath(filePath);
});

// Clear all cached run dirs under ~/Library/Caches/indesign-editor/
ipcMain.handle("clear-cache", async () => {
  const cacheRoot = path.join(require("os").homedir(), "Library", "Caches", "indesign-editor");
  let deleted = 0;
  try {
    if (fs.existsSync(cacheRoot)) {
      for (const name of fs.readdirSync(cacheRoot)) {
        const p = path.join(cacheRoot, name);
        try {
          fs.rmSync(p, { recursive: true, force: true });
          deleted++;
        } catch (e) {}
      }
    }
  } catch (e) {
    return { ok: false, error: String(e) };
  }
  return { ok: true, deleted };
});

// Report app version to renderer (used by header / about)
ipcMain.handle("get-app-version", () => app.getVersion());

// ---- Ollama presence detection ----
// Returns { installed, hasModel, version, recommendedModel }.
// Used by:
//   - First-run popup: show only when installed=false
//   - Settings panel: drives the "Install / Update Ollama" button label
ipcMain.handle("check-ollama", async () => {
  const recommendedModel = "llama3.1:8b";
  const candidatePaths = [
    "/Applications/Ollama.app/Contents/Resources/ollama",
    "/Applications/Ollama.app/Contents/MacOS/Ollama",
    "/usr/local/bin/ollama",
    "/opt/homebrew/bin/ollama",
  ];
  let installed = false;
  let binaryPath = null;
  for (const p of candidatePaths) {
    try { if (fs.existsSync(p)) { installed = true; binaryPath = p; break; } } catch (_) {}
  }
  // Also accept Ollama.app bundle even if the inner binary moved
  if (!installed) {
    try { if (fs.existsSync("/Applications/Ollama.app")) installed = true; } catch (_) {}
  }
  let version = null;
  let hasModel = false;
  if (installed) {
    try {
      const out = require("child_process").execSync(
        (binaryPath ? `"${binaryPath}"` : "ollama") + " --version",
        { encoding: "utf-8", timeout: 3000 }
      );
      version = out.trim();
    } catch (_) {}
    try {
      const out = require("child_process").execSync(
        (binaryPath ? `"${binaryPath}"` : "ollama") + " list",
        { encoding: "utf-8", timeout: 3000 }
      );
      hasModel = /\b\S+:\S+\b/.test(out) && out.split("\n").length > 1;
    } catch (_) {}
  }
  return { installed, hasModel, version, recommendedModel };
});

// Open a URL in the user's default browser (used by the Ollama install button)
ipcMain.handle("open-external", async (_evt, url) => {
  const { shell } = require("electron");
  return shell.openExternal(url);
});
