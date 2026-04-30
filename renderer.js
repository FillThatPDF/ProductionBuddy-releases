const { ipcRenderer, webUtils } = require("electron");
const path = require("path");

const $ = (id) => document.getElementById(id);

// Global error handlers — surface JS errors as toasts so we can actually see them.
window.addEventListener("error", (e) => {
  try { toast("JS error: " + (e.message || "unknown") + " @ " + (e.filename || "?") + ":" + (e.lineno || "?"), 6000); } catch (_) {}
  console.error("[renderer]", e.error || e.message, e);
});
window.addEventListener("unhandledrejection", (e) => {
  try { toast("Promise rejection: " + (e.reason && e.reason.message || e.reason || "unknown"), 6000); } catch (_) {}
  console.error("[renderer]", e.reason);
});

// ---- Auto-update banner ----
// IPC listeners must register at module load (sync), not inside an async
// IIFE — electron-updater fires `update-available` ~1.5s after launch and
// the event will be missed if the listener attaches later.
function showUpdateBanner(version) {
  const banner = document.getElementById("updateBanner");
  const v = document.getElementById("updateBannerVersion");
  const a = document.getElementById("updateBannerAction");
  if (!banner) return;
  banner.classList.remove("hidden");
  if (v && version) v.textContent = "(v" + version + ")";
  if (a) {
    a.textContent = "Downloading…";
    a.style.cursor = "default";
    a.onclick = (e) => e.preventDefault();
  }
}
ipcRenderer.on("update-available", (_evt, version) => showUpdateBanner(version));
ipcRenderer.on("update-download-progress", (_evt, percent) => {
  const banner = document.getElementById("updateBanner");
  const a = document.getElementById("updateBannerAction");
  if (banner) banner.classList.remove("hidden");
  if (a) a.textContent = "Downloading… " + percent + "%";
});
ipcRenderer.on("update-downloaded", (_evt, version) => {
  const banner = document.getElementById("updateBanner");
  const v = document.getElementById("updateBannerVersion");
  const a = document.getElementById("updateBannerAction");
  if (banner) banner.classList.remove("hidden");
  if (v && version) v.textContent = "(v" + version + ")";
  if (a) {
    a.textContent = "Restart to Update";
    a.style.cursor = "pointer";
    a.onclick = (e) => {
      e.preventDefault();
      ipcRenderer.invoke("install-update");
    };
  }
});

// Inlined FINDING_META — single source of truth, no cross-file dependency.
const FINDING_META = {
  TEXT_WHITESPACE:           { title: "Whitespace cleanup", plain: "Multiple consecutive spaces or trailing spaces at line ends were removed.", fix: "Already auto-fixed.", canAutoFix: true },
  TEXT_SMART_QUOTES:         { title: "Smart quotes applied", plain: "Straight quotes were converted to typographic ones (“ ” ’).", fix: "Already auto-fixed.", canAutoFix: true },
  TEXT_DOUBLE_PUNCT:         { title: "Doubled punctuation cleaned up", plain: "Triple-period sequences became ellipsis (…); doubled commas collapsed.", fix: "Already auto-fixed.", canAutoFix: true },
  TEXT_TM_SUPERSCRIPT:       { title: "Trademark/registered marks superscripted", plain: "®, ™, and © characters now display as superscript per typesetting convention.", fix: "Already auto-fixed.", canAutoFix: true },
  IMG_LOW_RES:               { title: "Images below print resolution", plain: "One or more placed images have an effective resolution below 300dpi. Print output will look pixelated/soft.", fix: "Replace each listed asset with a higher-resolution version, then re-import. The 'effective dpi' is source ppi divided by placement scale, so don't enlarge a 72dpi image to fix it — get a real high-res file.", canAutoFix: false },
  LINK_MISSING:              { title: "Missing linked assets", plain: "InDesign expects to find linked image/asset files at specific paths but they're missing. The output PDF uses InDesign's low-res cached preview, so the layout is preserved — but you should re-link to a hi-res file before final delivery.", fix: "Open Window → Links in InDesign. For each missing item, click the broken-link icon and re-link to the correct file. (See LINK_RECOVERY findings for Box search results and stock-photo URLs.)", canAutoFix: false },
  LINK_RECOVERY:             { title: "Suggested recovery for missing link", plain: "We searched Box for files matching the missing-link filename (with and without ICF_ prefix) and recognized stock-photo IDs. If you see a Box match, that's likely the file to re-link to. If you see a stock URL, click through to re-license/download the asset.", fix: "Verify the suggested file is correct, then in InDesign: Window → Links → select missing item → click broken-link icon → navigate to the suggested file. For stock photos, follow the URL to your licensed account.", canAutoFix: false },
  LINK_AUTO_RELINKED:        { title: "Missing link was auto-relinked from Box", plain: "We found an exact filename match in Box and automatically re-pointed the broken link. The PDF has been re-exported with the recovered asset.", fix: "Verify the relinked file is the version you intended.", canAutoFix: true },
  IMG_HIRES_SWAPPED:         { title: "Watermarked comp swapped for hi-res", plain: "We detected one or more placed images that look like stock-photo watermarked comps (Getty / AdobeStock / Shutterstock / iStock filename patterns), found matching hi-res files in the folder you provided, and re-linked the InDesign doc. The PDF was re-exported with the licensed images.", fix: "Verify each swap matches the intended licensed asset.", canAutoFix: true },
  IMG_HIRES_NOT_FOUND:       { title: "Watermarked comp without a hi-res match", plain: "Some placed images look like stock-photo comps but no matching hi-res file was found in the folder you provided. The doc still uses the watermarked version for those.", fix: "Verify the hi-res folder contains the licensed versions (filenames must contain the same numeric photo ID), or download the hi-res files into Box first, then re-run.", canAutoFix: false },
  FONT_UNAVAILABLE:          { title: "Fonts not properly installed", plain: "Fonts used in the document aren't activated. InDesign substitutes which changes line breaks and styling.", fix: "Activate via Adobe Fonts (CC → Fonts) or install the system font. If you don't have a license, replace with an equivalent font and update paragraph styles.", canAutoFix: false },
  FONT_AUTO_ACTIVATED:       { title: "Font auto-activated via FontExplorer X Pro", plain: "We found the missing font in your FontExplorer library and activated it; the PDF was re-exported.", fix: "Verify the activated font matches your design intent.", canAutoFix: true },
  FONT_ADOBE_FONTS_URL:      { title: "Font available on Adobe Fonts", plain: "We couldn't activate this font via FontExplorer X Pro. It may be available on Adobe Fonts — follow the link to activate it via Creative Cloud, then re-run the job.", fix: "Open the Adobe Fonts URL in the message, click Activate, then re-run.", canAutoFix: false },
  TEXT_OVERSET:              { title: "Text overflowing its frame", plain: "Some text frames have content that doesn't fit. Hidden text won't print.", fix: "Open the .indd, find the red '+' on the bottom-right of the offending frame, then either resize the frame, reduce content, or thread to an additional frame.", canAutoFix: false },
  HYPERLINK_TEXT_MISMATCH:   { title: "Hyperlink text doesn't match destination", plain: "Cells display one URL/email but actually link somewhere else. Anyone clicking goes to the wrong place.", fix: "Window → Hyperlinks. For each mismatch, either update the URL field or update the displayed text — whichever is correct.", canAutoFix: false },
  HYPERLINK_BROKEN:          { title: "Hyperlink returns an error", plain: "The destination URL responded with a 4xx/5xx HTTP status — broken or moved.", fix: "Verify the URL in a browser. Update or remove the hyperlink in InDesign (Window → Hyperlinks).", canAutoFix: false },
  HYPERLINK_UNREACHABLE:     { title: "Hyperlink couldn't be reached", plain: "Destination didn't respond. Could be a network issue, or the site is down/blocking probes.", fix: "Re-test in a browser. If it's reachable manually, this is a false positive (some sites block HEAD requests). If not, update or remove.", canAutoFix: false },
  URL_NOT_HYPERLINKED:       { title: "URL-like text without an active hyperlink", plain: "Found text that looks like a URL but isn't clickable.", fix: "In InDesign, select the URL text → Window → Hyperlinks → New Hyperlink From URL.", canAutoFix: false },
  STYLE_PARA_OVERRIDES:      { title: "Paragraphs overriding their style", plain: "Paragraphs have direct formatting (font, size) that diverges from their applied paragraph style.", fix: "In InDesign, select the paragraph → check the Paragraph Styles panel for a '+' next to the style name → click 'Clear Overrides' if unintentional.", canAutoFix: false },
  STYLE_COLOR_MISMATCH:      { title: "Paragraph color overrides", plain: "Some paragraphs are using a fill color that differs from their applied style's color.", fix: "Verify the override is intentional. If not, clear the local override.", canAutoFix: false },
  FONT_TOO_MANY:             { title: "Many distinct fonts in document", plain: "Documents with more than 4 fonts feel inconsistent.", fix: "Review which fonts are used where; reduce to a primary + secondary pair.", canAutoFix: false },
  STYLE_FONTLESS_CHAR_STYLE: { title: "Character style had no font assigned", plain: "One or more character styles (e.g. 'bullet') had an empty Font Family field. InDesign falls back to a default font for these, so styled runs (like bullets) can render with the wrong typeface.", fix: "Auto-fixed: assigned the document's dominant body font. Open the .indd and verify in Window → Styles → Character Styles → double-click the style.", canAutoFix: true },
  COLOR_RGB_SWATCH:          { title: "RGB swatches in a print document", plain: "RGB colors will be converted at output and may shift visually. CMYK is the right space for print.", fix: "Window → Color → Swatches. Double-click each RGB swatch and switch to CMYK. Or convert globally via Edit → Convert to Profile.", canAutoFix: false },
  COLOR_RICH_BLACK_SMALL:    { title: "Rich black on small text", plain: "Body text under 14pt using rich black (CMY combined with K=100) registers poorly on press.", fix: "Change those text runs to 100% K only (C=0 M=0 Y=0 K=100).", canAutoFix: false },
  TEXT_HYPHEN_VS_DASH:       { title: "Hyphen possibly should be en-dash", plain: "Found patterns like 'word - word' (hyphen with spaces). Should usually be an en-dash (–).", fix: "Find/Change in InDesign: ' - ' → ' – ' where appropriate.", canAutoFix: false },
  TEXT_EMPTY_PARAS:          { title: "Empty paragraphs", plain: "Multiple consecutive return characters with no content.", fix: "Review each location. If used for spacing, prefer 'space after paragraph' on the paragraph style instead.", canAutoFix: false },
  DOC_NO_BLEED:              { title: "No bleed configured", plain: "Document has 0 bleed on all sides. Print jobs that go to the edge need a bleed (typically 0.125\").", fix: "File → Document Setup → set Bleed to 0.125\" all around.", canAutoFix: false },
  LINK_OUT_OF_DATE:          { title: "Linked assets out of date", plain: "A linked file on disk has been modified since InDesign last imported it.", fix: "Window → Links → click the yellow triangle on each item to update.", canAutoFix: false },
  SPELLCHECK_SUSPICIOUS:     { title: "Possible spelling issues", plain: "Words not found in the dictionary. Many will be proper nouns, company names, or domain terms — those are false positives.", fix: "Review the list. For genuine typos, fix in InDesign. For correct-but-flagged words, ignore or add to a personal dictionary.", canAutoFix: false },
  HYPERLINK_INVENTORY:       { title: "Hyperlinks count", plain: "Total hyperlinks in the document. FYI only.", fix: "—", canAutoFix: false },
  IMG_COUNT:                 { title: "Image count", plain: "Total placed graphics in the document. FYI only.", fix: "—", canAutoFix: false },
  FONT_INVENTORY:            { title: "Fonts in use", plain: "List of all fonts referenced by the document.", fix: "—", canAutoFix: false },
  COLOR_SPOT_COLORS:         { title: "Spot colors present", plain: "Spot/Pantone colors are defined in the document.", fix: "Confirm intentional. If process-only (CMYK), convert spots to process via Window → Color → Swatches.", canAutoFix: false },
  DOC_COLOR_PROFILE:         { title: "Document color profile", plain: "The CMYK and RGB profiles configured for the doc.", fix: "—", canAutoFix: false },
  DOC_DIMENSIONS:            { title: "Document dimensions", plain: "Page count and page size.", fix: "—", canAutoFix: false },
  DOC_BLEED:                 { title: "Bleed settings", plain: "Configured bleed on each side.", fix: "—", canAutoFix: false },
  LAYER_HIDDEN_WITH_CONTENT: { title: "Hidden layers with content", plain: "Layers are turned off but contain page items. Content won't print/export.", fix: "Window → Layers. Verify each hidden layer is intentionally off.", canAutoFix: false },
  ITEM_LOCKED:               { title: "Locked items", plain: "Some page items have the lock icon — can't be edited until unlocked.", fix: "Object → Unlock All on Spread, or click the padlock in the Layers panel.", canAutoFix: false },
  MASTER_OVERRIDES:          { title: "Master-page overrides", plain: "Items inherited from master pages have been individually overridden on document pages.", fix: "Verify each is intentional.", canAutoFix: false },
  DOC_OVERPRINT_PREF:        { title: "Overprint preferences", plain: "Overprint configuration metadata.", fix: "—", canAutoFix: false },

  // 508 designer-side compliance checks (only run when "508 compliance check" is on)
  "508_CONTRAST_LOW":        { title: "Low color contrast (508)", plain: "Text-vs-background contrast is below the WCAG AA threshold (4.5:1 for body text, 3:1 for ≥18pt or ≥14pt bold). Will fail compliance.", fix: "Change text color or background to increase contrast. Use the Snook calculator (snook.ca/technical/colour_contrast) or the Colour Contrast Analyser app to verify.", canAutoFix: false },
  "508_HAIRLINE_RULE":       { title: "Hairline rules under 1pt (508)", plain: "Strokes thinner than 1pt tend to disappear during PDF tagging for accessibility.", fix: "Increase stroke weight to ≥1pt for any rule that must remain visible.", canAutoFix: false },
  "508_IMG_NO_ALT":          { title: "Images missing alt text (508)", plain: "Placed graphics need alt text so screen readers can describe them.", fix: "Object → Object Export Options → Alt Text. Add a concise description for each image.", canAutoFix: false },
  "508_DOC_PROPS_MISSING":   { title: "Document properties missing (508)", plain: "Title, author, subject, and keywords need to be set for tagged-PDF metadata.", fix: "File → File Info. Title = document name (not filename). Author = agency. Subject = doc type. Keywords = search terms.", canAutoFix: false },
  "508_TAGGED_PDF_ON":       { title: "Tagged PDF enabled (508)", plain: "PDF was exported with 'Create Tagged PDF' on, as required for 508.", fix: "Already auto-fixed.", canAutoFix: true },
};
window.FINDING_META = FINDING_META; // for debugging via devtools

const state = { pdf: null, indd: null, out: null, refFiles: [], hiResImages: null };

// Separate state for the Data Merge mode
const dmState = {
  template: null,
  xlsx: [],
  out: null,
  nameCol: "state",
  source: "xlsx",   // "xlsx" | "csv"
  csvPath: null,
};
// Separate state for the Tag-a-Template mode
const ttState = { template: null, xlsx: [], refState: "California", outPath: null };
let appMode = "markup"; // "markup" | "data_merge" | "tag_template"

// ---- Settings: persistence + defaults ----
const DEFAULT_SETTINGS = {
  useOllama: true,
  ollamaModel: "llama3.1:8b",
  minDpi: 300,
  maxFonts: 4,
  bodySize: 14,
  autoRelink: true,
  autoActivateFonts: true,
  autoOpenPdf: true,
  autoOpenIndd: false,
  showInfoFindings: false,
  cacheRetention: 10,   // keep last N cache scratch dirs
  run508Check: false,   // 508 designer-side compliance check
  ignoredFindingIds: [],
  resolvedFindings: {}, // session-only, by id+location
  disabledChecks: {},   // by finding id → true means disabled
};
// Internal — not user-tunable. App auto-applies confident edits and routes
// ambiguous ones to HUMAN_REVIEW automatically.
const INTERNAL_CONFIDENCE_THRESHOLD = 0.6;

// ---- Toast helper ----
function toast(message, durationMs = 1800) {
  const el = $("toast");
  if (!el) return;
  el.textContent = message;
  el.classList.remove("hidden");
  // Force reflow so transition runs
  void el.offsetWidth;
  el.classList.add("shown");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => {
    el.classList.remove("shown");
    setTimeout(() => el.classList.add("hidden"), 200);
  }, durationMs);
}
function loadSettings() {
  try {
    const stored = JSON.parse(localStorage.getItem("indesign-editor-settings") || "{}");
    return { ...DEFAULT_SETTINGS, ...stored };
  } catch (e) { return { ...DEFAULT_SETTINGS }; }
}
function saveSettings() {
  localStorage.setItem("indesign-editor-settings", JSON.stringify(settings));
}
let settings = loadSettings();

// ---- File pickers ----
function updateRunButton() {
  // Output folder is optional — defaults to the .indd's containing folder.
  $("runBtn").disabled = !(state.pdf && state.indd);
}
$("pickPdf").onclick = async () => {
  const p = await ipcRenderer.invoke("pick-file", [{ name: "PDF", extensions: ["pdf"] }]);
  if (p) { state.pdf = p; $("pdfPath").value = p; updateRunButton(); }
};
$("pickIndd").onclick = async () => {
  const p = await ipcRenderer.invoke("pick-file", [
    { name: "InDesign or Illustrator", extensions: ["indd", "ai"] },
    { name: "InDesign", extensions: ["indd"] },
    { name: "Illustrator", extensions: ["ai"] },
  ]);
  if (p) { state.indd = p; $("inddPath").value = p; updateRunButton(); }
};
$("pickHiResImages").onclick = async () => {
  const p = await ipcRenderer.invoke("pick-folder");
  if (p) { state.hiResImages = p; $("hiResImagesPath").value = p; }
};
$("pickOut").onclick = async () => {
  const p = await ipcRenderer.invoke("pick-folder");
  if (p) { state.out = p; $("outDir").value = p; updateRunButton(); }
};

// ---- Multi-file reference picker ----
const REF_EXTS = [{ name: "Reference assets", extensions: ["indd", "pdf", "ai", "psd", "jpg", "jpeg", "png", "tif", "tiff"] }];
function renderRefFiles() {
  const list = $("refFilesList");
  list.innerHTML = "";
  for (let i = 0; i < state.refFiles.length; i++) {
    const filePath = state.refFiles[i];
    const ext = filePath.split(".").pop().toLowerCase();
    const name = filePath.split("/").pop();
    const div = document.createElement("div");
    div.className = "ref-file";
    div.innerHTML = `<span class="badge">${ext}</span><span class="name" title="${filePath}">${name}</span><button class="remove" data-idx="${i}" title="Remove">×</button>`;
    list.appendChild(div);
  }
  list.querySelectorAll(".remove").forEach((btn) => {
    btn.onclick = () => { state.refFiles.splice(parseInt(btn.dataset.idx, 10), 1); renderRefFiles(); };
  });
}
$("addRefFile").onclick = async () => {
  const p = await ipcRenderer.invoke("pick-file", REF_EXTS);
  if (p && !state.refFiles.includes(p)) { state.refFiles.push(p); renderRefFiles(); }
};

// ====================== Data Merge mode ======================
function setMode(mode) {
  appMode = mode;
  document.querySelectorAll(".mode-tab").forEach((b) => {
    b.classList.toggle("active", b.dataset.mode === mode);
  });
  $("modeMarkup").classList.toggle("hidden", mode !== "markup");
  $("modeDataMerge").classList.toggle("hidden", mode !== "data_merge");
  $("modeTagTemplate").classList.toggle("hidden", mode !== "tag_template");
}
document.querySelectorAll(".mode-tab").forEach((b) => {
  b.onclick = () => setMode(b.dataset.mode);
});

function renderDmXlsxList() {
  const list = $("dmXlsxList");
  list.innerHTML = "";
  for (let i = 0; i < dmState.xlsx.length; i++) {
    const filePath = dmState.xlsx[i];
    const row = document.createElement("div");
    row.className = "ref-file-row";
    const nm = path.basename(filePath);
    row.innerHTML = `
      <span class="ref-file-name" title="${escapeHtml(filePath)}">${escapeHtml(nm)}</span>
      <button class="ref-file-remove" data-idx="${i}" title="Remove">×</button>
    `;
    list.appendChild(row);
  }
  list.querySelectorAll(".ref-file-remove").forEach((btn) => {
    btn.onclick = () => { dmState.xlsx.splice(parseInt(btn.dataset.idx, 10), 1); renderDmXlsxList(); updateDmRunButton(); };
  });
  updateDmRunButton();
}
function updateDmRunButton() {
  const haveData = dmState.source === "csv"
    ? !!dmState.csvPath
    : dmState.xlsx.length > 0;
  $("dmRunBtn").disabled = !(dmState.template && haveData && dmState.out);
}

$("dmPickTemplate").onclick = async () => {
  const p = await ipcRenderer.invoke("pick-file", [{ name: "InDesign template", extensions: ["indd"] }]);
  if (p) { dmState.template = p; $("dmTemplatePath").value = p; updateDmRunButton(); }
};
$("dmAddXlsx").onclick = async () => {
  const p = await ipcRenderer.invoke("pick-file", [{ name: "Excel", extensions: ["xlsx", "xls"] }]);
  if (p && !dmState.xlsx.includes(p)) { dmState.xlsx.push(p); renderDmXlsxList(); }
};
$("dmPickMaps").onclick = async () => {
  const p = await ipcRenderer.invoke("pick-folder");
  if (p) { dmState.mapsFolder = p; $("dmMapsFolder").value = p; }
};
$("dmPickOut").onclick = async () => {
  const p = await ipcRenderer.invoke("pick-folder");
  if (p) { dmState.out = p; $("dmOutDir").value = p; updateDmRunButton(); }
};
$("dmNameCol").addEventListener("input", (e) => { dmState.nameCol = e.target.value.trim() || "state"; });

// Data-source toggle: Excel files vs existing CSV
document.querySelectorAll('input[name="dmSource"]').forEach((r) => {
  r.onchange = () => {
    dmState.source = r.checked ? r.value : dmState.source;
    if (r.checked) {
      $("dmXlsxBlock").classList.toggle("hidden", r.value !== "xlsx");
      $("dmCsvBlock").classList.toggle("hidden", r.value !== "csv");
      updateDmRunButton();
    }
  };
});
$("dmPickCsv").onclick = async () => {
  const p = await ipcRenderer.invoke("pick-file", [{ name: "CSV", extensions: ["csv"] }]);
  if (p) { dmState.csvPath = p; $("dmCsvPath").value = p; updateDmRunButton(); }
};

$("dmRunBtn").onclick = async () => {
  $("dmRunBtn").disabled = true;
  $("progress").classList.remove("hidden");
  $("progressLog").textContent = "";
  $("progressBarFill").style.width = "5%";
  $("progressStep").textContent = "Starting Data Merge…";
  $("findings").classList.add("hidden");
  $("result").classList.add("hidden");

  const result = await ipcRenderer.invoke("run-orchestrator", {
    mode: "data_merge",
    templatePath: dmState.template,
    xlsxPaths: dmState.source === "xlsx" ? dmState.xlsx : [],
    csvPath:    dmState.source === "csv" ? dmState.csvPath : null,
    mapsFolder: dmState.mapsFolder || null,
    outputDir: dmState.out,
    nameColumn: dmState.nameCol || "state",
    settings: settings,
  });
  $("progressBarFill").style.width = "100%";
  $("progressStep").textContent = result.exitCode === 0 ? "Complete." : "Failed.";
  if (result.exitCode !== 0) {
    $("progressLog").textContent += "\n[ERROR] orchestrator exited with code " + result.exitCode + "\n" + (result.stderr || "");
    $("dmRunBtn").disabled = false;
    return;
  }
  // Show a summary panel
  const r = result.result || {};
  const generated = (r.generated_files || []).length;
  $("outIndd").textContent = `${generated} .indd file(s) in ${r.output_dir || dmState.out}`;
  $("outIndd").href = "file://" + (r.output_dir || dmState.out);
  $("outIndd").onclick = (e) => { e.preventDefault(); ipcRenderer.invoke("open-file", r.output_dir || dmState.out); };
  // Hide the PDF row in this mode
  const outPdfP = $("outPdf").parentElement;
  if (outPdfP) outPdfP.style.display = "none";
  $("result").classList.remove("hidden");
  $("dmRunBtn").disabled = false;
};

// ====================== Tag a Template mode ======================
function renderTtXlsxList() {
  const list = $("ttXlsxList");
  list.innerHTML = "";
  for (let i = 0; i < ttState.xlsx.length; i++) {
    const filePath = ttState.xlsx[i];
    const row = document.createElement("div");
    row.className = "ref-file-row";
    const nm = path.basename(filePath);
    row.innerHTML = `
      <span class="ref-file-name" title="${escapeHtml(filePath)}">${escapeHtml(nm)}</span>
      <button class="ref-file-remove" data-idx="${i}" title="Remove">×</button>
    `;
    list.appendChild(row);
  }
  list.querySelectorAll(".ref-file-remove").forEach((btn) => {
    btn.onclick = () => { ttState.xlsx.splice(parseInt(btn.dataset.idx, 10), 1); renderTtXlsxList(); updateTtRunButton(); };
  });
  updateTtRunButton();
}
function updateTtRunButton() {
  $("ttRunBtn").disabled = !(ttState.template && ttState.xlsx.length > 0);
}
$("ttPickTemplate").onclick = async () => {
  const p = await ipcRenderer.invoke("pick-file", [{ name: "InDesign template", extensions: ["indd"] }]);
  if (p) { ttState.template = p; $("ttTemplatePath").value = p; updateTtRunButton(); }
};
$("ttAddXlsx").onclick = async () => {
  const p = await ipcRenderer.invoke("pick-file", [{ name: "Excel", extensions: ["xlsx", "xls"] }]);
  if (p && !ttState.xlsx.includes(p)) { ttState.xlsx.push(p); renderTtXlsxList(); }
};
$("ttPickOut").onclick = async () => {
  // Pick a folder; the tagged copy goes there with "_TAGGED" appended to the name.
  const folder = await ipcRenderer.invoke("pick-folder");
  if (!folder) return;
  const base = path.basename(ttState.template || "template.indd");
  const stem = base.replace(/\.indd$/i, "");
  ttState.outPath = path.join(folder, `${stem}_TAGGED.indd`);
  $("ttOutPath").value = ttState.outPath;
};
$("ttRefState").addEventListener("input", (e) => {
  ttState.refState = e.target.value.trim() || "California";
});

$("ttRunBtn").onclick = async () => {
  $("ttRunBtn").disabled = true;
  $("progress").classList.remove("hidden");
  $("progressLog").textContent = "";
  $("progressBarFill").style.width = "5%";
  $("progressStep").textContent = "Auto-tagging template…";
  $("findings").classList.add("hidden");
  $("result").classList.add("hidden");

  const result = await ipcRenderer.invoke("run-orchestrator", {
    mode: "tag_template",
    templatePath: ttState.template,
    xlsxPaths: ttState.xlsx,
    refState: ttState.refState || "California",
    outputPath: ttState.outPath || null,
    settings: settings,
  });
  $("progressBarFill").style.width = "100%";
  $("progressStep").textContent = result.exitCode === 0 ? "Tagging complete." : "Tagging failed.";
  if (result.exitCode !== 0) {
    $("progressLog").textContent += "\n[ERROR] orchestrator exited with code " + result.exitCode + "\n" + (result.stderr || "");
    $("ttRunBtn").disabled = false;
    return;
  }
  const r = result.result || {};
  $("outIndd").textContent = r.template_output || ttState.outPath || ttState.template;
  $("outIndd").href = "file://" + (r.template_output || ttState.outPath || ttState.template);
  $("outIndd").onclick = (e) => { e.preventDefault(); ipcRenderer.invoke("open-file", r.template_output || ttState.outPath || ttState.template); };
  const outPdfP = $("outPdf").parentElement;
  if (outPdfP) outPdfP.style.display = "none";
  $("result").classList.remove("hidden");
  $("ttRunBtn").disabled = false;
};

// 508 compliance check — bind checkbox to settings, save on change
const run508 = $("run508Check");
if (run508) {
  run508.checked = !!settings.run508Check;
  run508.onchange = () => { settings.run508Check = run508.checked; saveSettings(); };
}

// Clear cache button (in Settings modal)
const clearCacheBtn = $("clearCache");
if (clearCacheBtn) {
  clearCacheBtn.onclick = async () => {
    const r = await ipcRenderer.invoke("clear-cache");
    if (r && r.ok) toast(`Cleared ${r.deleted} cached run(s)`);
    else toast("Cache clear failed: " + (r && r.error));
  };
}

// ---- Ollama detection: first-run popup + settings status/button ----
const OLLAMA_DOWNLOAD_URL = "https://ollama.com/download";

async function refreshOllamaStatus() {
  let info = { installed: false, hasModel: false, version: null, recommendedModel: "llama3.1:8b" };
  try { info = await ipcRenderer.invoke("check-ollama"); } catch (e) {}
  // Update settings panel status line
  const statusEl = $("ollamaStatus");
  const installBtn = $("installOllamaBtn");
  if (statusEl) {
    if (info.installed && info.hasModel) {
      statusEl.textContent = `Installed ${info.version || ""} — model present.`;
      if (installBtn) installBtn.textContent = "Update Ollama";
    } else if (info.installed) {
      statusEl.textContent = `Installed ${info.version || ""} — no model pulled yet. Run \`ollama pull ${info.recommendedModel}\` in Terminal.`;
      if (installBtn) installBtn.textContent = "Update Ollama";
    } else {
      statusEl.textContent = "Not installed.";
      if (installBtn) installBtn.textContent = "Install Ollama";
    }
  }
  return info;
}

const installOllamaBtn = $("installOllamaBtn");
if (installOllamaBtn) {
  installOllamaBtn.onclick = () => {
    ipcRenderer.invoke("open-external", OLLAMA_DOWNLOAD_URL);
    toast("Opening Ollama download page…");
    // Re-check after a short delay in case the user installs while the app stays open
    setTimeout(refreshOllamaStatus, 4000);
  };
}

// First-run popup: show only once if Ollama isn't installed.
const FIRST_RUN_KEY = "production-buddy-ollama-prompt-seen";
async function maybeShowOllamaFirstRun() {
  if (localStorage.getItem(FIRST_RUN_KEY) === "1") return;
  const info = await refreshOllamaStatus();
  if (info.installed) {
    // Already installed — no prompt needed; mark as seen.
    localStorage.setItem(FIRST_RUN_KEY, "1");
    return;
  }
  const modal = $("ollamaSetupModal");
  if (!modal) return;
  modal.classList.remove("hidden");
  const hide = () => {
    modal.classList.add("hidden");
    localStorage.setItem(FIRST_RUN_KEY, "1");
  };
  const installBtnFR = $("ollamaInstallBtn");
  const skipBtnFR = $("ollamaSkipBtn");
  if (installBtnFR) {
    installBtnFR.onclick = () => {
      ipcRenderer.invoke("open-external", OLLAMA_DOWNLOAD_URL);
      hide();
      toast("Opening Ollama download page…");
    };
  }
  if (skipBtnFR) {
    skipBtnFR.onclick = () => {
      // User chose rule-based only — disable Ollama in settings if it was on
      settings.useOllama = false;
      saveSettings();
      hide();
    };
  }
}

// Run on load (don't block startup)
setTimeout(maybeShowOllamaFirstRun, 500);

// ---- Drag & drop on each input zone ----
const fs = require("fs");

function setupDropZone(zoneEl, accept, onAccept) {
  // accept: function(filePath) → true/false based on extension
  // onAccept: function(filePath[]) — called with valid paths
  if (!zoneEl) return;
  let dragDepth = 0;
  zoneEl.addEventListener("dragenter", (e) => {
    e.preventDefault(); e.stopPropagation();
    dragDepth++;
    // Examine first dragged item to decide accept/reject preview (Electron exposes types but not paths during drag for security; we just always show drag-over)
    zoneEl.classList.add("drag-over");
  });
  zoneEl.addEventListener("dragover", (e) => {
    e.preventDefault(); e.stopPropagation();
    e.dataTransfer.dropEffect = "copy";
  });
  zoneEl.addEventListener("dragleave", (e) => {
    e.preventDefault(); e.stopPropagation();
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) zoneEl.classList.remove("drag-over", "drag-reject");
  });
  zoneEl.addEventListener("drop", (e) => {
    e.preventDefault(); e.stopPropagation();
    dragDepth = 0;
    zoneEl.classList.remove("drag-over", "drag-reject");
    const files = Array.from(e.dataTransfer.files || []);
    if (!files.length) return;
    const valid = [], rejected = [];
    for (const f of files) {
      // Electron 32+: use webUtils.getPathForFile (file.path removed for security)
      let p = null;
      try { p = webUtils && webUtils.getPathForFile ? webUtils.getPathForFile(f) : f.path; } catch (e) { p = f.path; }
      if (!p) continue;
      if (accept(p)) valid.push(p); else rejected.push(p);
    }
    if (rejected.length) {
      toast(`Rejected ${rejected.length} file(s) of wrong type`);
    }
    if (valid.length) onAccept(valid);
  });
}

const isPdf  = (p) => /\.pdf$/i.test(p);
const isIndd = (p) => /\.(indd|ai)$/i.test(p);
const isRefAsset = (p) => /\.(indd|pdf|ai|psd|jpg|jpeg|png|tif|tiff)$/i.test(p);
const isFolder = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };

// PDF zone
setupDropZone(
  $("pdfPath").closest(".step"),
  (p) => isPdf(p),
  (paths) => { state.pdf = paths[0]; $("pdfPath").value = paths[0]; updateRunButton(); toast("PDF loaded"); }
);

// INDD zone
setupDropZone(
  $("inddPath").closest(".step"),
  (p) => isIndd(p),
  (paths) => {
    state.indd = paths[0]; $("inddPath").value = paths[0]; updateRunButton();
    const isAi = /\.ai$/i.test(paths[0]);
    toast(isAi ? "Illustrator artwork loaded" : "InDesign doc loaded");
  }
);

// Output folder zone — accepts a directory drop, OR if a file is dropped, uses its containing folder
setupDropZone(
  $("outDir").closest(".step"),
  (p) => isFolder(p) || true, // accept anything; we'll resolve to dir below
  (paths) => {
    let dir = paths[0];
    if (!isFolder(dir)) {
      try { dir = path.dirname(dir); } catch (e) { return; }
    }
    state.out = dir;
    $("outDir").value = dir;
    updateRunButton();
    toast("Output folder set");
  }
);

// Reference files zone — accepts multiple, all asset types
setupDropZone(
  document.querySelector("#refFilesList").closest(".step"),
  (p) => isRefAsset(p),
  (paths) => {
    let added = 0;
    for (const p of paths) {
      if (!state.refFiles.includes(p)) { state.refFiles.push(p); added++; }
    }
    renderRefFiles();
    if (added > 0) toast(`Added ${added} reference file${added === 1 ? "" : "s"}`);
  }
);

// Hi-res images folder zone — folder drop only (or any file → use parent dir)
setupDropZone(
  $("hiResImagesPath").closest(".step"),
  (p) => true,
  (paths) => {
    let dir = paths[0];
    if (!isFolder(dir)) {
      try { dir = path.dirname(dir); } catch (e) { return; }
    }
    state.hiResImages = dir;
    $("hiResImagesPath").value = dir;
    toast("Hi-res images folder set");
  }
);

const isXlsx = (p) => /\.(xlsx|xls)$/i.test(p);
const isCsv  = (p) => /\.csv$/i.test(p);

// ---- Batch Data Merge tab drop zones ----
setupDropZone(
  $("dmTemplatePath").closest(".step"),
  (p) => isIndd(p),
  (paths) => { dmState.template = paths[0]; $("dmTemplatePath").value = paths[0]; updateDmRunButton(); toast("Template loaded"); }
);
setupDropZone(
  $("dmXlsxList").closest(".step"),
  (p) => isXlsx(p) || isCsv(p),
  (paths) => {
    // CSV drop → switch source to CSV; xlsx drop → switch to xlsx & append
    const csvFiles  = paths.filter(isCsv);
    const xlsxFiles = paths.filter(isXlsx);
    if (csvFiles.length) {
      dmState.source = "csv";
      dmState.csvPath = csvFiles[0];
      $("dmCsvPath").value = csvFiles[0];
      document.querySelector('input[name="dmSource"][value="csv"]').checked = true;
      $("dmXlsxBlock").classList.add("hidden");
      $("dmCsvBlock").classList.remove("hidden");
      toast("CSV loaded");
    } else if (xlsxFiles.length) {
      dmState.source = "xlsx";
      document.querySelector('input[name="dmSource"][value="xlsx"]').checked = true;
      $("dmXlsxBlock").classList.remove("hidden");
      $("dmCsvBlock").classList.add("hidden");
      let added = 0;
      for (const p of xlsxFiles) {
        if (!dmState.xlsx.includes(p)) { dmState.xlsx.push(p); added++; }
      }
      renderDmXlsxList();
      if (added) toast(`Added ${added} Excel file${added === 1 ? "" : "s"}`);
    }
    updateDmRunButton();
  }
);
setupDropZone(
  $("dmMapsFolder").closest(".step"),
  (p) => true,
  (paths) => {
    let dir = paths[0];
    if (!isFolder(dir)) { try { dir = path.dirname(dir); } catch { return; } }
    dmState.mapsFolder = dir; $("dmMapsFolder").value = dir; toast("Maps folder set");
  }
);
setupDropZone(
  $("dmOutDir").closest(".step"),
  (p) => true,
  (paths) => {
    let dir = paths[0];
    if (!isFolder(dir)) { try { dir = path.dirname(dir); } catch { return; } }
    dmState.out = dir; $("dmOutDir").value = dir; updateDmRunButton(); toast("Output folder set");
  }
);

// ---- Tag a Template tab drop zones ----
setupDropZone(
  $("ttTemplatePath").closest(".step"),
  (p) => isIndd(p),
  (paths) => { ttState.template = paths[0]; $("ttTemplatePath").value = paths[0]; updateTtRunButton(); toast("Template loaded"); }
);
setupDropZone(
  $("ttXlsxList").closest(".step"),
  (p) => isXlsx(p),
  (paths) => {
    let added = 0;
    for (const p of paths) {
      if (!ttState.xlsx.includes(p)) { ttState.xlsx.push(p); added++; }
    }
    renderTtXlsxList();
    if (added) toast(`Added ${added} Excel file${added === 1 ? "" : "s"}`);
  }
);
setupDropZone(
  $("ttOutPath").closest(".step"),
  (p) => true,
  (paths) => {
    let dir = paths[0];
    if (!isFolder(dir)) { try { dir = path.dirname(dir); } catch { return; } }
    const base = path.basename(ttState.template || "template.indd");
    const stem = base.replace(/\.indd$/i, "");
    ttState.outPath = path.join(dir, `${stem}_TAGGED.indd`);
    $("ttOutPath").value = ttState.outPath;
    toast("Output folder set");
  }
);

// Prevent the window itself from navigating when files are dropped outside zones
window.addEventListener("dragover", (e) => { e.preventDefault(); });
window.addEventListener("drop", (e) => { e.preventDefault(); });

// ---- Progress bar driver ----
const STEP_PROGRESS = [
  { match: /step 1: extracting/i,           pct: 8,  label: "Extracting PDF annotations…" },
  { match: /step 2: inspecting document/i,  pct: 18, label: "Inspecting InDesign document…" },
  { match: /step 2\.5: inspecting reference/i, pct: 26, label: "Inspecting reference files…" },
  { match: /step 3a: rule-based/i,          pct: 35, label: "Classifying via rule-based parser…" },
  { match: /step 3b: Ollama/i,              pct: 50, label: "Escalating unresolved annotations to Ollama…" },
  { match: /step 4: applying edits/i,       pct: 65, label: "Applying edits in InDesign…" },
  { match: /STEP 3: post-edit/i,            pct: 78, label: "Canonicalizing layout…" },
  { match: /STEP 4: comprehensive QA scan/i, pct: 85, label: "Running QA scan…" },
  { match: /step 5: Python/i,               pct: 90, label: "Running Python QA checks…" },
  { match: /step 6: auto-relinking/i,       pct: 92, label: "Auto-relinking missing assets from Box…" },
  { match: /step 7: font activation/i,      pct: 95, label: "Activating missing fonts via FontExplorer / Adobe Fonts…" },
  { match: /STEP 5: saving/i,               pct: 96, label: "Saving and exporting…" },
  { match: /done/i,                         pct: 100, label: "Complete." },
];
function updateProgressFromText(text) {
  for (const s of STEP_PROGRESS) {
    if (s.match.test(text)) {
      $("progressBarFill").style.width = s.pct + "%";
      $("progressStep").textContent = s.label;
      break;
    }
  }
}
ipcRenderer.on("orchestrator-progress", (_evt, text) => {
  const log = $("progressLog");
  log.textContent += text;
  log.scrollTop = log.scrollHeight;
  updateProgressFromText(text);
});

// ---- Run pipeline ----
$("runBtn").onclick = async () => {
  $("runBtn").disabled = true;
  $("progress").classList.remove("hidden");
  $("progressLog").textContent = "";
  $("progressBarFill").style.width = "2%";
  $("progressStep").textContent = "Starting…";
  $("findings").classList.add("hidden");
  $("result").classList.add("hidden");

  // Default output folder = same folder as the .indd
  const outputDir = state.out || path.dirname(state.indd);
  const result = await ipcRenderer.invoke("run-orchestrator", {
    pdfPath: state.pdf,
    inddPath: state.indd,
    outputDir: outputDir,
    refFiles: state.refFiles,
    hiResImagesFolder: state.hiResImages,
    settings: settings,
  });

  $("progressBarFill").style.width = "100%";
  $("progressStep").textContent = result.exitCode === 0 ? "Complete." : "Failed.";

  if (result.exitCode !== 0) {
    $("progressLog").textContent += "\n\n[ERROR] orchestrator exited with code " + result.exitCode + "\n" + result.stderr;
    $("runBtn").disabled = false;
    return;
  }

  if (result.findings && result.findings.findings) {
    window.__findings = result.findings.findings;
    renderSummary(result.findings.findings);
    renderFindings(result.findings.findings);
    $("findings").classList.remove("hidden");
  }

  // Use the version-bumped paths returned by the orchestrator, with fallback
  let outIndd, outPdf;
  if (result.result && result.result.indd_out && result.result.pdf_out) {
    outIndd = result.result.indd_out;
    outPdf = result.result.pdf_out;
  } else {
    const baseName = path.basename(state.indd, ".indd") + "_AI_EDITED";
    outIndd = path.join(outputDir, baseName + ".indd");
    outPdf = path.join(outputDir, baseName + ".pdf");
  }
  // Expose to finding-action handlers
  window.__outIndd = outIndd;
  window.__outPdf = outPdf;
  $("outIndd").textContent = outIndd;
  $("outIndd").href = "file://" + outIndd;
  $("outIndd").onclick = (e) => { e.preventDefault(); ipcRenderer.invoke("open-file", outIndd); };
  $("outPdf").textContent = outPdf;
  $("outPdf").href = "file://" + outPdf;
  $("outPdf").onclick = (e) => { e.preventDefault(); ipcRenderer.invoke("open-file", outPdf); };
  $("result").classList.remove("hidden");

  if (settings.autoOpenPdf) ipcRenderer.invoke("open-file", outPdf);
  if (settings.autoOpenIndd) ipcRenderer.invoke("open-file", outIndd);

  $("runBtn").disabled = false;
};

// ---- Findings rendering with actions + explanations ----
function findingKey(f) { return f.id + "::" + (f.location || ""); }

function renderSummary(findings) {
  const counts = { error: 0, warning: 0, info: 0 };
  for (const f of findings) counts[f.severity] = (counts[f.severity] || 0) + 1;
  $("summaryBar").innerHTML = `
    <div class="summary-pill error">${counts.error} Error${counts.error === 1 ? "" : "s"}</div>
    <div class="summary-pill warning">${counts.warning} Warning${counts.warning === 1 ? "" : "s"}</div>
    <div class="summary-pill info">${counts.info} Info</div>
  `;
}

function renderFindings(findings) {
  const list = $("findingsList");
  const showErr = $("filtErr").checked, showWarn = $("filtWarn").checked, showInfo = $("filtInfo").checked;
  const hideResolved = $("hideResolved").checked, hideIgnored = $("hideIgnored").checked;
  list.innerHTML = "";
  let shown = 0;
  // Group by severity: error → warning → info
  const order = { error: 0, warning: 1, info: 2 };
  const sorted = [...findings].sort((a, b) => (order[a.severity] || 9) - (order[b.severity] || 9));
  for (const f of sorted) {
    if (f.severity === "error" && !showErr) continue;
    if (f.severity === "warning" && !showWarn) continue;
    if (f.severity === "info" && !showInfo) continue;
    const key = findingKey(f);
    const isResolved = !!settings.resolvedFindings[key];
    const isIgnored = settings.ignoredFindingIds.includes(f.id);
    if (hideResolved && isResolved) continue;
    if (hideIgnored && isIgnored) continue;

    const meta = (typeof FINDING_META !== "undefined" && FINDING_META[f.id]) || null;
    const div = document.createElement("div");
    div.className = "finding " + f.severity + (isResolved ? " resolved" : "") + (isIgnored ? " ignored" : "");
    div.innerHTML = `
      <div class="meta">${f.severity} · ${f.category} · ${f.id}</div>
      <div class="head">${escapeHtml(meta ? meta.title : f.message)}</div>
      ${meta ? "" : `<div class="meta">${escapeHtml(f.message)}</div>`}
      <div class="meta" style="opacity:0.6">${escapeHtml(f.location || "")}</div>
      ${f.fixAction ? `<div class="action">↳ ${escapeHtml(f.fixAction)}</div>` : ""}
      <div class="finding-explanation">
        ${meta ? `
          <div><span class="label">What this means</span><br/>${escapeHtml(meta.plain)}</div>
          <br/>
          <div><span class="label">How to fix</span><br/>${escapeHtml(meta.fix)}</div>
          <br/>
          <div><span class="label">Detail</span><br/>${escapeHtml(f.message)}</div>
        ` : `<div><span class="label">Detail</span><br/>${escapeHtml(f.message)}</div>`}
      </div>
      <div class="finding-actions">
        <button class="action-btn primary" data-act="open-indd">Open in InDesign</button>
        <button class="action-btn" data-act="more">${meta ? "More info ▾" : "Details ▾"}</button>
        <button class="action-btn" data-act="resolve">${isResolved ? "Unresolve" : "Mark resolved"}</button>
        <button class="action-btn danger" data-act="ignore">${isIgnored ? "Un-ignore" : "Ignore future"}</button>
      </div>
    `;
    div.querySelectorAll(".action-btn").forEach((btn) => {
      btn.onclick = (e) => {
        e.stopPropagation();
        const act = btn.dataset.act;
        if (act === "open-indd") {
          // Use the actual output path from the orchestrator's result.json
          if (window.__outIndd) {
            ipcRenderer.invoke("open-file", window.__outIndd);
          } else {
            toast("No output file yet — run the pipeline first.");
          }
        } else if (act === "more") {
          const exp = div.querySelector(".finding-explanation");
          exp.classList.toggle("shown");
          btn.textContent = exp.classList.contains("shown") ? (meta ? "Hide info ▴" : "Hide ▴") : (meta ? "More info ▾" : "Details ▾");
        } else if (act === "resolve") {
          if (isResolved) delete settings.resolvedFindings[key];
          else settings.resolvedFindings[key] = Date.now();
          saveSettings();
          renderFindings(window.__findings);
        } else if (act === "ignore") {
          if (isIgnored) settings.ignoredFindingIds = settings.ignoredFindingIds.filter((x) => x !== f.id);
          else settings.ignoredFindingIds.push(f.id);
          saveSettings();
          renderFindings(window.__findings);
        }
      };
    });
    list.appendChild(div);
    shown++;
  }
  if (shown === 0) {
    list.innerHTML = '<div class="finding info"><div class="head">All findings handled. ✓</div></div>';
  }
}

function escapeHtml(s) {
  return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

["filtErr", "filtWarn", "filtInfo", "hideResolved", "hideIgnored"].forEach((id) => {
  $(id).onchange = () => { if (window.__findings) renderFindings(window.__findings); };
});

// ---- Settings modal ----
function openSettings() {
  $("setUseOllama").checked = settings.useOllama;
  $("setOllamaModel").value = settings.ollamaModel || "llama3.1:8b";
  $("setMinDpi").value = settings.minDpi;
  $("setMaxFonts").value = settings.maxFonts;
  $("setBodySize").value = settings.bodySize;
  $("setAutoRelink").checked = settings.autoRelink !== false;
  $("setAutoActivateFonts").checked = settings.autoActivateFonts !== false;
  $("setAutoOpenPdf").checked = settings.autoOpenPdf;
  $("setAutoOpenIndd").checked = settings.autoOpenIndd;
  $("setShowInfoFindings").checked = settings.showInfoFindings;
  $("setCacheRetention").value = settings.cacheRetention || 10;
  // QA check toggles
  const grid = $("checkToggles");
  grid.innerHTML = "";
  const meta = window.FINDING_META;
  if (meta) {
    Object.keys(meta).forEach((id) => {
      const m = meta[id];
      if (m.canAutoFix) return; // auto-fixes are silent cleanup, not toggleable detection
      const label = document.createElement("label");
      label.className = "check-row";
      const checked = !settings.disabledChecks[id];
      label.innerHTML = `<input type="checkbox" data-id="${id}" ${checked ? "checked" : ""} /> <span>${escapeHtml(m.title)} <span style="opacity:0.4;font-size:10px">(${id})</span></span>`;
      grid.appendChild(label);
    });
  } else {
    grid.innerHTML = '<div style="color:var(--text-tertiary);font-size:12px">FINDING_META not loaded — try restarting the app.</div>';
  }
  // Ignored findings list
  const ig = $("ignoredList");
  if (settings.ignoredFindingIds.length === 0) {
    ig.innerHTML = "No ignored findings.";
  } else {
    ig.innerHTML = settings.ignoredFindingIds.map((id) => `<span class="ignored-tag">${escapeHtml(id)}</span>`).join("");
  }
  $("settingsModal").classList.remove("hidden");
  // Refresh the Ollama status line every time the modal opens
  refreshOllamaStatus();
}
function closeSettings() { $("settingsModal").classList.add("hidden"); }

// Robust hookup — re-bind on every modal open in case of re-render edge cases
$("settingsBtn").addEventListener("click", openSettings);
$("closeSettings").addEventListener("click", (e) => { e.stopPropagation(); closeSettings(); });
$("settingsModal").addEventListener("click", (e) => {
  if (e.target.id === "settingsModal") closeSettings(); // backdrop click only
});

$("saveSettings").addEventListener("click", () => {
  settings.useOllama = $("setUseOllama").checked;
  settings.ollamaModel = ($("setOllamaModel").value || "llama3.1:8b").trim();
  settings.minDpi = Number($("setMinDpi").value);
  settings.maxFonts = Number($("setMaxFonts").value);
  settings.bodySize = Number($("setBodySize").value);
  settings.autoRelink = $("setAutoRelink").checked;
  settings.autoActivateFonts = $("setAutoActivateFonts").checked;
  settings.autoOpenPdf = $("setAutoOpenPdf").checked;
  settings.autoOpenIndd = $("setAutoOpenIndd").checked;
  settings.showInfoFindings = $("setShowInfoFindings").checked;
  settings.cacheRetention = Math.max(1, Math.min(100, Number($("setCacheRetention").value) || 10));
  // Apply disabledChecks
  $("checkToggles").querySelectorAll("input[type='checkbox']").forEach((cb) => {
    const id = cb.dataset.id;
    if (cb.checked) delete settings.disabledChecks[id];
    else settings.disabledChecks[id] = true;
  });
  saveSettings();
  $("filtInfo").checked = settings.showInfoFindings;
  if (window.__findings) renderFindings(window.__findings);
  closeSettings();
  toast("Settings saved ✓");
});

$("resetSettings").addEventListener("click", () => {
  if (!confirm("Reset all settings to defaults?")) return;
  settings = { ...DEFAULT_SETTINGS };
  saveSettings();
  openSettings(); // re-render with defaults
  toast("Reset to defaults");
});

// Detect installed Ollama models and show them in the hint
$("detectOllamaModels").addEventListener("click", async () => {
  const hint = $("ollamaModelsHint");
  hint.textContent = "Querying Ollama…";
  try {
    const resp = await fetch("http://localhost:11434/api/tags");
    if (!resp.ok) { hint.textContent = "Ollama not reachable (is the daemon running?)"; return; }
    const data = await resp.json();
    const models = (data.models || []).map(m => m.name).filter(Boolean);
    if (!models.length) {
      hint.textContent = "No models installed. Run: ollama pull llama3.1:8b";
      return;
    }
    hint.innerHTML = "Installed: " + models.map(m => `<code style="cursor:pointer;text-decoration:underline" data-m="${m}">${m}</code>`).join(", ") + " — click to use";
    hint.querySelectorAll("code[data-m]").forEach(el => {
      el.onclick = () => { $("setOllamaModel").value = el.dataset.m; toast("Selected " + el.dataset.m); };
    });
  } catch (e) {
    hint.textContent = "Couldn't reach Ollama at localhost:11434. Run `ollama serve` or `brew services start ollama`.";
  }
});

$("clearIgnored").onclick = () => {
  settings.ignoredFindingIds = [];
  saveSettings();
  $("ignoredList").innerHTML = "No ignored findings.";
  if (window.__findings) renderFindings(window.__findings);
};

// Apply showInfoFindings on load
if (settings.showInfoFindings) $("filtInfo").checked = true;
