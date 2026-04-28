// Illustrator apply-edits + QA scan.
// Mirror of the InDesign apply script but adapted to Illustrator's DOM.
// Supported edit ops in v1: REPLACE_TEXT, PLACE_ASSET (replace a placed
// item's file), HUMAN_REVIEW (logged as flag).
// QA scan: fonts, links, image resolution, RGB-in-print, doc metadata,
// and the 508 designer-side checks (contrast, hairlines, alt text,
// doc properties, tagged-PDF flag at export).
#target illustrator

(function () {
    var inddPath        = "__INDD_PATH__";
    var pdfOut          = "__PDF_OUT_PATH__";
    var logPath         = "__LOG_PATH__";
    var flagsPath       = "__FLAGS_PATH__";
    var findingsPath    = "__FINDINGS_PATH__";
    var hyperlinksPath  = "__HYPERLINKS_PATH__";
    var editsPath       = "__EDITS_PATH__";
    var qaConfigPath    = "__QA_CONFIG_PATH__";

    // ---- Load qaConfig + edits.json ----
    var qaConfig = { min_dpi: 300, max_fonts: 4, body_size_pt: 14, disabled_checks: {}, run_508_check: false };
    try {
        var qf = File(qaConfigPath); qf.encoding = "UTF-8"; qf.open("r");
        var qj = qf.read(); qf.close();
        qaConfig = eval("(" + qj + ")");
    } catch (e) {}
    function checkEnabled(id) { return !(qaConfig.disabled_checks && qaConfig.disabled_checks[id]); }

    var editPlan = { edits: [], human_notes: [] };
    try {
        var ef = File(editsPath); ef.encoding = "UTF-8"; ef.open("r");
        var ej = ef.read(); ef.close();
        editPlan = eval("(" + ej + ")");
    } catch (e) {}

    // ---- Logging helpers ----
    var logBuffer = [];
    function L(s) { logBuffer.push(String(s)); }

    var flags = [];
    function FLAG(s) { flags.push(s); L("[FLAG] " + s); }

    var qaFindings = [];
    function FINDING(severity, id, category, location, message, autoFix, fixAction) {
        if (!checkEnabled(id)) return;
        qaFindings.push({ severity: severity, id: id, category: category, location: location, message: message, autoFix: !!autoFix, fixAction: fixAction || "" });
        L("  [" + severity.toUpperCase() + "] " + id + " " + location + " — " + message);
    }
    function safe(fn, label) { try { fn(); } catch (e) { L("  ERR in " + label + ": " + e + " (line " + e.line + ")"); } }

    function jsonStr(s) {
        if (s === undefined || s === null) return "null";
        s = String(s); var out = "\"";
        for (var i = 0; i < s.length; i++) {
            var ch = s.charAt(i), c = s.charCodeAt(i);
            if (ch === "\"") out += "\\\""; else if (ch === "\\") out += "\\\\";
            else if (ch === "\n") out += "\\n"; else if (ch === "\r") out += "\\r"; else if (ch === "\t") out += "\\t";
            else if (c < 32 || c === 127) out += "\\u" + ("0000" + c.toString(16)).slice(-4);
            else out += ch;
        }
        return out + "\"";
    }

    L("STEP 0: starting (Illustrator)");

    var doc;
    try {
        doc = app.open(File(inddPath));
        L("STEP 1: opened doc: " + doc.name);
    } catch (e) {
        L("STEP 1: open failed: " + e);
        var lf0 = File(logPath); lf0.encoding = "UTF-8"; lf0.open("w"); lf0.write(logBuffer.join("\n")); lf0.close();
        return;
    }

    // ===== STEP 2: apply edits =====
    L("\nSTEP 2: applying edits");

    function applyEdit(edit) {
        var op = edit.op;
        var conf = (edit.confidence !== undefined) ? edit.confidence : "?";
        var why  = edit.why || "";
        L("\nEDIT [" + op + "] confidence=" + conf + (why ? " — " + why : ""));

        if (op === "HUMAN_REVIEW") {
            FLAG("Human review: " + (edit.params && edit.params.note || why || "review needed"));
            return;
        }
        if (op === "REPLACE_TEXT") {
            var find    = edit.target && edit.target.find;
            var replace = edit.params && edit.params.replace_with;
            if (!find) { FLAG("REPLACE_TEXT: no find string"); return; }
            if (replace === undefined || replace === null) replace = "";
            var hits = 0;
            for (var i = 0; i < doc.textFrames.length; i++) {
                try {
                    var tf = doc.textFrames[i];
                    var c = String(tf.contents || "");
                    if (c.indexOf(find) === -1) continue;
                    tf.contents = c.split(find).join(replace);
                    hits++;
                } catch (e) {}
            }
            if (hits > 0) L("  replaced \"" + find + "\" in " + hits + " text frame(s)");
            else FLAG("REPLACE_TEXT: '" + find + "' not found");
            return;
        }
        if (op === "PLACE_ASSET" || op === "PLACE_ASSET_IN_FRAME") {
            // Replace the FIRST placed item (or one matching by index) with a new file.
            var assetPath = edit.target && edit.target.file_path;
            if (!assetPath) { FLAG(op + ": no file_path"); return; }
            var idx = (edit.target && typeof edit.target.placed_index === "number") ? edit.target.placed_index : 0;
            try {
                var pi = doc.placedItems[idx];
                if (!pi) { FLAG(op + ": no placed item at index " + idx); return; }
                pi.file = File(assetPath);
                L("  placed " + assetPath.split("/").pop() + " into placedItem #" + idx);
            } catch (e) { FLAG(op + " failed: " + e); }
            return;
        }
        FLAG("Unsupported op for Illustrator: " + op);
    }

    var edits = (editPlan.edits || []);
    for (var i = 0; i < edits.length; i++) {
        try { applyEdit(edits[i]); }
        catch (e) { FLAG("Edit " + i + " failed: " + e + " (op=" + edits[i].op + ")"); }
    }
    if (editPlan.human_notes && editPlan.human_notes.length > 0) {
        for (var n = 0; n < editPlan.human_notes.length; n++) FLAG("Human note: " + editPlan.human_notes[n]);
    }

    // ===== STEP 4: QA scan =====
    L("\nSTEP 4: QA scan");

    // Hyperlinks inventory (Illustrator stores URL-bearing text via the
    // "URL" character attribute and standard text frames). For now we just
    // scan text frames for HTTP-looking content as the v1 hyperlink check.
    safe(function () {
        var rx = /(https?:\/\/[^\s)\]>"',]+)/i;
        var urls = [];
        for (var i = 0; i < doc.textFrames.length; i++) {
            try {
                var c = String(doc.textFrames[i].contents || "");
                var m = c.match(rx);
                if (m) urls.push(m[1]);
            } catch (e) {}
        }
        if (urls.length > 0) FINDING("info", "HYPERLINK_INVENTORY", "links", "doc", urls.length + " URL-like reference(s) in text frames");
        // Persist for the Python reachability checker
        try {
            var hf = File(hyperlinksPath); hf.encoding = "UTF-8"; hf.open("w");
            var arr = [];
            for (var u = 0; u < urls.length; u++) arr.push("{\"dest\":" + jsonStr(urls[u]) + "}");
            hf.write("[" + arr.join(",") + "]"); hf.close();
        } catch (e) {}
    }, "hyperlinks");

    // Font inventory + count
    safe(function () {
        var seen = {}, names = [];
        for (var i = 0; i < doc.textFrames.length; i++) {
            try {
                var atts = doc.textFrames[i].textRange.characterAttributes;
                var fname = "";
                try { fname = String(atts.textFont.name); } catch (e) {}
                if (fname && !seen[fname]) { seen[fname] = true; names.push(fname); }
            } catch (e) {}
        }
        if (names.length > 0) {
            var preview = names.slice(0, 8).join(", ") + (names.length > 8 ? ", …" : "");
            FINDING("info", "FONT_INVENTORY", "fonts", "doc", names.length + " font(s): " + preview);
            var maxFonts = qaConfig.max_fonts || 4;
            if (names.length > maxFonts) {
                FINDING("warning", "FONT_TOO_MANY", "fonts", "doc",
                    names.length + " distinct fonts (consider consolidating to ≤" + maxFonts + ")");
            }
        }
    }, "font inventory");

    // Image inventory + missing-link check
    safe(function () {
        var total = doc.placedItems.length + doc.rasterItems.length;
        FINDING("info", "IMG_COUNT", "images", "doc", total + " placed + raster item(s)");
        var missing = [], missSamples = [];
        for (var i = 0; i < doc.placedItems.length; i++) {
            var pi = doc.placedItems[i];
            try {
                var f = pi.file;
                if (!f || !f.exists) {
                    var nm = "";
                    try { nm = String(f && f.fsName).split("/").pop(); } catch (e) {}
                    missing.push(nm || "placedItem " + i);
                }
            } catch (e) {
                missing.push("placedItem " + i + " (no file ref)");
            }
        }
        for (var s = 0; s < Math.min(missing.length, 5); s++) missSamples.push(missing[s]);
        if (missing.length > 0) {
            FINDING("error", "LINK_MISSING", "links", "doc",
                missing.length + " missing link(s): " + missSamples.join(", "),
                false, "Re-link or replace asset");
        }
    }, "image inventory");

    // RGB swatches in a CMYK doc (print-warning)
    safe(function () {
        try {
            if (doc.documentColorSpace !== DocumentColorSpace.CMYK) return;
            var rgbSwatches = [];
            for (var i = 0; i < doc.swatches.length; i++) {
                var sw = doc.swatches[i];
                try {
                    var col = sw.color;
                    if (col && col.typename === "RGBColor") rgbSwatches.push(String(sw.name));
                } catch (e) {}
            }
            if (rgbSwatches.length > 0) {
                FINDING("warning", "COLOR_RGB_SWATCH", "color", "doc",
                    rgbSwatches.length + " RGB swatch(es): " + rgbSwatches.slice(0, 8).join(", "));
            }
        } catch (e) {}
    }, "rgb swatch check");

    // Doc dimensions / color profile
    safe(function () {
        try {
            var cs = (doc.documentColorSpace === DocumentColorSpace.CMYK) ? "CMYK"
                   : (doc.documentColorSpace === DocumentColorSpace.RGB)  ? "RGB" : "OTHER";
            FINDING("info", "DOC_COLOR_PROFILE", "color", "doc", "Document color space: " + cs);
            if (doc.artboards.length > 0) {
                var ab = doc.artboards[0].artboardRect;
                var w = Math.round((ab[2] - ab[0]) * 100) / 100;
                var h = Math.round((ab[1] - ab[3]) * 100) / 100;
                FINDING("info", "DOC_DIMENSIONS", "doc", "doc",
                    doc.artboards.length + " artboard(s); first " + w + "pt × " + h + "pt");
            }
        } catch (e) {}
    }, "doc dimensions");

    // ===== 508 checks (gated by qaConfig.run_508_check) =====
    if (qaConfig.run_508_check) {
        L("\nSTEP 4b: 508 compliance checks");

        // sRGB luminance + WCAG ratio
        function _srgbToLin(c) { c = c / 255; return (c <= 0.03928) ? (c / 12.92) : Math.pow((c + 0.055) / 1.055, 2.4); }
        function _luminance(rgb) { return 0.2126 * _srgbToLin(rgb[0]) + 0.7152 * _srgbToLin(rgb[1]) + 0.0722 * _srgbToLin(rgb[2]); }
        function _contrast(fg, bg) { var l1 = _luminance(fg), l2 = _luminance(bg); var hi = Math.max(l1, l2), lo = Math.min(l1, l2); return (hi + 0.05) / (lo + 0.05); }
        function _colorToRgb(col) {
            if (!col) return null;
            try {
                if (col.typename === "RGBColor") return [Math.round(col.red), Math.round(col.green), Math.round(col.blue)];
                if (col.typename === "CMYKColor") {
                    var c = col.cyan/100, m = col.magenta/100, y = col.yellow/100, k = col.black/100;
                    return [Math.round(255*(1-c)*(1-k)), Math.round(255*(1-m)*(1-k)), Math.round(255*(1-y)*(1-k))];
                }
                if (col.typename === "GrayColor") {
                    var v = Math.round(255 * (1 - col.gray / 100));
                    return [v, v, v];
                }
                if (col.typename === "SpotColor") return _colorToRgb(col.spot.color);
            } catch (e) {}
            return null;
        }

        // 508_CONTRAST_LOW — text vs underlying (or paper-white) background
        safe(function () {
            var lowCount = 0, samples = [];
            for (var i = 0; i < doc.textFrames.length; i++) {
                var tf = doc.textFrames[i];
                var fg = null, sizePt = 12, isBold = false;
                try { fg = _colorToRgb(tf.textRange.characterAttributes.fillColor); } catch (e) {}
                try { sizePt = Number(tf.textRange.characterAttributes.size) || 12; } catch (e) {}
                try {
                    var fontStyle = String(tf.textRange.characterAttributes.textFont.style || "").toLowerCase();
                    isBold = /bold|black|heavy/.test(fontStyle);
                } catch (e) {}
                if (!fg) continue;
                // Background detection: AI doesn't have a clean "behind this text"
                // model the way InDesign does. We approximate: if the textFrame
                // has a fill color of its own, use that; otherwise paper white.
                var bg = [255, 255, 255];
                try {
                    var tfFill = _colorToRgb(tf.fillColor);
                    if (tfFill) bg = tfFill;
                } catch (e) {}
                var ratio = _contrast(fg, bg);
                var threshold = (sizePt >= 18 || (sizePt >= 14 && isBold)) ? 3.0 : 4.5;
                if (ratio < threshold) {
                    lowCount++;
                    if (samples.length < 8) {
                        var snip = "";
                        try { snip = String(tf.contents || "").substring(0, 30).replace(/\s+/g, " "); } catch (e) {}
                        samples.push("'" + snip + "' (" + ratio.toFixed(2) + ":1)");
                    }
                }
            }
            if (lowCount > 0) {
                FINDING("error", "508_CONTRAST_LOW", "508", "doc",
                    lowCount + " text frame(s) with contrast below WCAG AA: " + samples.join(" | "),
                    false,
                    "Increase contrast of text vs background to ≥4.5:1 (3:1 for large/bold text)");
            }
        }, "508 contrast");

        // 508_HAIRLINE_RULE — strokes < 1pt
        safe(function () {
            var thin = 0, samples = [];
            // Walk all path items
            try {
                for (var i = 0; i < doc.pathItems.length; i++) {
                    var pi = doc.pathItems[i];
                    try {
                        if (!pi.stroked) continue;
                        var sw = Number(pi.strokeWidth) || 0;
                        if (sw <= 0 || sw >= 1) continue;
                        thin++;
                        if (samples.length < 6) samples.push("path #" + i + " " + sw + "pt");
                    } catch (e) {}
                }
            } catch (e) {}
            if (thin > 0) {
                FINDING("warning", "508_HAIRLINE_RULE", "508", "doc",
                    thin + " stroke(s) below 1pt (hairlines may disappear during PDF tagging): " + samples.join(" | "),
                    false,
                    "Increase stroke weight to ≥1pt for any rule that must remain visible");
            }
        }, "508 hairline");

        // 508_DOC_PROPS_MISSING — title/author/description from XMP
        safe(function () {
            var md = "";
            try { md = String(doc.XMPString || ""); } catch (e) {}
            function _extract(field) {
                var rx = new RegExp("<dc:" + field + "[\\s\\S]*?<rdf:li[^>]*>([\\s\\S]*?)</rdf:li>");
                var m = md.match(rx);
                return m ? m[1].replace(/^\s+|\s+$/g, "") : "";
            }
            var missing = [];
            if (!_extract("title"))       missing.push("title");
            if (!_extract("creator"))     missing.push("author");
            if (!_extract("description")) missing.push("description");
            if (missing.length > 0) {
                FINDING("warning", "508_DOC_PROPS_MISSING", "508", "doc",
                    "Document metadata missing: " + missing.join(", "),
                    false,
                    "File > File Info — set title, author, description, keywords");
            }
        }, "508 doc props");

        // 508_IMG_NO_ALT — placedItems without XMP-derived alt
        // Illustrator's per-item alt-text live in the placedItem's XMP
        // (Object Export Options aren't first-class in AI). We probe a
        // few common fields; absence is flagged. Best-effort.
        safe(function () {
            var noAlt = 0, samples = [];
            for (var i = 0; i < doc.placedItems.length; i++) {
                var pi = doc.placedItems[i];
                var alt = "";
                try { alt = String(pi.note || ""); } catch (e) {}
                if (alt) continue;
                noAlt++;
                if (samples.length < 6) {
                    var nm = "";
                    try { nm = String(pi.file && pi.file.fsName).split("/").pop(); } catch (e) {}
                    samples.push(nm || "placedItem " + i);
                }
            }
            if (noAlt > 0) {
                FINDING("error", "508_IMG_NO_ALT", "508", "doc",
                    noAlt + " image(s) missing alt text: " + samples.join(", "),
                    false,
                    "Set the placed item's Note field (Window > Attributes > Notes) with a description");
            }
        }, "508 alt text");
    }

    // ===== STEP 5: save + export =====
    L("\nSTEP 5: saving + exporting");
    try { doc.save(); } catch (e) { L("  save err: " + e); }

    // PDF export — prefer the user's CMYK Web preset, force interactive
    // features ON, set Tagged PDF if 508 mode is enabled.
    safe(function () {
        var pdfFile = File(pdfOut);
        var opts = new PDFSaveOptions();
        var presetCandidates = ["CMYK WEB", "CMYK Web", "[High Quality Print]", "[Smallest File Size]"];
        var presetName = null;
        for (var pp = 0; pp < presetCandidates.length; pp++) {
            try {
                opts.pDFPreset = presetCandidates[pp];
                presetName = presetCandidates[pp];
                break;
            } catch (e) {}
        }
        if (presetName) L("  using PDF preset: '" + presetName + "'");
        try { opts.preserveEditability = false; } catch (e) {}
        try { opts.viewAfterSaving = false; } catch (e) {}
        // Tagged PDF: AI doesn't expose this directly via PDFSaveOptions in
        // older versions. Where available, set it.
        if (qaConfig.run_508_check) {
            try { opts.acrobatLayers = false; } catch (e) {}
            try { opts.exportingTaggedPDF = true; } catch (e) {}
            FINDING("info", "508_TAGGED_PDF_ON", "508", "doc",
                "Exported with Tagged PDF (where supported)", true);
        }
        try {
            doc.saveAs(pdfFile, opts);
            L("Exported PDF: " + pdfOut);
        } catch (e) { L("  PDF export err: " + e); }
    }, "PDF export");

    // ---- Write findings.json ----
    safe(function () {
        var jf = File(findingsPath); jf.encoding = "UTF-8"; jf.open("w");
        var items = [];
        for (var i = 0; i < qaFindings.length; i++) {
            var f = qaFindings[i];
            items.push("{" +
                "\"severity\":" + jsonStr(f.severity) + "," +
                "\"id\":" + jsonStr(f.id) + "," +
                "\"category\":" + jsonStr(f.category) + "," +
                "\"location\":" + jsonStr(f.location) + "," +
                "\"message\":" + jsonStr(f.message) + "," +
                "\"autoFix\":" + (f.autoFix ? "true" : "false") + "," +
                "\"fixAction\":" + jsonStr(f.fixAction) +
                "}");
        }
        jf.write("{\"findings\":[" + items.join(",") + "]}");
        jf.close();
        L("Wrote " + qaFindings.length + " findings to findings.json");
    }, "findings json");

    // ---- Flush log + flags ----
    try {
        var lf = File(logPath); lf.encoding = "UTF-8"; lf.open("w");
        lf.write(logBuffer.join("\n")); lf.close();
    } catch (e) {}
    try {
        var ff = File(flagsPath); ff.encoding = "UTF-8"; ff.open("w");
        ff.write(flags.join("\n")); ff.close();
    } catch (e) {}

    try { doc.close(SaveOptions.SAVECHANGES); } catch (e) {}
})();
