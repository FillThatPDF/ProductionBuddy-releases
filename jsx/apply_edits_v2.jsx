// Generic edit executor + post-edit canonicalization + comprehensive QA scan.
// v0.3: works on any document. Multi-table aware. Generic alt-fill preservation.
// Path tokens are substituted by orchestrate.py at runtime.
#target indesign

(function () {
    var __outerLogPath = "__LOG_PATH__";
    try {

    var inddPath          = "__INDD_PATH__";
    var pdfOut            = "__PDF_OUT_PATH__";
    var logPath           = "__LOG_PATH__";
    var flagsPath         = "__FLAGS_PATH__";
    var findingsPath      = "__FINDINGS_PATH__";
    var hyperlinksPath    = "__HYPERLINKS_PATH__";
    var editsPath         = "__EDITS_PATH__";
    var qaConfigPath      = "__QA_CONFIG_PATH__";
    var styleProposalsPath     = "__STYLE_PROPOSALS_PATH__";
    var hyperlinkProposalsPath = "__HYPERLINK_PROPOSALS_PATH__";

    // Read QA config (thresholds + disabled checks)
    var qaConfig = { min_dpi: 300, max_fonts: 4, body_size_pt: 14, disabled_checks: {} };
    try {
        var qf = File(qaConfigPath); qf.encoding = "UTF-8"; qf.open("r");
        var qj = qf.read(); qf.close();
        qaConfig = eval("(" + qj + ")");
    } catch (e) {}
    function checkEnabled(id) { return !(qaConfig.disabled_checks && qaConfig.disabled_checks[id]); }

    var lines = [];
    function flushLog() {
        try { var lf = File(logPath); lf.encoding="UTF-8"; lf.open("w"); lf.write(lines.join("\n")); lf.close(); } catch (e) {}
    }
    function L(s) { lines.push(String(s)); $.writeln(s); flushLog(); }

    var flags = [];
    function FLAG(s) { flags.push(s); L("[FLAG] " + s); }

    var qaFindings = [];
    function FINDING(severity, id, category, location, message, autoFix, fixAction) {
        qaFindings.push({ severity: severity, id: id, category: category, location: location, message: message, autoFix: !!autoFix, fixAction: fixAction || "" });
        L("  [" + severity.toUpperCase() + "] " + id + " " + location + " \u2014 " + message);
    }
    function safe(fn, label) { try { fn(); } catch (e) { L("  ERR in " + label + ": " + e + " (line " + e.line + ")"); } }

    // ---- Sub-step timer for orchestrate-side breakdown of step 4 ----
    // Call JT_start(label) at the START of each phase (each existing
    // L("STEP X: ...") line). JT_start() automatically closes the prior
    // step. JT_summary() at the end emits a sorted breakdown.
    // orchestrate.py greps `[jsx-timing]` lines out of the apply log and
    // tees them so step 4's internals show up in the top-level summary.
    var __jt_total_start = (new Date()).getTime();
    var __jt_steps = [];
    var __jt_label = "";
    var __jt_t = 0;
    function JT_start(label) {
        if (__jt_label) {
            var dt = ((new Date()).getTime() - __jt_t) / 1000;
            L("[jsx-timing] " + __jt_label + " done in " + dt.toFixed(2) + "s");
            __jt_steps.push({ label: __jt_label, sec: dt });
        }
        __jt_label = label;
        __jt_t = (new Date()).getTime();
    }
    function JT_summary() {
        if (__jt_label) {
            var dt = ((new Date()).getTime() - __jt_t) / 1000;
            L("[jsx-timing] " + __jt_label + " done in " + dt.toFixed(2) + "s");
            __jt_steps.push({ label: __jt_label, sec: dt });
            __jt_label = "";
        }
        var total = ((new Date()).getTime() - __jt_total_start) / 1000;
        L("[jsx-timing] === JSX TIMING SUMMARY === total: " + total.toFixed(2) + "s");
        __jt_steps.sort(function (a, b) { return b.sec - a.sec; });
        for (var i = 0; i < __jt_steps.length; i++) {
            var s = __jt_steps[i];
            var pct = total > 0 ? (100 * s.sec / total) : 0;
            L("[jsx-timing]   " + s.sec.toFixed(2) + "s (" + pct.toFixed(1) + "%)  " + s.label);
        }
    }
    function jsonStr(s) {
        if (s === undefined || s === null) return "null";
        s = String(s); var out = "\"";
        for (var i = 0; i < s.length; i++) {
            var ch = s.charAt(i), c = s.charCodeAt(i);
            if (ch === "\"") out += "\\\""; else if (ch === "\\") out += "\\\\";
            else if (ch === "\n") out += "\\n"; else if (ch === "\r") out += "\\r"; else if (ch === "\t") out += "\\t";
            else if (c < 0x20) out += "\\u" + ("0000" + c.toString(16)).slice(-4);
            else out += ch;
        }
        return out + "\"";
    }

    // ---- Read structured edits ----
    var editsJson = "";
    try { var ef = File(editsPath); ef.encoding = "UTF-8"; ef.open("r"); editsJson = ef.read(); ef.close(); } catch (e) {}
    var editPlan = { edits: [], human_notes: [] };
    try { editPlan = eval("(" + editsJson + ")"); } catch (e) { L("Could not parse edits.json: " + e); }
    L("Loaded " + editPlan.edits.length + " edit op(s) and " + (editPlan.human_notes ? editPlan.human_notes.length : 0) + " human note(s)");

    JT_start("step 4.0: starting + opening doc");
    L("STEP 0: starting");
    app.scriptPreferences.userInteractionLevel = UserInteractionLevels.NEVER_INTERACT;
    app.scriptPreferences.enableRedraw = false;
    var doc = app.open(File(inddPath), false);
    L("STEP 1: opened doc: " + doc.name);

    // Force POINTS units so geometricBounds, column widths, and row
    // heights all come back in the same unit as the PDF annotation
    // coordinates the classifier sends down. Without this, a doc set
    // to picas or inches returns geometry numbers that don't match
    // at_pdf_coords and SET_CELL_STROKE picks the wrong table.
    var __savedHUnit, __savedVUnit;
    try {
        __savedHUnit = doc.viewPreferences.horizontalMeasurementUnits;
        __savedVUnit = doc.viewPreferences.verticalMeasurementUnits;
        doc.viewPreferences.horizontalMeasurementUnits = MeasurementUnits.POINTS;
        doc.viewPreferences.verticalMeasurementUnits   = MeasurementUnits.POINTS;
    } catch (e) {}

    // ==========================================================
    // COLOR RESOLUTION — used by SET_CELL_FILL and SET_TEXT_COLOR
    // ==========================================================
    // Maps a free-form color spec (sticky-note text) to an InDesign
    // Swatch / Color object. Resolution order:
    //   1. Existing doc swatch by exact name match — catches branded
    //      swatches the designer already set up ("DTE Blue").
    //   2. CMYK literal "C=## M=## Y=## K=##" — get/create that swatch.
    //   3. Hex literal "#RRGGBB" — converted to CMYK, then create.
    //   4. Common color word (red / blue / gray / etc.) — mapped via
    //      a small lexicon to plausible CMYK values, then created.
    // Returns the Swatch/Color object on success, null on failure
    // (caller flags a HUMAN_REVIEW finding so the user can tell what
    // didn't resolve).
    var COLOR_LEXICON = {
        "black":      { swatch: "Black" },
        "white":      { swatch: "Paper" },
        "cyan":       { swatch: "Cyan" },
        "magenta":    { swatch: "Magenta" },
        "yellow":     { swatch: "Yellow" },
        "red":        { cmyk: [0, 100, 100, 0] },
        "blue":       { cmyk: [100, 70, 0, 10] },
        "navy":       { cmyk: [100, 80, 0, 50] },
        "green":      { cmyk: [70, 0, 100, 10] },
        "orange":     { cmyk: [0, 50, 100, 0] },
        "purple":     { cmyk: [60, 100, 0, 0] },
        "violet":     { cmyk: [60, 100, 0, 0] },
        "pink":       { cmyk: [0, 60, 20, 0] },
        "brown":      { cmyk: [40, 60, 80, 30] },
        "gray":       { cmyk: [0, 0, 0, 50] },
        "grey":       { cmyk: [0, 0, 0, 50] },
        "lightgray":  { cmyk: [0, 0, 0, 20] },
        "lightgrey":  { cmyk: [0, 0, 0, 20] },
        "darkgray":   { cmyk: [0, 0, 0, 75] },
        "darkgrey":   { cmyk: [0, 0, 0, 75] },
        "teal":       { cmyk: [80, 0, 30, 30] },
        "gold":       { cmyk: [10, 30, 100, 10] },
        "silver":     { cmyk: [0, 0, 0, 30] },
        "maroon":     { cmyk: [30, 100, 100, 50] },
        "lime":       { cmyk: [40, 0, 100, 0] },
        "olive":      { cmyk: [40, 30, 100, 30] },
        "tan":        { cmyk: [10, 25, 50, 0] },
        "beige":      { cmyk: [5, 10, 25, 0] },
        "lightblue":  { cmyk: [40, 10, 0, 0] },
        "darkblue":   { cmyk: [100, 80, 30, 30] },
        "lightgreen": { cmyk: [30, 0, 60, 0] },
        "darkgreen":  { cmyk: [80, 30, 100, 50] },
        "lightred":   { cmyk: [0, 50, 50, 0] },
        "darkred":    { cmyk: [25, 100, 100, 30] }
    };

    function getOrCreateCmykSwatch(c, m, y, k) {
        var name = "C=" + c + " M=" + m + " Y=" + y + " K=" + k;
        try {
            var existing = doc.swatches.itemByName(name);
            if (existing && existing.isValid) return existing;
        } catch (e) {}
        try {
            return doc.colors.add({
                name: name,
                model: ColorModel.PROCESS,
                space: ColorSpace.CMYK,
                colorValue: [c, m, y, k]
            });
        } catch (e) { return null; }
    }

    function rgbToCmyk(r, g, b) {
        if (r === 0 && g === 0 && b === 0) return [0, 0, 0, 100];
        var rf = r / 255, gf = g / 255, bf = b / 255;
        var k = 1 - Math.max(rf, gf, bf);
        if (k >= 1) return [0, 0, 0, 100];
        var c = Math.round(((1 - rf - k) / (1 - k)) * 100);
        var m = Math.round(((1 - gf - k) / (1 - k)) * 100);
        var y = Math.round(((1 - bf - k) / (1 - k)) * 100);
        return [c, m, y, Math.round(k * 100)];
    }

    function resolveColor(spec) {
        if (!spec) return null;
        var s = String(spec).replace(/^\s+|\s+$/g, "");
        if (!s) return null;
        // 1. Existing swatch by exact name (case-insensitive match against
        //    each swatch's actual name).
        try {
            var sw = doc.swatches.itemByName(s);
            if (sw && sw.isValid) return sw;
        } catch (e) {}
        try {
            for (var si = 0; si < doc.swatches.length; si++) {
                if (String(doc.swatches[si].name).toLowerCase() === s.toLowerCase()) return doc.swatches[si];
            }
        } catch (e) {}
        // 2. CMYK literal: "C=100 M=65 Y=0 K=30" (any whitespace, any case)
        var mC = s.match(/^C\s*=\s*(\d+)\s*M\s*=\s*(\d+)\s*Y\s*=\s*(\d+)\s*K\s*=\s*(\d+)$/i);
        if (mC) {
            return getOrCreateCmykSwatch(parseInt(mC[1], 10), parseInt(mC[2], 10), parseInt(mC[3], 10), parseInt(mC[4], 10));
        }
        // 3. Hex literal: "#RRGGBB"
        var mH = s.match(/^#?([0-9a-fA-F]{6})$/);
        if (mH) {
            var hx = mH[1];
            var cmyk = rgbToCmyk(parseInt(hx.substring(0, 2), 16),
                                 parseInt(hx.substring(2, 4), 16),
                                 parseInt(hx.substring(4, 6), 16));
            return getOrCreateCmykSwatch(cmyk[0], cmyk[1], cmyk[2], cmyk[3]);
        }
        // 4. Lexicon — collapse whitespace so "light gray" matches "lightgray"
        var key = s.toLowerCase().replace(/\s+/g, "");
        var lex = COLOR_LEXICON[key];
        if (lex) {
            if (lex.swatch) {
                try {
                    var ssw = doc.swatches.itemByName(lex.swatch);
                    if (ssw && ssw.isValid) return ssw;
                } catch (e) {}
            }
            if (lex.cmyk) {
                return getOrCreateCmykSwatch(lex.cmyk[0], lex.cmyk[1], lex.cmyk[2], lex.cmyk[3]);
            }
        }
        return null;
    }

    // ==========================================================
    // TABLE RESOLUTION \u2014 by id, by header signature, by shape, fallback
    // ==========================================================
    var allTables = []; // [{ id, table, headerSignature, rows, cols }]
    for (var p = 0; p < doc.pages.length; p++) {
        for (var f = 0; f < doc.pages[p].textFrames.length; f++) {
            for (var t = 0; t < doc.pages[p].textFrames[f].tables.length; t++) {
                var tbl = doc.pages[p].textFrames[f].tables[t];
                var hdr = "";
                if (tbl.headerRowCount > 0) {
                    for (var c = 0; c < tbl.columns.length; c++) {
                        try { hdr += String(tbl.rows[0].cells[c].contents).replace(/\s+/g, " ").substring(0, 30) + "|"; } catch (e) {}
                    }
                }
                // Capture parent frame's geometric bounds so coord-based
                // edit ops (e.g. SET_CELL_STROKE from a sticky-note position)
                // can locate which table contains a PDF-coords point. Bounds
                // returned as [y1, x1, y2, x2] in spread/POINTS units.
                var fb = null;
                try { fb = doc.pages[p].textFrames[f].geometricBounds; } catch (e) {}
                allTables.push({
                    id: "p" + (p+1) + "_tf" + f + "_t" + t,
                    table: tbl,
                    page: p + 1,
                    frameBounds: fb,
                    headerSignature: hdr.toLowerCase(),
                    rows: tbl.rows.length,
                    cols: tbl.columns.length
                });
            }
        }
    }
    L("Discovered " + allTables.length + " table(s)");

    function resolveTable(target) {
        if (!target) target = {};
        // 1. Exact id match
        if (target.table_id) {
            for (var i = 0; i < allTables.length; i++) if (allTables[i].id === target.table_id) return allTables[i].table;
        }
        // 2. Header substring match
        if (target.header_match) {
            var needle = String(target.header_match).toLowerCase();
            for (var i = 0; i < allTables.length; i++) if (allTables[i].headerSignature.indexOf(needle) >= 0) return allTables[i].table;
        }
        // 3. Shape match
        if (target.rows || target.cols) {
            for (var i = 0; i < allTables.length; i++) {
                var t = allTables[i];
                if ((!target.rows || t.rows >= target.rows) && (!target.cols || t.cols === target.cols)) return t.table;
            }
        }
        // 4. First sizable table
        for (var i = 0; i < allTables.length; i++) if (allTables[i].rows > 1) return allTables[i].table;
        return null;
    }

    // ==========================================================
    // CELL FORMAT SNAPSHOT/COPY \u2014 for new rows to inherit
    // ==========================================================
    function snapshotCellFormat(cell) {
        var charsData = [];
        try {
            for (var ci = 0; ci < cell.characters.length; ci++) {
                var ch = cell.characters[ci];
                var rec = {};
                try { rec.font      = ch.appliedFont; } catch (e) {}
                try { rec.pointSize = ch.pointSize; } catch (e) {}
                try { rec.charStyle = ch.appliedCharacterStyle; } catch (e) {}
                try { rec.position  = ch.position; } catch (e) {}
                try { rec.fillColor = ch.fillColor; } catch (e) {}
                try { rec.fillTint  = ch.fillTint; } catch (e) {}
                charsData.push(rec);
            }
        } catch (e) {}
        return {
            cellStyle: (function(){ try { return cell.appliedCellStyle; } catch (e) { return null; } })(),
            paraStyle: (function(){ try { return cell.paragraphs[0].appliedParagraphStyle; } catch (e) { return null; } })(),
            fillColor: (function(){ try { return cell.fillColor; } catch (e) { return null; } })(),
            fillTint:  (function(){ try { return cell.fillTint; } catch (e) { return null; } })(),
            // Cell metrics — needed because cellStyle is often [None], in which
            // case these are stored directly on the cell. Without restoring
            // them, AT_BEGINNING-inserted cells inherit InDesign defaults
            // (top-aligned, default insets) and look misaligned vs. the
            // surrounding rows that have these set explicitly.
            verticalJustification: (function(){ try { return cell.verticalJustification; } catch (e) { return null; } })(),
            topInset:    (function(){ try { return cell.topInset;    } catch (e) { return null; } })(),
            bottomInset: (function(){ try { return cell.bottomInset; } catch (e) { return null; } })(),
            leftInset:   (function(){ try { return cell.leftInset;   } catch (e) { return null; } })(),
            rightInset:  (function(){ try { return cell.rightInset;  } catch (e) { return null; } })(),
            chars:     charsData,
            // Edge strokes
            topStroke:    snapshotEdgeStroke(cell, "top"),
            bottomStroke: snapshotEdgeStroke(cell, "bottom"),
            leftStroke:   snapshotEdgeStroke(cell, "left"),
            rightStroke:  snapshotEdgeStroke(cell, "right")
        };
    }
    function snapshotEdgeStroke(cell, side) {
        return {
            color:  (function(){ try { return cell[side + "EdgeStrokeColor"]; } catch (e) { return null; } })(),
            weight: (function(){ try { return cell[side + "EdgeStrokeWeight"]; } catch (e) { return null; } })(),
            tint:   (function(){ try { return cell[side + "EdgeStrokeTint"]; } catch (e) { return null; } })()
        };
    }
    function applyCellFormat(cell, snap, newText) {
        try { if (snap.cellStyle) cell.appliedCellStyle = snap.cellStyle; } catch (e) {}
        try { if (snap.paraStyle) cell.paragraphs[0].appliedParagraphStyle = snap.paraStyle; } catch (e) {}
        // Restore cell metrics first — content/font writes after this don't
        // change the geometry, so it's fine to set them up-front.
        try { if (snap.verticalJustification != null) cell.verticalJustification = snap.verticalJustification; } catch (e) {}
        try { if (snap.topInset    != null) cell.topInset    = snap.topInset;    } catch (e) {}
        try { if (snap.bottomInset != null) cell.bottomInset = snap.bottomInset; } catch (e) {}
        try { if (snap.leftInset   != null) cell.leftInset   = snap.leftInset;   } catch (e) {}
        try { if (snap.rightInset  != null) cell.rightInset  = snap.rightInset;  } catch (e) {}
        if (newText !== undefined) {
            var s = String(newText || "");
            // Render U+2713 via the Wingdings glyph since most body fonts
            // don't have a glyph for it — same convention as SET_CELL_VALUE.
            if (s === "\u2713" || s === "CHECK" || s === "CHECKMARK") {
                cell.contents = String.fromCharCode(61692);
                try { cell.characters[0].appliedFont = app.fonts.itemByName("Wingdings\tRegular"); } catch (e) {}
            } else {
                cell.contents = s;
            }
        }
        try { if (snap.fillColor) cell.fillColor = snap.fillColor; } catch (e) {}
        try { if (snap.fillTint != null) cell.fillTint = snap.fillTint; } catch (e) {}
        // Apply first-character formatting to entire run
        try {
            if (snap.chars && snap.chars.length > 0 && cell.characters.length > 0) {
                var s = snap.chars[0];
                var run = cell.texts[0];
                try { if (s.font) run.appliedFont = s.font; } catch (e) {}
                try { if (s.pointSize) run.pointSize = s.pointSize; } catch (e) {}
                try { if (s.charStyle) run.appliedCharacterStyle = s.charStyle; } catch (e) {}
                try { if (s.fillColor) run.fillColor = s.fillColor; } catch (e) {}
                try { if (s.fillTint != null) run.fillTint = s.fillTint; } catch (e) {}
            }
        } catch (e) {}
        // Reapply strokes
        var sides = ["top", "bottom", "left", "right"];
        for (var i = 0; i < sides.length; i++) {
            var snk = snap[sides[i] + "Stroke"];
            if (!snk) continue;
            try { if (snk.color)  cell[sides[i] + "EdgeStrokeColor"]  = snk.color; } catch (e) {}
            try { if (snk.weight != null) cell[sides[i] + "EdgeStrokeWeight"] = snk.weight; } catch (e) {}
            try { if (snk.tint != null)   cell[sides[i] + "EdgeStrokeTint"]   = snk.tint; } catch (e) {}
        }
        // Disable hyphenation on new content
        try {
            for (var pi = 0; pi < cell.paragraphs.length; pi++) cell.paragraphs[pi].hyphenation = false;
        } catch (e) {}
    }

    // ==========================================================
    // SAFE ROW INSERTION
    //
    // InDesign 2025/2026 has a DOM bug: when you call
    // `tbl.rows.add(LocationOptions.AT_END)` repeatedly, only the FIRST new
    // row's cells accept content writes. Subsequent rows' cells silently
    // ignore `cell.contents = "X"` AND any later writes to those cells (e.g.
    // from SORT_TABLE rewriting positions) also fail. The result is data loss
    // for the 2nd+ added row PLUS data loss for whichever original row
    // alphabetically sorts into those broken cells' positions.
    //
    // Workaround: use AT_BEGINNING (which doesn't have the bug — every
    // inserted row gets a working cell), snapshot the entire table state
    // first, then re-stamp every cell top-to-bottom from the snapshot. The
    // newly-inserted AT_BEGINNING row provides one extra "fresh" row that
    // we can write into; everything else is an existing cell that we know
    // accepts writes.
    // ==========================================================
    function addRowSafely(tbl, insertAt, values) {
        var nCols = tbl.columns.length;
        var headerRows = tbl.headerRowCount;
        if (insertAt < 0 || insertAt > tbl.rows.length) insertAt = tbl.rows.length;

        // Snapshot every cell (contents + format) AND each row's height
        // properties. We need the row metrics because the AT_BEGINNING insert
        // creates a row with default height; without re-stamping, the new row
        // ends up taller/shorter than its peers.
        var snap = [];
        var rowMetrics = [];
        for (var r = 0; r < tbl.rows.length; r++) {
            var rowSnap = [];
            for (var c = 0; c < nCols; c++) {
                var cell = tbl.rows[r].cells[c];
                rowSnap.push({
                    contents: String(cell.contents || ""),
                    format:   snapshotCellFormat(cell)
                });
            }
            snap.push(rowSnap);
            rowMetrics.push({
                height:        (function(rr){ try { return tbl.rows[rr].height;        } catch (e) { return null; } })(r),
                minimumHeight: (function(rr){ try { return tbl.rows[rr].minimumHeight; } catch (e) { return null; } })(r),
                maximumHeight: (function(rr){ try { return tbl.rows[rr].maximumHeight; } catch (e) { return null; } })(r)
            });
        }

        // Build a sample format snapshot from the row immediately before the
        // insertion point (or the last body row if we're appending).
        var sampleIdx = Math.max(headerRows, Math.min(snap.length - 1, insertAt - 1));
        if (sampleIdx >= snap.length) sampleIdx = snap.length - 1;
        if (sampleIdx < 0) sampleIdx = 0;
        var newRowSnap = [];
        for (var c2 = 0; c2 < nCols; c2++) {
            newRowSnap.push({
                contents: c2 < values.length ? String(values[c2]) : "",
                format:   snap[sampleIdx][c2].format
            });
        }
        var newRowMetrics = rowMetrics[sampleIdx];

        // Build the desired final-row content list AND a parallel metrics list,
        // both with the new row spliced in at the requested position.
        var finalRows = [];
        var finalMetrics = [];
        for (var r2 = 0; r2 <= snap.length; r2++) {
            if (r2 === insertAt) {
                finalRows.push(newRowSnap);
                finalMetrics.push(newRowMetrics);
            }
            if (r2 < snap.length) {
                finalRows.push(snap[r2]);
                finalMetrics.push(rowMetrics[r2]);
            }
        }

        // Add one row at AT_BEGINNING (only location that doesn't trigger the
        // cell-write bug for subsequent inserts).
        tbl.rows.add(LocationOptions.AT_BEGINNING);

        // Re-stamp every cell from finalRows. Both existing cells and the
        // AT_BEGINNING-inserted cells accept content writes here.
        for (var r3 = 0; r3 < finalRows.length; r3++) {
            for (var c3 = 0; c3 < nCols; c3++) {
                applyCellFormat(tbl.rows[r3].cells[c3], finalRows[r3][c3].format, finalRows[r3][c3].contents);
            }
            // Restore row-level geometry so the new row matches its peers
            try {
                if (finalMetrics[r3].height        != null) tbl.rows[r3].height        = finalMetrics[r3].height;
                if (finalMetrics[r3].minimumHeight != null) tbl.rows[r3].minimumHeight = finalMetrics[r3].minimumHeight;
                if (finalMetrics[r3].maximumHeight != null) tbl.rows[r3].maximumHeight = finalMetrics[r3].maximumHeight;
            } catch (e) {}
        }
    }

    // ==========================================================
    // EDIT DISPATCHER
    // ==========================================================
    var modifiedTables = {}; // table id → true; for post-edit canonicalization
    function markTableModified(tbl) {
        for (var i = 0; i < allTables.length; i++) if (allTables[i].table === tbl) { modifiedTables[allTables[i].id] = true; return; }
    }

    // Stories touched by REPLACE_TEXT, used by the post-edit reflow pass
    // (3e) to find stale forced line breaks in just the modified bodies
    // rather than rewriting the whole document.
    var modifiedStories = {}; // story.id → story object
    function noteChangedTexts(textArray) {
        if (!textArray) return;
        for (var ci = 0; ci < textArray.length; ci++) {
            try {
                var st = textArray[ci].parentStory;
                if (st && st.id != null) modifiedStories[st.id] = st;
            } catch (e) {}
        }
    }

    // Cell-direct text replacement. Used as a final fallback by the
    // REPLACE_TEXT handler — InDesign's findText / changeText reports
    // false-positive replacements ("1 occurrence replaced") for find
    // strings inside table cells under some conditions, so we walk
    // every cell in the search scope ourselves and patch via character
    // range to preserve formatting. Returns the number of cells
    // actually mutated.
    function applyCellPatch(scope, find, replace) {
        if (!find) return 0;
        // Build the list of cells we're allowed to patch. If scope IS a
        // Cell, the only candidate is that cell — tightest scoping. For
        // a Document/Story/TextFrame, we expand to every cell of every
        // table in scope.
        var cells = [];
        try {
            // Detect a Cell scope by the presence of cell-only props
            // (`cells`, `parentRow`). Class-name check is unreliable in
            // ExtendScript so we go by duck typing.
            var isCell = false;
            try { isCell = (scope.parentRow !== undefined && scope.cells === undefined) ||
                          (scope.constructor && String(scope.constructor.name) === "Cell"); } catch (e) {}
            if (isCell) {
                cells.push(scope);
            } else {
                var tables = [];
                if (scope === doc) {
                    for (var si = 0; si < doc.stories.length; si++) {
                        var st = doc.stories[si];
                        try {
                            for (var ti = 0; ti < st.tables.length; ti++) tables.push(st.tables[ti]);
                        } catch (e) {}
                    }
                } else if (scope.parentStory) {
                    // TextFrame
                    try {
                        var ps = scope.parentStory;
                        for (var ti = 0; ti < ps.tables.length; ti++) tables.push(ps.tables[ti]);
                    } catch (e) {}
                } else if (scope.tables) {
                    for (var ti = 0; ti < scope.tables.length; ti++) tables.push(scope.tables[ti]);
                }
                for (var ti2 = 0; ti2 < tables.length; ti2++) {
                    var tbl = tables[ti2];
                    try {
                        for (var r = 0; r < tbl.rows.length; r++) {
                            for (var c = 0; c < tbl.columns.length; c++) {
                                try { cells.push(tbl.rows[r].cells[c]); } catch (e) {}
                            }
                        }
                    } catch (e) {}
                }
            }
        } catch (e) {}

        var hits = 0;
        for (var ci = 0; ci < cells.length; ci++) {
            var cell = cells[ci];
            var content = "";
            try { content = String(cell.contents); } catch (e) {}
            // Walk every occurrence in this cell — back to front so
            // character indexes stay stable as we replace shorter
            // ranges.
            var positions = [];
            var start = 0;
            while (true) {
                var pos = content.indexOf(find, start);
                if (pos < 0) break;
                positions.push(pos);
                start = pos + find.length;
            }
            for (var pi = positions.length - 1; pi >= 0; pi--) {
                var posIdx = positions[pi];
                var endIdx = posIdx + find.length;
                try {
                    var rangeText = cell.texts[0].characters.itemByRange(posIdx, endIdx - 1);
                    rangeText.contents = replace;
                    hits++;
                } catch (e) {
                    // Range API failed (rare) — fall back to whole-cell
                    // rewrite. Loses per-char formatting in the cell;
                    // last-resort only.
                    try {
                        cell.contents = content.split(find).join(replace);
                        hits++;
                        break; // whole-cell rewrite handles all positions at once
                    } catch (e2) {}
                }
            }
        }
        return hits;
    }

    // Find the specific table cell at a PDF coordinate. Returns the
    // Cell object whose visible text bounding box contains (px, py),
    // or null if the coord isn't inside any cell. Uses
    // `cell.texts[0].geometricBounds` which InDesign exposes for the
    // text run inside each cell — so we get a precise cell-level
    // location regardless of how the table is laid out within its
    // parent frame (multiple stacked tables in the same frame are
    // handled correctly).
    function findCellAtCoords(pageNum, px, py) {
        if (!pageNum) return null;
        // Cells don't expose `geometricBounds` directly in this InDesign
        // version, so we triangulate:
        //   - X comes from the parent frame's left edge + cumulative
        //     column widths.
        //   - Y comes from the first cell's first-line baseline (the
        //     table's natural Y anchor) + cumulative row heights up to
        //     the row in question.
        // This handles tables stacked in a multi-table frame too — each
        // table has its own first-line baseline so the Y math is local
        // to the table.
        for (var ti = 0; ti < allTables.length; ti++) {
            var tinfo = allTables[ti];
            if (tinfo.page !== pageNum) continue;
            var tbl = tinfo.table;
            var fb = tinfo.frameBounds;
            if (!fb || fb.length < 4) continue;

            // Build column edges from the frame's left edge.
            var colEdges = [fb[1]];
            var xCursor = fb[1];
            try {
                for (var c = 0; c < tbl.columns.length; c++) {
                    var w = 0;
                    try { w = tbl.columns[c].width; } catch (e) {}
                    xCursor += w;
                    colEdges.push(xCursor);
                }
            } catch (e) { continue; }
            // Quick X reject + col index.
            if (px < colEdges[0] - 5 || px > colEdges[colEdges.length - 1] + 5) continue;
            var colIdx = -1;
            for (var c2 = 0; c2 < colEdges.length - 1; c2++) {
                if (px >= colEdges[c2] - 5 && px <= colEdges[c2 + 1] + 5) {
                    colIdx = c2; break;
                }
            }
            if (colIdx < 0) continue;

            // Y anchor: first row's first-line baseline. Approximate the
            // first row's TOP as `baseline − rowHeight` (close enough
            // for body fonts; cell top inset adds a couple of pt). Then
            // walk down by cumulative row heights.
            var anchorBaseline = -1;
            try {
                anchorBaseline = tbl.rows[0].cells[0].lines[0].baseline;
            } catch (e) {}
            // Fallback for empty first cell — try cells[colIdx] in row 0
            // or any non-empty cell in row 0.
            if (anchorBaseline < 0) {
                try { anchorBaseline = tbl.rows[0].cells[colIdx].lines[0].baseline; } catch (e) {}
            }
            if (anchorBaseline < 0) {
                for (var ac = 0; ac < tbl.columns.length && anchorBaseline < 0; ac++) {
                    try { anchorBaseline = tbl.rows[0].cells[ac].lines[0].baseline; } catch (e) {}
                }
            }
            if (anchorBaseline < 0) continue;
            var firstRowH = 12;
            try { firstRowH = tbl.rows[0].height; } catch (e) {}
            var rowTop0 = anchorBaseline - firstRowH;
            var rowEdges = [rowTop0];
            var yCursor = rowTop0;
            try {
                for (var r = 0; r < tbl.rows.length; r++) {
                    var rh = 0;
                    try { rh = tbl.rows[r].height; } catch (e) {}
                    yCursor += rh;
                    rowEdges.push(yCursor);
                }
            } catch (e) { continue; }
            // Quick Y reject + row index.
            if (py < rowEdges[0] - 5 || py > rowEdges[rowEdges.length - 1] + 5) continue;
            var rowIdx = -1;
            for (var r2 = 0; r2 < rowEdges.length - 1; r2++) {
                if (py >= rowEdges[r2] - 5 && py <= rowEdges[r2 + 1] + 5) {
                    rowIdx = r2; break;
                }
            }
            if (rowIdx < 0) continue;
            try { return tbl.rows[rowIdx].cells[colIdx]; } catch (e) {}
        }
        return null;
    }

    function applyEdit(edit) {
        L("\nEDIT [" + edit.op + "] confidence=" + (edit.confidence || "?") + " \u2014 " + (edit.rationale || ""));
        if (edit.op === "HUMAN_REVIEW") {
            FLAG("Human review: " + (edit.source_annotation || edit.rationale));
            return;
        }
        if (edit.confidence != null && edit.confidence < 0.6) {
            FLAG("Low-confidence edit (" + edit.confidence + ") routed to human review: " + (edit.source_annotation || edit.rationale));
            return;
        }
        var op = edit.op;

        // ---- Table operations ----
        if (op === "ADD_TABLE_ROW" || op === "INSERT_ROW_AT") {
            var tbl = resolveTable(edit.target);
            if (!tbl) { FLAG(op + ": could not resolve target table"); return; }
            var values = (edit.params && edit.params.values) || [];
            // Sanity check \u2014 reject row inserts whose value count doesn't match
            // the table's column count.
            if (values.length < tbl.columns.length - 1) {
                FLAG(op + ": refused \u2014 only " + values.length + " value(s) for " + tbl.columns.length + "-column table. Annotation: \"" + (edit.source_annotation || "").substring(0, 80) + "\"");
                return;
            }
            markTableModified(tbl);
            var insertAt = (op === "INSERT_ROW_AT" && edit.params && edit.params.index != null) ? edit.params.index : tbl.rows.length;
            addRowSafely(tbl, insertAt, values);
            L("  added row with " + values.length + " value(s) at index " + (op === "INSERT_ROW_AT" ? insertAt : "end"));
            return;
        }

        if (op === "DELETE_PAGE") {
            var pageNum = (edit.target && edit.target.page);
            if (pageNum == null) { FLAG("DELETE_PAGE: no page number"); return; }
            try {
                if (pageNum < 1 || pageNum > doc.pages.length) {
                    FLAG("DELETE_PAGE: page " + pageNum + " out of range (doc has " + doc.pages.length + " page(s))");
                    return;
                }
                if (doc.pages.length <= 1) {
                    FLAG("DELETE_PAGE: refused \u2014 would leave doc with no pages");
                    return;
                }
                doc.pages[pageNum - 1].remove();
                L("  deleted page " + pageNum);
            } catch (e) { FLAG("DELETE_PAGE failed: " + e); }
            return;
        }

        if (op === "DELETE_ROW") {
            var tbl2 = resolveTable(edit.target);
            if (!tbl2) { FLAG("DELETE_ROW: could not resolve table"); return; }
            markTableModified(tbl2);
            var rowIdx = -1;
            if (edit.target && edit.target.row_match) {
                var match = String(edit.target.row_match).toLowerCase();
                for (var r = tbl2.headerRowCount; r < tbl2.rows.length; r++) {
                    var nameCell = String(tbl2.rows[r].cells[0].contents || "").toLowerCase();
                    if (nameCell.indexOf(match) === 0) { rowIdx = r; break; }
                }
            } else if (edit.target && edit.target.row_index != null) {
                rowIdx = edit.target.row_index;
            }
            if (rowIdx < 0) { FLAG("DELETE_ROW: no row match"); return; }
            tbl2.rows[rowIdx].remove();
            L("  deleted row " + rowIdx);
            return;
        }

        if (op === "SET_CELL_STROKE") {
            // Modify the stroke (weight + optional color) of cell edges
            // identified by an annotation's PDF coordinates. Used for
            // reviewer notes like "delete this black line" or "make this
            // line gray" pointing at column/row separators.
            //
            //   target.page          — page number the annotation sits on
            //   target.at_pdf_coords — [x, y] in spread/POINTS top-left
            //   target.orientation   — "vertical" | "horizontal" | "auto"
            //   target.table_id      — optional explicit table id (skips
            //                          coord-based table resolution)
            //   params.weight        — new stroke weight in pt; 0 to remove
            //   params.color         — optional Swatch name (e.g. "Black",
            //                          "[None]", "C=0 M=0 Y=0 K=50")
            //   params.scope         — "column" | "row" | "cell" | "all"
            //                          (default "all": every cell along
            //                          the matching column/row boundary)
            var coords = edit.target && edit.target.at_pdf_coords;
            var pageHint = edit.target && edit.target.page;
            var orient = (edit.target && edit.target.orientation) || "auto";
            var newWeight = (edit.params && edit.params.weight !== undefined) ? Number(edit.params.weight) : 0;
            var newColorName = (edit.params && edit.params.color) || null;
            if (!coords || coords.length < 2) { FLAG("SET_CELL_STROKE: missing at_pdf_coords"); return; }
            var px = coords[0], py = coords[1];

            // Find candidate tables — prefer same-page if the hint is set
            var matchTable = null;
            for (var i = 0; i < allTables.length; i++) {
                var atb = allTables[i];
                if (pageHint && atb.page !== pageHint) continue;
                var fb = atb.frameBounds;
                if (!fb || fb.length < 4) continue;
                // frameBounds is [y1, x1, y2, x2]; small tolerance for
                // annotations placed slightly off the table edge.
                if (px >= fb[1] - 5 && px <= fb[3] + 5 && py >= fb[0] - 5 && py <= fb[2] + 5) {
                    matchTable = atb;
                    break;
                }
            }
            // Fallback: closest table center on the requested page
            if (!matchTable) {
                var bestD = 1e12;
                for (var i = 0; i < allTables.length; i++) {
                    if (pageHint && allTables[i].page !== pageHint) continue;
                    var fb = allTables[i].frameBounds;
                    if (!fb || fb.length < 4) continue;
                    var fcx = (fb[1] + fb[3]) / 2, fcy = (fb[0] + fb[2]) / 2;
                    var d = (px - fcx) * (px - fcx) + (py - fcy) * (py - fcy);
                    if (d < bestD) { bestD = d; matchTable = allTables[i]; }
                }
            }
            if (!matchTable) { FLAG("SET_CELL_STROKE: no table found near (" + px + "," + py + ") on page " + pageHint); return; }

            var tbl = matchTable.table;
            // Note: intentionally NOT calling markTableModified here.
            // The 3a/3b/3c post-edit passes are for content-mutating ops
            // (REPLACE_TEXT in cells, ADD_TABLE_ROW, etc.) — re-stamping
            // alternating fills on a table whose only change was a stroke
            // weight is an unwanted side effect.
            var fb = matchTable.frameBounds;
            var frameLeft = fb[1], frameTop = fb[0];

            // Build cumulative column edges (left → right) from column widths.
            var colEdges = [frameLeft];
            var x = frameLeft;
            for (var c = 0; c < tbl.columns.length; c++) {
                var w = 0; try { w = tbl.columns[c].width; } catch (e) {}
                x += w;
                colEdges.push(x);
            }
            // Cumulative row edges (top → bottom) from row heights.
            var rowEdges = [frameTop];
            var y = frameTop;
            for (var r = 0; r < tbl.rows.length; r++) {
                var h = 0; try { h = tbl.rows[r].height; } catch (e) {}
                y += h;
                rowEdges.push(y);
            }

            // Auto-detect orientation: pick whichever edge type the point
            // is closer to. "Closer to a column edge" → vertical line.
            if (orient === "auto") {
                var bestColD = 1e12;
                for (var i = 0; i < colEdges.length; i++) {
                    var d = Math.abs(px - colEdges[i]); if (d < bestColD) bestColD = d;
                }
                var bestRowD = 1e12;
                for (var i = 0; i < rowEdges.length; i++) {
                    var d = Math.abs(py - rowEdges[i]); if (d < bestRowD) bestRowD = d;
                }
                orient = (bestColD <= bestRowD) ? "vertical" : "horizontal";
            }

            var swatch = null;
            if (newColorName) {
                try { swatch = doc.swatches.itemByName(newColorName); if (!swatch.isValid) swatch = null; } catch (e) {}
            }

            var changed = 0;
            if (orient === "vertical") {
                // Find the closest INTERNAL column edge (skip 0 and last —
                // those are the table's outer borders, not the inter-column
                // separators a reviewer typically calls out).
                var bestIdx = -1, bestD = 1e12;
                for (var i = 1; i < colEdges.length - 1; i++) {
                    var d = Math.abs(px - colEdges[i]);
                    if (d < bestD) { bestD = d; bestIdx = i; }
                }
                if (bestIdx < 0) { FLAG("SET_CELL_STROKE: no internal column edge"); return; }
                var leftCol = bestIdx - 1, rightCol = bestIdx;
                var edgeX = colEdges[bestIdx];
                // Diagnostic: snapshot first-row stroke values BEFORE
                // mutation so we can see what was actually there. Helps
                // catch the case where the visible line is drawn by a
                // separate page item (Line / Rectangle on top of the
                // table), not the cell strokes we're modifying.
                try {
                    var sampleR = tbl.rows[0].cells[leftCol];
                    var sampleC = tbl.rows[0].cells[rightCol];
                    var rW = "?", rN = "?", lW = "?", lN = "?";
                    try { rW = sampleR.rightEdgeStrokeWeight; rN = sampleR.rightEdgeStrokeColor && sampleR.rightEdgeStrokeColor.name; } catch (e) {}
                    try { lW = sampleC.leftEdgeStrokeWeight;  lN = sampleC.leftEdgeStrokeColor  && sampleC.leftEdgeStrokeColor.name;  } catch (e) {}
                    L("  3.STROKE DIAG row0: leftCol.rightEdge w=" + rW + " color=" + rN +
                      " | rightCol.leftEdge w=" + lW + " color=" + lN);
                } catch (e) {}
                // Mutate: weight 0 + color [None] → make any cell-level
                // stroke truly invisible (weight 0 alone isn't always
                // enough — InDesign can still draw a hairline if the
                // stroke type has end-caps).
                var noneSwatch = null;
                try { noneSwatch = doc.swatches.itemByName("[None]"); if (!noneSwatch.isValid) noneSwatch = null; } catch (e) {}
                for (var r = 0; r < tbl.rows.length; r++) {
                    safe(function () {
                        var lc = tbl.rows[r].cells[leftCol];
                        var rc = tbl.rows[r].cells[rightCol];
                        if (lc) {
                            lc.rightEdgeStrokeWeight = newWeight;
                            if (swatch) lc.rightEdgeStrokeColor = swatch;
                            else if (newWeight === 0 && noneSwatch) lc.rightEdgeStrokeColor = noneSwatch;
                            changed++;
                        }
                        if (rc) {
                            rc.leftEdgeStrokeWeight = newWeight;
                            if (swatch) rc.leftEdgeStrokeColor = swatch;
                            else if (newWeight === 0 && noneSwatch) rc.leftEdgeStrokeColor = noneSwatch;
                        }
                    }, "SET_CELL_STROKE row " + r);
                }
                L("  modified vertical column edge " + bestIdx + " of table " + matchTable.id +
                  " across " + tbl.rows.length + " row(s) — weight=" + newWeight +
                  (newColorName ? " color=" + newColorName : ""));
                // Page-item scan: any Line / thin Rectangle whose x sits
                // within 3pt of the modified column edge AND whose
                // vertical span overlaps the table is most likely the
                // visible separator the reviewer pointed at. Hide it.
                if (newWeight === 0) {
                    var pageObj = matchTable.page ? doc.pages[matchTable.page - 1] : null;
                    var hidden = 0;
                    if (pageObj) {
                        var items = pageObj.allPageItems;
                        var tableY1 = fb[0], tableY2 = fb[2];
                        for (var ii = 0; ii < items.length; ii++) {
                            var it = items[ii];
                            var clsName = ""; try { clsName = it.constructor.name; } catch (e) {}
                            if (clsName !== "GraphicLine" && clsName !== "Line" && clsName !== "Rectangle") continue;
                            var gb = null; try { gb = it.geometricBounds; } catch (e) {}
                            if (!gb || gb.length < 4) continue;
                            var ix1 = gb[1], ix2 = gb[3], iy1 = gb[0], iy2 = gb[2];
                            var w = ix2 - ix1, h = iy2 - iy1;
                            // Vertical line shape: tall and very thin.
                            if (w > 3) continue;
                            // Crosses (or sits inside) the table's y-band.
                            if (iy2 < tableY1 - 5 || iy1 > tableY2 + 5) continue;
                            // X within 3pt of the target column edge.
                            var ixMid = (ix1 + ix2) / 2;
                            if (Math.abs(ixMid - edgeX) > 3) continue;
                            try {
                                it.visible = false;
                                hidden++;
                            } catch (e) {}
                        }
                    }
                    if (hidden > 0) L("  also hid " + hidden + " line/rectangle page-item(s) at x≈" + edgeX);
                }
            } else {
                // Horizontal — closest INTERNAL row edge.
                var bestIdx = -1, bestD = 1e12;
                for (var i = 1; i < rowEdges.length - 1; i++) {
                    var d = Math.abs(py - rowEdges[i]);
                    if (d < bestD) { bestD = d; bestIdx = i; }
                }
                if (bestIdx < 0) { FLAG("SET_CELL_STROKE: no internal row edge"); return; }
                var topRow = bestIdx - 1, bottomRow = bestIdx;
                for (var c = 0; c < tbl.columns.length; c++) {
                    safe(function () {
                        var tc = tbl.rows[topRow].cells[c];
                        var bc = tbl.rows[bottomRow].cells[c];
                        if (tc) {
                            tc.bottomEdgeStrokeWeight = newWeight;
                            if (swatch) tc.bottomEdgeStrokeColor = swatch;
                            changed++;
                        }
                        if (bc) {
                            bc.topEdgeStrokeWeight = newWeight;
                            if (swatch) bc.topEdgeStrokeColor = swatch;
                        }
                    }, "SET_CELL_STROKE col " + c);
                }
                L("  modified horizontal row edge " + bestIdx + " of table " + matchTable.id +
                  " across " + tbl.columns.length + " col(s) — weight=" + newWeight +
                  (newColorName ? " color=" + newColorName : ""));
            }
            return;
        }

        if (op === "SET_CELL_FILL") {
            // Recolor the background fill of one cell, a row, or a column,
            // identified by the annotation's PDF coordinates. Used for
            // reviewer notes like "make this header gray" or "change this
            // row to white".
            //
            //   target.page          — page number the annotation sits on
            //   target.at_pdf_coords — [x, y] in spread/POINTS top-left
            //   target.scope         — "cell" (default) | "row" | "column"
            //   params.color         — color spec (swatch name | CMYK literal
            //                          | "#RRGGBB" | lexicon word)
            var fcoords = edit.target && edit.target.at_pdf_coords;
            var fpage = edit.target && edit.target.page;
            var fscope = (edit.target && edit.target.scope) || "cell";
            var fcolorSpec = edit.params && edit.params.color;
            if (!fcoords || fcoords.length < 2) { FLAG("SET_CELL_FILL: missing at_pdf_coords"); return; }
            if (!fcolorSpec) { FLAG("SET_CELL_FILL: missing params.color"); return; }
            var fpx = fcoords[0], fpy = fcoords[1];

            var fillSwatch = resolveColor(fcolorSpec);
            if (!fillSwatch) {
                FLAG("SET_CELL_FILL: couldn't resolve color '" + fcolorSpec + "' (no matching swatch and no lexicon entry)");
                return;
            }

            // Find the table containing the annotation point — same logic
            // as SET_CELL_STROKE so behavior stays consistent.
            var fmatch = null;
            for (var i = 0; i < allTables.length; i++) {
                var atb = allTables[i];
                if (fpage && atb.page !== fpage) continue;
                var fbb = atb.frameBounds;
                if (!fbb || fbb.length < 4) continue;
                if (fpx >= fbb[1] - 5 && fpx <= fbb[3] + 5 && fpy >= fbb[0] - 5 && fpy <= fbb[2] + 5) {
                    fmatch = atb; break;
                }
            }
            if (!fmatch) { FLAG("SET_CELL_FILL: no table found near (" + fpx + "," + fpy + ") on page " + fpage); return; }

            var ftbl = fmatch.table;
            var fbb2 = fmatch.frameBounds;
            // Cumulative column edges → resolve column index
            var fColEdges = [fbb2[1]];
            var fx = fbb2[1];
            for (var c = 0; c < ftbl.columns.length; c++) {
                var fw = 0; try { fw = ftbl.columns[c].width; } catch (e) {}
                fx += fw;
                fColEdges.push(fx);
            }
            var fColIdx = -1;
            for (var c = 0; c < fColEdges.length - 1; c++) {
                if (fpx >= fColEdges[c] && fpx <= fColEdges[c + 1]) { fColIdx = c; break; }
            }
            if (fColIdx < 0) fColIdx = 0;
            // Cumulative row edges → resolve row index
            var fRowEdges = [fbb2[0]];
            var fy = fbb2[0];
            for (var r = 0; r < ftbl.rows.length; r++) {
                var fh = 0; try { fh = ftbl.rows[r].height; } catch (e) {}
                fy += fh;
                fRowEdges.push(fy);
            }
            var fRowIdx = -1;
            for (var r = 0; r < fRowEdges.length - 1; r++) {
                if (fpy >= fRowEdges[r] && fpy <= fRowEdges[r + 1]) { fRowIdx = r; break; }
            }
            if (fRowIdx < 0) fRowIdx = 0;

            var stamped = 0;
            if (fscope === "row") {
                for (var c = 0; c < ftbl.columns.length; c++) {
                    safe(function () {
                        ftbl.rows[fRowIdx].cells[c].fillColor = fillSwatch;
                        try { ftbl.rows[fRowIdx].cells[c].fillTint = 100; } catch (e) {}
                        stamped++;
                    }, "SET_CELL_FILL row cell " + c);
                }
            } else if (fscope === "column") {
                for (var r = 0; r < ftbl.rows.length; r++) {
                    safe(function () {
                        ftbl.rows[r].cells[fColIdx].fillColor = fillSwatch;
                        try { ftbl.rows[r].cells[fColIdx].fillTint = 100; } catch (e) {}
                        stamped++;
                    }, "SET_CELL_FILL col cell " + r);
                }
            } else {
                safe(function () {
                    ftbl.rows[fRowIdx].cells[fColIdx].fillColor = fillSwatch;
                    try { ftbl.rows[fRowIdx].cells[fColIdx].fillTint = 100; } catch (e) {}
                    stamped = 1;
                }, "SET_CELL_FILL single cell");
            }
            L("  set fill of " + stamped + " cell(s) (" + fscope + ") in table " + fmatch.id +
              " at row " + fRowIdx + " col " + fColIdx + " → " + fcolorSpec);
            return;
        }

        if (op === "SET_TEXT_COLOR") {
            // Recolor a run of text. Two ways the target arrives:
            //   target.find          — exact text the classifier wants
            //                          recolored (most reliable; emits
            //                          line_text from the annotation)
            //   target.at_pdf_coords — fallback: x,y near the text. We
            //                          locate the paragraph at that point
            //                          and color the whole paragraph.
            //   params.color         — same color spec as SET_CELL_FILL
            var tcFind = edit.target && edit.target.find;
            var tcCoords = edit.target && edit.target.at_pdf_coords;
            var tcPage = edit.target && edit.target.page;
            var tcColorSpec = edit.params && edit.params.color;
            if (!tcColorSpec) { FLAG("SET_TEXT_COLOR: missing params.color"); return; }
            var tcSwatch = resolveColor(tcColorSpec);
            if (!tcSwatch) {
                FLAG("SET_TEXT_COLOR: couldn't resolve color '" + tcColorSpec + "'");
                return;
            }

            var tcStamped = 0;
            if (tcFind) {
                // Find every occurrence of the literal target text; recolor
                // the matched runs. Same find/changeText machinery used by
                // REPLACE_TEXT, but we don't change content — only fill.
                app.findTextPreferences = NothingEnum.NOTHING;
                app.changeTextPreferences = NothingEnum.NOTHING;
                app.findTextPreferences.findWhat = tcFind;
                var hits = [];
                try { hits = doc.findText(); } catch (e) {}
                app.findTextPreferences = NothingEnum.NOTHING;
                for (var hi = 0; hi < hits.length; hi++) {
                    safe(function () {
                        hits[hi].fillColor = tcSwatch;
                        tcStamped++;
                    }, "SET_TEXT_COLOR hit " + hi);
                }
            }
            // Coord-based fallback: walk paragraphs in any text frame
            // whose bounds contain the annotation point. Recolor every
            // paragraph the point lands inside (usually one).
            if (tcStamped === 0 && tcCoords && tcCoords.length >= 2) {
                var tpx = tcCoords[0], tpy = tcCoords[1];
                var pageObj = tcPage ? doc.pages[tcPage - 1] : null;
                var tfList = pageObj ? pageObj.textFrames : doc.textFrames;
                for (var fi = 0; fi < tfList.length; fi++) {
                    var tfb = null; try { tfb = tfList[fi].geometricBounds; } catch (e) {}
                    if (!tfb || tfb.length < 4) continue;
                    if (tpx < tfb[1] - 2 || tpx > tfb[3] + 2 || tpy < tfb[0] - 2 || tpy > tfb[2] + 2) continue;
                    var paras; try { paras = tfList[fi].paragraphs; } catch (e) { continue; }
                    for (var pi2 = 0; pi2 < paras.length; pi2++) {
                        safe(function () {
                            paras[pi2].fillColor = tcSwatch;
                            tcStamped++;
                        }, "SET_TEXT_COLOR para " + pi2);
                    }
                    if (tcStamped > 0) break;
                }
            }
            if (tcStamped > 0) {
                L("  recolored " + tcStamped + " text run(s) → " + tcColorSpec);
            } else {
                FLAG("SET_TEXT_COLOR: no matching text found for find='" +
                     (tcFind || "(none)") + "' at " + (tcCoords ? tcCoords.join(",") : "?"));
            }
            return;
        }

        if (op === "SET_TEXT_SIZE_MATCH") {
            // "Make this text same size as other fields." Two paths:
            //   (1) Cell path — annotation lands in a real table cell.
            //       Walk sibling cells in the same table, tally pointSize
            //       per character, apply mode to the target cell.
            //   (2) Frame path — form is built from individual text
            //       frames (no table). Find target frame at coords, tally
            //       pointSize across every OTHER text frame on the page,
            //       apply mode to target frame.
            // The cell path is tried first; if anything goes wrong locating
            // its table or finding usable siblings, we fall through to the
            // frame path silently.
            var smTarget = edit.target || {};
            var smPage = smTarget.page;
            var smCoords = smTarget.at_pdf_coords;
            if (!smPage || !smCoords || smCoords.length < 2) {
                FLAG("SET_TEXT_SIZE_MATCH: missing target.page/at_pdf_coords");
                return;
            }
            var smPx = smCoords[0], smPy = smCoords[1];

            // -------- helper: heuristic for "looks like a form label"
            // A short paragraph ending with `:` (stripping trailing
            // whitespace). Matches things like "ZIP Code:", "Tax ID #:",
            // "State:" — the things the reviewer would naturally call
            // "other fields" in a form layout.
            function isLabelLike(textObj) {
                var s = "";
                try { s = String(textObj.contents || ""); } catch (e) { return false; }
                s = s.replace(/[\s ]+$/, "");
                if (s.length === 0 || s.length > 40) return false;
                return s.charAt(s.length - 1) === ":";
            }

            // -------- helper: pick modal paragraph-style from a list of
            // texts, weighted by character count. Returns
            //   { style, weight, sampleCount } or null.
            // Style is identified by its .id property (stable across
            // edits). The returned `style` is the actual ParagraphStyle
            // object so we can apply it directly.
            function tallyModalParaStyle(texts) {
                var weightById = {};
                var styleById = {};
                var sampled = 0;
                for (var ti = 0; ti < texts.length; ti++) {
                    var t = texts[ti];
                    if (!t) continue;
                    var c = "";
                    try { c = String(t.contents || ""); } catch (e) {}
                    var bareLen = c.replace(/\s/g, "").length;
                    if (bareLen === 0) continue;
                    var aps = null;
                    try { aps = t.appliedParagraphStyle; } catch (e) {}
                    if (!aps) continue;
                    var sid = null;
                    try { sid = aps.id; } catch (e) {}
                    if (sid == null) continue;
                    sampled++;
                    weightById[sid] = (weightById[sid] || 0) + bareLen;
                    styleById[sid] = aps;
                }
                if (sampled === 0) return null;
                var bestId = null, bestW = 0;
                for (var k in weightById) {
                    if (weightById[k] > bestW) { bestW = weightById[k]; bestId = k; }
                }
                if (bestId == null) return null;
                return { style: styleById[bestId], weight: bestW, sampleCount: sampled };
            }

            // -------- helper: pick modal pointSize from a list of texts.
            // texts: array of objects each with .characters collection.
            // skipTextRef: optional reference to skip (don't sample target itself).
            // Returns { bestSize, bestWeight, sampleCount } or null.
            function tallyModalSize(texts, skipTextRef) {
                var weights = {};
                var sampled = 0;
                for (var ti = 0; ti < texts.length; ti++) {
                    var t = texts[ti];
                    if (!t || t === skipTextRef) continue;
                    var contents = "";
                    try { contents = String(t.contents || ""); } catch (e) {}
                    if (!contents || contents.replace(/\s/g, "").length === 0) continue;
                    sampled++;
                    var chars = null;
                    try { chars = t.characters; } catch (e) {}
                    if (!chars) continue;
                    for (var ci = 0; ci < chars.length; ci++) {
                        var ch = chars[ci];
                        var chTxt = "";
                        try { chTxt = String(ch.contents || ""); } catch (e) {}
                        if (!chTxt || chTxt.replace(/\s/g, "").length === 0) continue;
                        var ps = null;
                        try { ps = ch.pointSize; } catch (e) {}
                        if (typeof ps !== "number") continue;
                        var key = String(Math.round(ps * 10) / 10);
                        weights[key] = (weights[key] || 0) + 1;
                    }
                }
                if (sampled === 0) return null;
                var best = null, bestW = 0;
                for (var k in weights) {
                    if (weights[k] > bestW) {
                        bestW = weights[k];
                        best = parseFloat(k);
                    }
                }
                if (best == null || isNaN(best)) return null;
                return { bestSize: best, bestWeight: bestW, sampleCount: sampled };
            }

            var smFindEarly = (edit.target && edit.target.find) ? String(edit.target.find) : "";

            // -------- cell path
            var smCell = findCellAtCoords(smPage, smPx, smPy);
            // Verify the cell actually contains the marked text — when
            // forms are laid out as a mix of tables + standalone frames,
            // findCellAtCoords' coord triangulation can pull a nearby
            // unrelated cell. If we have a `find` hint and the cell's
            // contents don't include it, drop the cell ref so we use the
            // paragraph path instead.
            if (smCell && smFindEarly) {
                var smCellContents = "";
                try { smCellContents = String(smCell.contents || ""); } catch (e) {}
                if (smCellContents.indexOf(smFindEarly) < 0) {
                    L("  SET_TEXT_SIZE_MATCH: cell at coords doesn't contain '" +
                      smFindEarly + "', falling back to paragraph path");
                    smCell = null;
                }
            }
            if (smCell) {
                var smTbl = null;
                try { smTbl = smCell.parentRow.parent; } catch (e) {}
                if (!smTbl || !smTbl.rows) {
                    try { smTbl = smCell.parent; } catch (e) {}
                }
                if (smTbl && smTbl.rows) {
                    var siblingTexts = [];
                    var targetCellText = null;
                    try { targetCellText = smCell.texts[0]; } catch (e) {}
                    try {
                        for (var smR = 0; smR < smTbl.rows.length; smR++) {
                            var rowCells = null;
                            try { rowCells = smTbl.rows[smR].cells; } catch (e) {}
                            if (!rowCells) continue;
                            for (var smC = 0; smC < rowCells.length; smC++) {
                                var sib = rowCells[smC];
                                if (!sib || sib === smCell) continue;
                                try { siblingTexts.push(sib.texts[0]); } catch (e) {}
                            }
                        }
                    } catch (e) {}
                    var cellResult = tallyModalSize(siblingTexts, null);
                    if (cellResult) {
                        var cellCurrent = null;
                        try { cellCurrent = smCell.texts[0].pointSize; } catch (e) {}
                        try {
                            smCell.texts[0].pointSize = cellResult.bestSize;
                            L("  SET_TEXT_SIZE_MATCH p" + smPage + " (cell): " +
                              (typeof cellCurrent === "number" ? cellCurrent : "?") +
                              "pt → " + cellResult.bestSize +
                              "pt (matched " + cellResult.bestWeight +
                              " sibling char(s) across " + cellResult.sampleCount + " cell(s))");
                            return;
                        } catch (e) {
                            FLAG("SET_TEXT_SIZE_MATCH: cell-path apply failed: " + e);
                            // fall through to frame path
                        }
                    }
                }
                // Cell path didn't yield a result — try the frame path.
                L("  SET_TEXT_SIZE_MATCH: cell path didn't find usable siblings, trying frame fallback");
            }

            // -------- paragraph path
            // Form layout is built from paragraphs inside a body text
            // frame, not from a table. Locate the target paragraph using
            // target.find (the label text the reviewer marked) and resize
            // only that paragraph; sample modal pointSize from every
            // OTHER paragraph in the same story so the chosen size
            // reflects "the rest of the form".
            var smFind = (edit.target && edit.target.find) ? String(edit.target.find) : "";
            var smPageObj = null;
            try { smPageObj = doc.pages[smPage - 1]; } catch (e) {}
            if (!smPageObj) {
                FLAG("SET_TEXT_SIZE_MATCH: page " + smPage + " not accessible");
                return;
            }
            // Find the target paragraph. Two strategies, in order:
            //   (a) findText on the doc for smFind. Pick the hit closest
            //       to the annotation coords.
            //   (b) Fall back to walking paragraphs of the smallest text
            //       frame containing the coords; pick the paragraph
            //       whose first-line baseline is closest to smPy.
            var smTarPara = null;
            var smTarStory = null;
            if (smFind && smFind.length > 0) {
                app.findTextPreferences = NothingEnum.NOTHING;
                app.changeTextPreferences = NothingEnum.NOTHING;
                app.findTextPreferences.findWhat = smFind;
                var hits = [];
                try { hits = doc.findText(); } catch (e) {}
                app.findTextPreferences = NothingEnum.NOTHING;
                if (hits && hits.length > 0) {
                    // Pick the hit whose containing frame matches our page
                    // and whose baseline is closest to smPy.
                    var bestDist = Number.MAX_VALUE;
                    for (var hi2 = 0; hi2 < hits.length; hi2++) {
                        var h = hits[hi2];
                        var hFrames = null;
                        try { hFrames = h.parentTextFrames; } catch (e) {}
                        if (!hFrames || hFrames.length === 0) continue;
                        var hFrame = hFrames[0];
                        var hPage = null;
                        try { hPage = hFrame.parentPage; } catch (e) {}
                        if (!hPage) continue;
                        var hPageNum = -1;
                        try { hPageNum = hPage.documentOffset + 1; } catch (e) {}
                        if (hPageNum < 0) {
                            try { hPageNum = parseInt(hPage.name, 10); } catch (e) {}
                        }
                        if (hPageNum !== smPage) continue;
                        var hBaseline = -1;
                        try { hBaseline = h.lines[0].baseline; } catch (e) {}
                        if (hBaseline < 0) continue;
                        var d = Math.abs(hBaseline - smPy);
                        if (d < bestDist) {
                            bestDist = d;
                            try { smTarPara = h.paragraphs[0]; } catch (e) {}
                            try { smTarStory = h.parentStory; } catch (e) {}
                        }
                    }
                }
            }
            // Fallback: pick paragraph by baseline-Y inside the containing frame.
            if (!smTarPara) {
                var smPageFrames = null;
                try { smPageFrames = smPageObj.textFrames; } catch (e) {}
                if (!smPageFrames || smPageFrames.length === 0) {
                    FLAG("SET_TEXT_SIZE_MATCH: no text frames on p" + smPage);
                    return;
                }
                var smTarFrame = null;
                var bestArea = Number.MAX_VALUE;
                for (var smFi = 0; smFi < smPageFrames.length; smFi++) {
                    var smFb = null;
                    try { smFb = smPageFrames[smFi].geometricBounds; } catch (e) {}
                    if (!smFb || smFb.length < 4) continue;
                    if (smPx < smFb[1] - 2 || smPx > smFb[3] + 2) continue;
                    if (smPy < smFb[0] - 2 || smPy > smFb[2] + 2) continue;
                    var smArea = (smFb[2] - smFb[0]) * (smFb[3] - smFb[1]);
                    if (smArea < bestArea) {
                        bestArea = smArea;
                        smTarFrame = smPageFrames[smFi];
                    }
                }
                if (!smTarFrame) {
                    FLAG("SET_TEXT_SIZE_MATCH: no text frame at p" + smPage +
                         " (" + smPx + "," + smPy + ")");
                    return;
                }
                var fParas = null;
                try { fParas = smTarFrame.paragraphs; } catch (e) {}
                if (fParas) {
                    var paraDist = Number.MAX_VALUE;
                    for (var pix = 0; pix < fParas.length; pix++) {
                        var pBaseline = -1;
                        try { pBaseline = fParas[pix].lines[0].baseline; } catch (e) {}
                        if (pBaseline < 0) continue;
                        var pd = Math.abs(pBaseline - smPy);
                        if (pd < paraDist) {
                            paraDist = pd;
                            smTarPara = fParas[pix];
                        }
                    }
                }
                try { smTarStory = smTarFrame.parentStory; } catch (e) {}
            }
            if (!smTarPara || !smTarStory) {
                FLAG("SET_TEXT_SIZE_MATCH: could not locate target paragraph at p" +
                     smPage + " for find='" + (smFind || "(none)") + "'");
                return;
            }
            // Sample peer paragraphs from EVERY text frame on the page,
            // not just the target's story. Form labels are typically
            // in separate small text frames, so a story-only sample
            // misses them. Skip the target paragraph itself.
            var pageFramesAll = null;
            try { pageFramesAll = smPageObj.textFrames; } catch (e) {}
            var peerParaTexts = [];
            var smTarParaContents = "";
            try { smTarParaContents = String(smTarPara.contents || ""); } catch (e) {}
            if (pageFramesAll) {
                for (var pfi = 0; pfi < pageFramesAll.length; pfi++) {
                    var pfFrame = pageFramesAll[pfi];
                    var pfStory = null;
                    try { pfStory = pfFrame.parentStory; } catch (e) {}
                    if (!pfStory) continue;
                    var pfParas = null;
                    try { pfParas = pfStory.paragraphs; } catch (e) {}
                    if (!pfParas) continue;
                    for (var ppi = 0; ppi < pfParas.length; ppi++) {
                        var pp = pfParas[ppi];
                        var ppc = "";
                        try { ppc = String(pp.contents || ""); } catch (e) {}
                        if (ppc === smTarParaContents) continue;
                        peerParaTexts.push(pp);
                    }
                }
            }
            // Cell paragraphs live in their own stories (not the
            // textFrame's story), so the textFrames walk above misses
            // them. Walk every cell of every table on the same page
            // explicitly. Form labels often live in cells with a "Table
            // body" style, exactly the peers we want to match against.
            for (var smTbi = 0; smTbi < allTables.length; smTbi++) {
                if (allTables[smTbi].page !== smPage) continue;
                var smPgTbl = allTables[smTbi].table;
                if (!smPgTbl || !smPgTbl.rows) continue;
                try {
                    for (var smTRi = 0; smTRi < smPgTbl.rows.length; smTRi++) {
                        var smTRcells = null;
                        try { smTRcells = smPgTbl.rows[smTRi].cells; } catch (e) {}
                        if (!smTRcells) continue;
                        for (var smTCi = 0; smTCi < smTRcells.length; smTCi++) {
                            var smCellSib = smTRcells[smTCi];
                            if (!smCellSib) continue;
                            var smCellParas = null;
                            try { smCellParas = smCellSib.paragraphs; } catch (e) {}
                            if (!smCellParas) continue;
                            for (var smCPi = 0; smCPi < smCellParas.length; smCPi++) {
                                var smCellPara = smCellParas[smCPi];
                                var smCellPC = "";
                                try { smCellPC = String(smCellPara.contents || ""); } catch (e) {}
                                if (smCellPC === smTarParaContents) continue;
                                peerParaTexts.push(smCellPara);
                            }
                        }
                    }
                } catch (e) {}
            }
            // Narrow peer set when the target looks like a form label —
            // a story usually mixes long body paragraphs with short
            // colon-terminated form labels, and the reviewer means "match
            // the OTHER labels" not "match the body". When the target is
            // label-like, filter peers to also-label-like paragraphs.
            // Otherwise sample everything (covers heading/body resize cases).
            var targetIsLabel = isLabelLike(smTarPara);
            var filteredPeers = peerParaTexts;
            if (targetIsLabel) {
                filteredPeers = [];
                for (var fpi = 0; fpi < peerParaTexts.length; fpi++) {
                    if (isLabelLike(peerParaTexts[fpi])) filteredPeers.push(peerParaTexts[fpi]);
                }
                // Don't fall back to all peers if the filter empties out —
                // a body-paragraph mode would drag the label to body size.
                if (filteredPeers.length === 0) {
                    FLAG("SET_TEXT_SIZE_MATCH: no peer label-like paragraphs on p" + smPage);
                    return;
                }
            }
            // Prefer applying a paragraph STYLE rather than a raw
            // pointSize — that captures all the formatting (size, font,
            // leading, color), which is usually what "match the others"
            // really means. Only fall back to pointSize if the peers
            // disagree on style (no clear modal).
            var styleResult = tallyModalParaStyle(filteredPeers);
            var targetCurrentStyleName = "?";
            try { targetCurrentStyleName = smTarPara.appliedParagraphStyle.name; } catch (e) {}
            if (styleResult) {
                var newStyleName = "?";
                try { newStyleName = styleResult.style.name; } catch (e) {}
                if (newStyleName === targetCurrentStyleName) {
                    // Same style already — just clear local overrides
                    // that drifted the appearance, then resample size.
                    try { smTarPara.applyParagraphStyle(styleResult.style, true); } catch (e) {}
                    L("  SET_TEXT_SIZE_MATCH p" + smPage + " (para): '" +
                      String(smTarPara.contents || "").substring(0, 40) +
                      "' style already '" + targetCurrentStyleName +
                      "', cleared local overrides (matched " + styleResult.weight +
                      " peer char(s) across " + styleResult.sampleCount + " paragraph(s))");
                    return;
                }
                try {
                    smTarPara.applyParagraphStyle(styleResult.style, true);
                    L("  SET_TEXT_SIZE_MATCH p" + smPage + " (para): '" +
                      String(smTarPara.contents || "").substring(0, 40) +
                      "' style '" + targetCurrentStyleName + "' → '" + newStyleName +
                      "' (matched " + styleResult.weight +
                      " peer char(s) across " + styleResult.sampleCount + " paragraph(s))");
                    return;
                } catch (e) {
                    FLAG("SET_TEXT_SIZE_MATCH: failed to apply paragraph style: " + e);
                    // fall through to pointSize fallback
                }
            }
            // Pointsize-only fallback (peers disagree on style).
            var paraResult = tallyModalSize(filteredPeers, null);
            if (!paraResult) {
                FLAG("SET_TEXT_SIZE_MATCH: no usable style or pointSize across peer paragraphs on p" + smPage);
                return;
            }
            var paraCurrent = null;
            try { paraCurrent = smTarPara.pointSize; } catch (e) {}
            try {
                smTarPara.pointSize = paraResult.bestSize;
                L("  SET_TEXT_SIZE_MATCH p" + smPage + " (para): '" +
                  String(smTarPara.contents || "").substring(0, 40) + "' " +
                  (typeof paraCurrent === "number" ? paraCurrent : "?") +
                  "pt → " + paraResult.bestSize +
                  "pt (matched " + paraResult.bestWeight +
                  " peer char(s) across " + paraResult.sampleCount + " paragraph(s); style mode unclear)");
            } catch (e) {
                FLAG("SET_TEXT_SIZE_MATCH: failed to set paragraph pointSize: " + e);
            }
            return;
        }

        if (op === "SET_CELL_VALUE") {
            var tbl3 = resolveTable(edit.target);
            if (!tbl3) { FLAG("SET_CELL_VALUE: could not resolve table"); return; }
            markTableModified(tbl3);
            var col = (edit.target && edit.target.column != null) ? edit.target.column : (tbl3.columns.length - 1);
            var rowMatch = edit.target && edit.target.row_match;
            var rowIndex = edit.target && edit.target.row_index;
            var headerRows3 = tbl3.headerRowCount;
            var rowIdx2 = -1;
            if (rowIndex != null) rowIdx2 = rowIndex;
            else if (rowMatch) {
                var needle3 = String(rowMatch).toLowerCase();
                for (var r = headerRows3; r < tbl3.rows.length; r++) {
                    var nameCell2 = String(tbl3.rows[r].cells[0].contents || "").toLowerCase();
                    if (nameCell2.indexOf(needle3) === 0) { rowIdx2 = r; break; }
                }
            }
            if (rowIdx2 < 0) { FLAG("SET_CELL_VALUE: row matching '" + rowMatch + "' not found"); return; }
            var text = (edit.params && edit.params.text != null) ? edit.params.text : "";
            // If text is a check-mark indicator, use Wingdings glyph
            if (text === "\u2713" || text === "CHECK" || text === "CHECKMARK") {
                tbl3.rows[rowIdx2].cells[col].contents = String.fromCharCode(61692);
                try { tbl3.rows[rowIdx2].cells[col].characters[0].appliedFont = app.fonts.itemByName("Wingdings\tRegular"); } catch (e) {}
            } else {
                tbl3.rows[rowIdx2].cells[col].contents = String(text);
            }
            L("  set row " + rowIdx2 + " col " + col + " = '" + String(text).substring(0, 30) + "'");
            return;
        }

        if (op === "SORT_TABLE") {
            var tbl4 = resolveTable(edit.target);
            if (!tbl4) { FLAG("SORT_TABLE: could not resolve table"); return; }
            markTableModified(tbl4);
            var sortCol = (edit.params && edit.params.column != null) ? edit.params.column : 0;
            var headerRows4 = tbl4.headerRowCount;
            var snap = [];
            for (var r = headerRows4; r < tbl4.rows.length; r++) {
                var rowCells = [];
                for (var c = 0; c < tbl4.columns.length; c++) {
                    var cell = tbl4.rows[r].cells[c];
                    rowCells.push({
                        contents: cell.contents,
                        format: snapshotCellFormat(cell)
                    });
                }
                snap.push({
                    sortKey: String(rowCells[sortCol].contents || "").toLowerCase().replace(/^\s+/, ""),
                    cells: rowCells
                });
            }
            snap.sort(function(a, b) { return a.sortKey < b.sortKey ? -1 : (a.sortKey > b.sortKey ? 1 : 0); });
            for (var r = 0; r < snap.length; r++) {
                for (var c = 0; c < tbl4.columns.length; c++) {
                    applyCellFormat(tbl4.rows[headerRows4 + r].cells[c], snap[r].cells[c].format, snap[r].cells[c].contents);
                }
            }
            L("  sorted " + snap.length + " body row(s) by column " + sortCol);
            return;
        }

        // ---- Reference-file operations (multi-file aware) ----
        if (op === "APPEND_PAGES_FROM_INDD") {
            var srcPath = edit.target && edit.target.file_path;
            if (!srcPath) { FLAG("APPEND_PAGES_FROM_INDD: no file_path"); return; }
            var heading = (edit.params && edit.params.heading) ? String(edit.params.heading) : null;
            try {
                // Capture host doc's master from the LAST existing content page
                var hostMaster = null;
                try { if (doc.pages.length >= 1) hostMaster = doc.pages.lastItem().appliedMaster; } catch (e) {}

                if (heading) {
                    // STRATEGY A: place .indd as an INSET on a new page using the
                    // host master, with the heading at the top — matches the rest
                    // of the doc visually.
                    //
                    // Approach: locate an EXISTING heading frame in the doc whose
                    // first paragraph uses one of the TOC source styles. Duplicate
                    // it to the new page (preserves color/font/position exactly),
                    // then change its text. This is far more reliable than
                    // applying a paragraph style cold — many doc heading styles
                    // are designed for white-on-blue placement and rely on master
                    // geometry that isn't replicated on a fresh page.

                    // 1. Discover TOC source styles (paragraph styles the TOC pulls from).
                    var tocSourceStyles = [];
                    try {
                        for (var tsi = 0; tsi < doc.tocStyles.length; tsi++) {
                            var tcs = doc.tocStyles[tsi];
                            if (String(tcs.name) === "[No TOC Style]") continue;
                            try {
                                for (var ei = 0; ei < tcs.tocStyleEntries.length; ei++) {
                                    var entry = tcs.tocStyleEntries[ei];
                                    var srcName = null;
                                    try { srcName = String(entry.styleName || ""); } catch (e) {}
                                    if (!srcName) { try { srcName = String(entry.name || ""); } catch (e) {} }
                                    if (srcName) tocSourceStyles.push(srcName);
                                }
                            } catch (e) { L("  tocStyleEntries err: " + e); }
                        }
                    } catch (e) {}
                    L("  TOC source styles: " + tocSourceStyles.join(", "));

                    function _bareName(nm) {
                        if (!nm) return nm;
                        return nm.indexOf(":") >= 0 ? nm.substring(nm.lastIndexOf(":") + 1) : nm;
                    }
                    function _matchesAnyTocStyle(styleName) {
                        if (!styleName) return false;
                        var sn = String(styleName);
                        for (var k = 0; k < tocSourceStyles.length; k++) {
                            if (sn === tocSourceStyles[k] || sn === _bareName(tocSourceStyles[k])) return true;
                        }
                        return false;
                    }

                    // 2. Walk the doc FRONT-TO-BACK looking for a textFrame whose
                    //    first paragraph uses one of the TOC source styles AND has
                    //    real visible content. Searching front-to-back avoids
                    //    cloning a previously-broken append page if the user feeds
                    //    in a prior _v06 output as the source.
                    var templateFrame = null;
                    var templateParaStyle = null;
                    var templatePageMaster = null;
                    try {
                        for (var pi = 0; pi < doc.pages.length && !templateFrame; pi++) {
                            var pg = doc.pages[pi];
                            for (var fi = 0; fi < pg.textFrames.length; fi++) {
                                var tf = pg.textFrames[fi];
                                try {
                                    if (tf.paragraphs.length === 0) continue;
                                    var pStyleNm = String(tf.paragraphs[0].appliedParagraphStyle.name);
                                    if (!_matchesAnyTocStyle(pStyleNm)) continue;
                                    // Skip empty/whitespace-only frames — these
                                    // are usually previous broken append pages.
                                    var raw = String(tf.contents || "");
                                    if (raw.replace(/\s+/g, "").length < 3) continue;
                                    templateFrame = tf;
                                    templateParaStyle = tf.paragraphs[0].appliedParagraphStyle;
                                    try { templatePageMaster = pg.appliedMaster; } catch (e) {}
                                    L("  cloning heading frame from page " + (pi+1) + " (style='" + pStyleNm + "', content='" + raw.substring(0, 40) + "', master='" + (templatePageMaster && templatePageMaster.name) + "')");
                                    break;
                                } catch (e) {}
                            }
                        }
                    } catch (e) { L("  template-search err: " + e); }

                    var newPage = doc.pages.add(LocationOptions.AT_END);
                    // Prefer the template page's master so the cloned heading
                    // lands in its proper visual context (e.g. inside the blue
                    // section-divider band). Fall back to the host master.
                    var useMaster = templatePageMaster || hostMaster;
                    if (useMaster) try { newPage.appliedMaster = useMaster; } catch (e) {}

                    // Page bounds (in inches): [y1, x1, y2, x2]
                    var pb = newPage.bounds;
                    var pageMargins = newPage.marginPreferences;
                    var marginTop    = pageMargins.top    || 0.5;
                    var marginBottom = pageMargins.bottom || 0.5;
                    var marginLeft   = pageMargins.left   || 0.5;
                    var marginRight  = pageMargins.right  || 0.5;

                    var hdrFrame = null;
                    var hdrBottom = pb[0] + marginTop + 0.7;  // default reserved heading band

                    // 3a. If we found a template frame: duplicate to new page, swap
                    //     text WITHOUT clobbering the paragraph style. .contents=
                    //     replaces all paragraphs and resets the applied style to
                    //     [Basic Paragraph] — so we capture the style first, replace
                    //     contents, then re-apply.
                    if (templateFrame) {
                        try {
                            var dup = templateFrame.duplicate(newPage);
                            var savedStyle = templateParaStyle;
                            // Capture original char fill from the template's first char
                            //  so we can re-apply if the para-style fill is paper-white
                            //  (which would be invisible on a non-blue page).
                            var origFill = null;
                            try { origFill = dup.paragraphs[0].fillColor; } catch (e) {}

                            // Replace contents — this resets the applied paragraph
                            // style, so we must re-apply.
                            dup.contents = heading;
                            try {
                                if (savedStyle) {
                                    dup.paragraphs[0].appliedParagraphStyle = savedStyle;
                                }
                            } catch (e) { L("  re-apply style err: " + e); }

                            // If the resulting fill color is paper/white, the heading
                            //  will be invisible on a white page background. Force a
                            //  visible color (Black) in that case.
                            try {
                                var pf = dup.paragraphs[0].fillColor;
                                var pfName = pf && pf.name ? String(pf.name) : "";
                                if (/paper|white/i.test(pfName)) {
                                    var blk = doc.swatches.itemByName("Black");
                                    if (blk && blk.isValid) {
                                        dup.paragraphs[0].fillColor = blk;
                                        L("  overrode paper/white fill → Black for visibility");
                                    }
                                }
                            } catch (e) {}

                            hdrFrame = dup;
                            try {
                                var gb = dup.geometricBounds;  // [y1, x1, y2, x2]
                                hdrBottom = gb[2];
                            } catch (e) {}
                            try { dup.bringToFront(); } catch (e) {}
                            L("  duplicated template heading frame; bottom=" + hdrBottom);
                        } catch (e) {
                            L("  duplicate template-frame err: " + e);
                            templateFrame = null;
                        }
                    }

                    // 3b. Fallback: build a plain heading frame, apply a TOC source style.
                    if (!hdrFrame) {
                        var hdrTop = pb[0] + marginTop;
                        hdrBottom = hdrTop + 0.7;
                        hdrFrame = newPage.textFrames.add({
                            geometricBounds: [hdrTop, pb[1] + marginLeft, hdrBottom, pb[3] - marginRight]
                        });
                        hdrFrame.contents = heading;

                        function _findStyleByName(nm) {
                            if (!nm) return null;
                            try {
                                var bare = _bareName(nm);
                                for (var i = 0; i < doc.paragraphStyles.length; i++) {
                                    var ps = doc.paragraphStyles[i];
                                    if (String(ps.name) === nm || String(ps.name) === bare) return ps;
                                }
                                for (var g = 0; g < doc.paragraphStyleGroups.length; g++) {
                                    var grp = doc.paragraphStyleGroups[g];
                                    for (var j = 0; j < grp.paragraphStyles.length; j++) {
                                        var gps = grp.paragraphStyles[j];
                                        if (String(gps.name) === bare) return gps;
                                    }
                                }
                            } catch (e) {}
                            return null;
                        }

                        var headingStyle = null;
                        try {
                            for (var ti = 0; ti < tocSourceStyles.length; ti++) {
                                var nm0 = tocSourceStyles[ti].toLowerCase();
                                if (/heading|title|section|h1|chapter|page\s*title/.test(nm0)) {
                                    headingStyle = _findStyleByName(tocSourceStyles[ti]);
                                    if (headingStyle) break;
                                }
                            }
                            if (!headingStyle && tocSourceStyles.length > 0) {
                                headingStyle = _findStyleByName(tocSourceStyles[0]);
                            }
                            if (headingStyle) {
                                hdrFrame.paragraphs[0].appliedParagraphStyle = headingStyle;
                                L("  applied fallback heading style: '" + headingStyle.name + "'");
                            }
                        } catch (e) { L("  heading style apply err: " + e); }
                        // Force visible color if style fill is paper/white
                        try {
                            var pf2 = hdrFrame.paragraphs[0].fillColor;
                            var pfName2 = pf2 && pf2.name ? String(pf2.name) : "";
                            if (/paper|white/i.test(pfName2)) {
                                var blk2 = doc.swatches.itemByName("Black");
                                if (blk2 && blk2.isValid) {
                                    hdrFrame.paragraphs[0].fillColor = blk2;
                                    L("  overrode paper/white fill → Black for visibility");
                                }
                            }
                        } catch (e) {}
                        try { hdrFrame.bringToFront(); } catch (e) {}
                    }

                    // 4. Image rectangle below the heading frame.
                    //    a) Add a WHITE backing rectangle covering the entire body
                    //       area so any master-page blue elements (header bands,
                    //       footers) don't bleed through.
                    //    b) Place the .indd inset on top, then shrink the frame to
                    //       the content size so there's no transparent empty space
                    //       around the placed graphic that would let the master
                    //       bleed through.
                    var bodyTop    = hdrBottom + 0.25;
                    var bodyBottom = pb[2] - marginBottom;
                    var bodyLeft   = pb[1] + marginLeft;
                    var bodyRight  = pb[3] - marginRight;
                    var bodyHeight = bodyBottom - bodyTop;
                    var bodyWidth  = bodyRight - bodyLeft;

                    // Resolve Paper (white) and None swatches for explicit fills.
                    var paperSwatch = null, noneSwatch = null;
                    try { paperSwatch = doc.swatches.itemByName("Paper"); if (!paperSwatch.isValid) paperSwatch = null; } catch (e) {}
                    try { noneSwatch  = doc.swatches.itemByName("None");  if (!noneSwatch.isValid)  noneSwatch  = null; } catch (e) {}

                    // White backing — full body area, EXPLICIT Paper fill so it
                    // doesn't inherit the doc's current fill swatch (which may be
                    // a brand blue from the duplicated heading frame's context).
                    try {
                        var bg = newPage.rectangles.add({ geometricBounds: [bodyTop, pb[1], bodyBottom, pb[3]] });
                        if (paperSwatch) bg.fillColor = paperSwatch;
                        if (noneSwatch)  bg.strokeColor = noneSwatch;
                        try { bg.sendToBack(); } catch (e) {}
                        L("  added white backing rect (fill=Paper)");
                    } catch (e) { L("  white-backing err: " + e); }

                    var insetW  = bodyWidth * 0.65;
                    var insetH  = bodyHeight * 0.85;
                    var insetCx = (bodyLeft + bodyRight) / 2;
                    var insetCy = (bodyTop + bodyBottom) / 2;
                    var imgRect = newPage.rectangles.add({
                        geometricBounds: [
                            insetCy - insetH / 2, insetCx - insetW / 2,
                            insetCy + insetH / 2, insetCx + insetW / 2
                        ]
                    });
                    // CRITICAL: explicitly clear the inset rectangle's fill +
                    // stroke. Otherwise it inherits the current default fill
                    // swatch (often a brand color), which shows behind the
                    // placed graphic if the graphic has any transparent area.
                    if (noneSwatch) {
                        try { imgRect.fillColor = noneSwatch; } catch (e) {}
                        try { imgRect.strokeColor = noneSwatch; } catch (e) {}
                    }
                    try {
                        imgRect.place(File(srcPath));
                        imgRect.fit(FitOptions.PROPORTIONALLY);
                        // Shrink the frame to match the content's bounds so no
                        // transparent space lets the master bleed through.
                        try { imgRect.fit(FitOptions.FRAME_TO_CONTENT); } catch (e) {}
                        // Re-center the resized frame within the body area.
                        try {
                            var ng = imgRect.geometricBounds;
                            var nw = ng[3] - ng[1];
                            var nh = ng[2] - ng[0];
                            imgRect.geometricBounds = [
                                insetCy - nh / 2, insetCx - nw / 2,
                                insetCy + nh / 2, insetCx + nw / 2
                            ];
                        } catch (e) {}
                        // Clear fill on the resized frame (some operations re-apply
                        // doc defaults).
                        if (noneSwatch) {
                            try { imgRect.fillColor = noneSwatch; } catch (e) {}
                        }
                        // Apply a thin outline matching the doc's other inset/
                        // image frames. Use Black at 0.5pt — typical brand
                        // hairline. Skip if Black isn't a valid swatch.
                        try {
                            var blkSw = doc.swatches.itemByName("Black");
                            if (blkSw && blkSw.isValid) {
                                imgRect.strokeColor = blkSw;
                                imgRect.strokeWeight = 0.5;
                                try { imgRect.strokeAlignment = StrokeAlignment.OUTSIDE_ALIGNMENT; } catch (e) {}
                                L("  applied 0.5pt black outline to inset frame");
                            }
                        } catch (e) { L("  outline err: " + e); }
                    } catch (e) { L("  inset place err: " + e); }

                    // Make sure heading sits on top of the placed inset.
                    try { hdrFrame.bringToFront(); } catch (e) {}

                    L("  added new page (master='" + (useMaster && useMaster.name) + "') heading='" + heading + "' inset='" + srcPath.split("/").pop() + "'");
                } else {
                    // STRATEGY B (fallback): duplicate the source page(s) at end,
                    // then re-apply host master so layout matches.
                    var src = app.open(File(srcPath), false);
                    var range = (edit.params && edit.params.source_page_range) || null;
                    var startIdx = 0, endIdx = src.pages.length - 1;
                    if (range && range.length === 2) {
                        startIdx = Math.max(0, range[0] - 1);
                        endIdx   = Math.min(src.pages.length - 1, range[1] - 1);
                    }
                    var copied = 0;
                    var firstNewPageIdx = doc.pages.length;
                    for (var pi = startIdx; pi <= endIdx; pi++) {
                        try {
                            src.pages[pi].duplicate(LocationOptions.AT_END, doc.spreads.lastItem());
                            copied++;
                        } catch (e) { L("  page " + pi + " copy err: " + e); }
                    }
                    src.close(SaveOptions.NO);
                    if (hostMaster && copied > 0) {
                        for (var ni = firstNewPageIdx; ni < doc.pages.length; ni++) {
                            try { doc.pages[ni].appliedMaster = hostMaster; } catch (e) {}
                        }
                        L("  applied host master '" + (hostMaster ? hostMaster.name : "?") + "' to " + copied + " new page(s)");
                    }
                    L("  appended " + copied + " page(s) from " + srcPath.split("/").pop());
                    if (copied === 0) FLAG("APPEND_PAGES_FROM_INDD: 0 pages copied");
                }
            } catch (e) {
                FLAG("APPEND_PAGES_FROM_INDD failed for " + srcPath + ": " + e);
            }
            return;
        }

        if (op === "PLACE_ASSET_NEW_PAGE") {
            var assetPath = edit.target && edit.target.file_path;
            if (!assetPath) { FLAG("PLACE_ASSET_NEW_PAGE: no file_path"); return; }
            try {
                var newPage = doc.pages.add(LocationOptions.AT_END);
                // For multi-page PDFs, set which page to import
                var pdfPage = (edit.params && edit.params.source_pdf_page) || 1;
                try { app.pdfPlacePreferences.pageNumber = pdfPage; } catch (e) {}
                // Place at full page bounds
                var pageBounds = newPage.bounds; // [y1, x1, y2, x2]
                var placed = newPage.place(File(assetPath), [pageBounds[0], pageBounds[1]]);
                // Try to fit content to page
                if (placed && placed.length > 0) {
                    try { placed[0].fit(FitOptions.CONTENT_TO_FRAME); } catch (e) {}
                    try { placed[0].geometricBounds = pageBounds; } catch (e) {}
                    try { placed[0].fit(FitOptions.PROPORTIONALLY); } catch (e) {}
                }
                L("  placed " + assetPath.split("/").pop() + " on new page " + newPage.documentOffset);
            } catch (e) {
                FLAG("PLACE_ASSET_NEW_PAGE failed for " + assetPath + ": " + e);
            }
            return;
        }

        if (op === "RELINK_IMAGE") {
            // Re-points an existing placed graphic to a new asset file. Used
            // when a reviewer annotation says "replace [X] logo/image with
            // [filename]" — we want to swap the contents of the EXISTING
            // frame, preserving its position/scale/transforms, not create
            // a new frame.
            //
            //   target.name_match  — case-insensitive substring of the
            //                        graphic's link name to match
            //                        (e.g. "dabo" matches "DABO LOGO reversed.ai")
            //   target.path_match  — optional alternate substring tried if
            //                        name_match misses (matches against the
            //                        full file path, useful when the link
            //                        name is generic but the directory is
            //                        distinctive)
            //   target.page        — optional, scope to one page first
            //                        (defaults to doc-wide)
            //   params.new_file_path — absolute path of the replacement asset
            var newPath = edit.params && edit.params.new_file_path;
            var nameMatch = edit.target && edit.target.name_match;
            var pathMatch = edit.target && edit.target.path_match;
            var scopePage = edit.target && edit.target.page;
            if (!newPath) { FLAG("RELINK_IMAGE: no new_file_path"); return; }
            if (!nameMatch && !pathMatch) { FLAG("RELINK_IMAGE: no name_match or path_match"); return; }
            try {
                var newFile = File(newPath);
                if (!newFile.exists) { FLAG("RELINK_IMAGE: replacement file not found: " + newPath); return; }
                var nameLower = nameMatch ? String(nameMatch).toLowerCase() : null;
                var pathLower = pathMatch ? String(pathMatch).toLowerCase() : null;
                var graphics = doc.allGraphics;
                var relinked = 0, candidates = 0;
                // Two-pass: first the targeted page (if set), then doc-wide
                // if no match on the targeted page. Lets the reviewer scope
                // an ambiguous match by where they placed the sticky note,
                // while still working when the same image lives on multiple
                // pages and they only annotated one.
                function tryRelink(restrictPage) {
                    var hits = 0;
                    for (var g = 0; g < graphics.length; g++) {
                        var gr = graphics[g];
                        var lnk = null;
                        try { lnk = gr.itemLink; } catch (e) {}
                        if (!lnk) continue;
                        var nm = ""; var fp = "";
                        try { nm = String(lnk.name || "").toLowerCase(); } catch (e) {}
                        try { fp = String(lnk.filePath || "").toLowerCase(); } catch (e) {}
                        var matched = false;
                        if (nameLower && nm.indexOf(nameLower) >= 0) matched = true;
                        else if (pathLower && fp.indexOf(pathLower) >= 0) matched = true;
                        if (!matched) continue;
                        candidates++;
                        // Page scoping: walk up to the parent page if asked
                        if (restrictPage) {
                            var p = null;
                            try { p = gr.parentPage; } catch (e) {}
                            if (!p || p.documentOffset + 1 !== restrictPage) continue;
                        }
                        try {
                            lnk.relink(newFile);
                            try { lnk.update(); } catch (e) {}
                            try { gr.fit(FitOptions.PROPORTIONALLY); } catch (e) {}
                            hits++;
                        } catch (e) {
                            FLAG("RELINK_IMAGE relink failed for '" + nm + "': " + e);
                        }
                    }
                    return hits;
                }
                if (scopePage) relinked = tryRelink(scopePage);
                if (relinked === 0) relinked = tryRelink(null);
                if (relinked > 0) {
                    L("  relinked " + relinked + " graphic(s) matching '" +
                      (nameMatch || pathMatch) + "' → " + newPath.split("/").pop());
                } else {
                    FLAG("RELINK_IMAGE: no placed graphic matched '" +
                         (nameMatch || pathMatch) + "' (scanned " + graphics.length + " graphics)");
                }
            } catch (e) {
                FLAG("RELINK_IMAGE failed for " + newPath + ": " + e);
            }
            return;
        }

        if (op === "PLACE_ASSET_IN_FRAME") {
            var assetPath2 = edit.target && edit.target.file_path;
            if (!assetPath2) { FLAG("PLACE_ASSET_IN_FRAME: no file_path"); return; }
            try {
                var pageNum = (edit.target && edit.target.page) || 1;
                var page = doc.pages[pageNum - 1];
                if (!page) { FLAG("PLACE_ASSET_IN_FRAME: page " + pageNum + " not found"); return; }
                var pdfPg = (edit.params && edit.params.source_pdf_page) || 1;
                try { app.pdfPlacePreferences.pageNumber = pdfPg; } catch (e) {}
                var bounds = (edit.target && edit.target.bounds) || null;
                if (!bounds) {
                    // Default: center of page, half size
                    var pb = page.bounds;
                    var cy = (pb[0] + pb[2]) / 2, cx = (pb[1] + pb[3]) / 2;
                    var h = (pb[2] - pb[0]) / 2, w = (pb[3] - pb[1]) / 2;
                    bounds = [cy - h/2, cx - w/2, cy + h/2, cx + w/2];
                }
                var rect = page.rectangles.add({ geometricBounds: bounds });
                rect.place(File(assetPath2));
                try { rect.fit(FitOptions.PROPORTIONALLY); } catch (e) {}
                L("  placed " + assetPath2.split("/").pop() + " on page " + pageNum + " bounds=" + bounds);
            } catch (e) {
                FLAG("PLACE_ASSET_IN_FRAME failed for " + assetPath2 + ": " + e);
            }
            return;
        }

        if (op === "REPLACE_TEXT") {
            var find = edit.target && edit.target.find;
            var replace = edit.params && edit.params.replace_with;
            var isRegex = !!(edit.params && edit.params.is_regex);
            if (!find) { FLAG("REPLACE_TEXT: no find string"); return; }
            // Location scoping: when the classifier passes the
            // annotation's page + rect-center, prefer running find/
            // replace ONLY in the text frame at those coords. A reviewer
            // who struck "Mini" on one specific cell shouldn't trigger a
            // doc-wide replace if the same string appears in another
            // template/cell. Falls back to doc-wide if no frame at the
            // coords (catches cases where the coord is on a hidden layer
            // or the annotation rect is off-frame).
            var scopePageNum = edit.target && edit.target.page;
            var scopeCoords = edit.target && edit.target.at_pdf_coords;
            var scopeContainer = null;  // TextFrame OR Cell to scope find inside
            var scopeKind = "doc";  // for logging
            if (scopePageNum && scopeCoords && scopeCoords.length >= 2) {
                var spx = scopeCoords[0], spy = scopeCoords[1];
                // First preference: a specific Cell. Tables nest inside a
                // text frame's story, but multiple cells (or even nested
                // tables) sharing the same frame would all share the
                // frame as their scope — too coarse. Cell-level scoping
                // means a strike on one cell can't cascade to neighbors.
                scopeContainer = findCellAtCoords(scopePageNum, spx, spy);
                if (scopeContainer) scopeKind = "cell";
                // Second preference: the TextFrame at the coords (for
                // body text outside any table).
                if (!scopeContainer) {
                    try {
                        var sp = doc.pages[scopePageNum - 1];
                        if (sp) {
                            for (var sfi = 0; sfi < sp.textFrames.length; sfi++) {
                                var stf = sp.textFrames[sfi];
                                var sfb = null;
                                try { sfb = stf.geometricBounds; } catch (e) {}
                                if (!sfb || sfb.length < 4) continue;
                                if (spx >= sfb[1] - 5 && spx <= sfb[3] + 5 &&
                                        spy >= sfb[0] - 5 && spy <= sfb[2] + 5) {
                                    scopeContainer = stf;
                                    if (scopeKind === "doc") scopeKind = "frame";
                                    break;
                                }
                            }
                        }
                    } catch (e) {}
                }
                L("  REPLACE_TEXT scope: " + scopeKind + " at p" + scopePageNum +
                  " (" + spx + "," + spy + ") for find=\"" + String(find).substring(0, 40) + "\"");
            }
            // The find/change calls below use this `searchScope`. It can
            // be a Cell, a TextFrame, or the whole Document — they all
            // implement the same find/changeText/changeGrep interface.
            var searchScope = scopeContainer || doc;
            // Validity probe: a Cell or TextFrame ref captured pre-apply
            // can go stale if a prior edit restructured its container.
            // changeText on an invalid object throws "Object is invalid"
            // and aborts the whole edit. Touch a cheap property first;
            // if it throws, drop the scope and run doc-wide instead.
            if (scopeContainer) {
                var probeOK = false;
                try {
                    var _probe = scopeContainer.contents;
                    probeOK = true;
                } catch (e) {}
                if (!probeOK) {
                    L("  REPLACE_TEXT scope object invalid at apply time, falling back to doc-wide");
                    searchScope = doc;
                    scopeContainer = null;
                    scopeKind = "doc";
                }
            }
            // Two modes:
            //   - Literal (default): findText/changeText — find string is taken
            //     as literal characters. $, (, ), . are NOT regex metachars.
            //   - Regex (is_regex=true): findGrep/changeGrep — for cases
            //     where the classifier needs to match a pattern globally
            //     (e.g. "(\\d+)x(\\d+)" → "$1 x $2" applied throughout a doc).
            if (isRegex) {
                app.findGrepPreferences = NothingEnum.NOTHING;
                app.changeGrepPreferences = NothingEnum.NOTHING;
                app.findGrepPreferences.findWhat = find;
                app.changeGrepPreferences.changeTo = String(replace || "");
                var hitsRArr = [];
                try {
                    hitsRArr = searchScope.changeGrep();
                } catch (e) {
                    L("  scoped changeGrep threw (" + e + "), retrying doc-wide");
                    try { hitsRArr = doc.changeGrep(); } catch (e2) {
                        L("  doc-wide changeGrep also threw: " + e2);
                        hitsRArr = [];
                    }
                    searchScope = doc;
                    scopeContainer = null;
                    scopeKind = "doc";
                }
                noteChangedTexts(hitsRArr);
                var hitsR = hitsRArr.length;
                L("  replaced " + hitsR + " occurrence(s) [regex] of \"" + find + "\"");
                app.findGrepPreferences = NothingEnum.NOTHING;
                app.changeGrepPreferences = NothingEnum.NOTHING;
            } else {
                app.findTextPreferences = NothingEnum.NOTHING;
                app.changeTextPreferences = NothingEnum.NOTHING;
                app.findTextPreferences.findWhat = find;
                app.changeTextPreferences.changeTo = String(replace || "");
                // Wrap the changeText call: a stale or otherwise invalid
                // scope (e.g. a Cell whose row was reflowed by a prior
                // edit) throws "Object is invalid" and aborts the whole
                // edit. On failure, fall back to the doc-wide scope so
                // the edit still has a chance.
                var hitsArr = [];
                try {
                    hitsArr = searchScope.changeText();
                } catch (e) {
                    L("  scoped changeText threw (" + e + "), retrying doc-wide");
                    try { hitsArr = doc.changeText(); } catch (e2) {
                        L("  doc-wide changeText also threw: " + e2);
                        hitsArr = [];
                    }
                    searchScope = doc;
                    scopeContainer = null;
                    scopeKind = "doc";
                }
                noteChangedTexts(hitsArr);
                var hits = hitsArr.length;
                app.findTextPreferences = NothingEnum.NOTHING;
                app.changeTextPreferences = NothingEnum.NOTHING;
                if (hits > 0) {
                    L("  replaced " + hits + " occurrence(s) of \"" + find + "\"");
                }

                // Tiered fallback chain when the literal find returns 0.
                // PDF extraction commonly disagrees with the InDesign doc on:
                //   (a) whitespace before punctuation ("measures ." vs "measures.")
                //   (b) leading auto-list prefixes ("10. Facilitate..." in PDF
                //       but no "10. " in InDesign because the number comes from
                //       a paragraph style)
                // We try literal → normalized → de-listed → de-listed+normalized.
                function normalizeWS(s) {
                    // Replace control chars (0x00-0x1F except TAB/LF/CR,
                    // 0x7F-0x9F) and assorted unicode whitespace (NBSP,
                    // en/em/figure/thin/zero-width spaces, ideographic
                    // space) with a regular ASCII space. Done via
                    // charCodeAt to avoid embedding raw control bytes.
                    var out = String(s);
                    var rebuilt = "";
                    for (var i = 0; i < out.length; i++) {
                        var c = out.charCodeAt(i);
                        var isControl = (c < 0x20 && c !== 9 && c !== 10 && c !== 13) ||
                                        (c >= 0x7F && c <= 0x9F);
                        var isExoticSpace = c === 0xA0 ||
                                            (c >= 0x2000 && c <= 0x200B) ||
                                            c === 0x202F || c === 0x205F || c === 0x3000;
                        rebuilt += (isControl || isExoticSpace) ? " " : out.charAt(i);
                    }
                    return rebuilt
                        .replace(/\s+([\.,;:!?\)\]\}])/g, "$1")
                        .replace(/\s{2,}/g, " ")
                        .replace(/^\s+|\s+$/g, "");
                }
                // Build a flexible-whitespace GREP pattern from a literal
                // find: escape regex metachars, then collapse all whitespace
                // runs to `\s+`. Lets the search match across NBSP, soft
                // hyphens, line breaks, etc. that don't appear identically
                // in InDesign.
                function escapeForGrep(s) {
                    return String(s).replace(/[\.\^\$\*\+\?\(\)\[\]\{\}\|\\]/g, "\\$&");
                }
                function flexibleGrep(s) {
                    var escaped = escapeForGrep(s);
                    return escaped.replace(/\s+/g, "\\s+");
                }
                function tryGrep(pattern, replaceTo, label) {
                    if (!pattern) return 0;
                    app.findGrepPreferences = NothingEnum.NOTHING;
                    app.changeGrepPreferences = NothingEnum.NOTHING;
                    app.findGrepPreferences.findWhat = pattern;
                    app.changeGrepPreferences.changeTo = replaceTo;
                    var n = 0;
                    try {
                        var arr = searchScope.changeGrep();
                        noteChangedTexts(arr);
                        n = arr.length;
                    } catch (e) {}
                    app.findGrepPreferences = NothingEnum.NOTHING;
                    app.changeGrepPreferences = NothingEnum.NOTHING;
                    if (n > 0) L("  replaced " + n + " occurrence(s) of \"" + find + "\"" + (label ? " " + label : ""));
                    return n;
                }
                // Strip leading auto-list prefixes: "10. ", "a) ", "iii. ", "• ", "» "
                var LIST_PREFIX_RE = /^(?:\d+[\.\)]|[a-zA-Z][\.\)]|[ivxlcdm]+[\.\)]|[•»‣·])\s+/i;
                function stripList(s) {
                    return String(s).replace(LIST_PREFIX_RE, "");
                }
                function tryLiteral(f, r, label) {
                    if (!f) return 0;
                    app.findTextPreferences = NothingEnum.NOTHING;
                    app.changeTextPreferences = NothingEnum.NOTHING;
                    app.findTextPreferences.findWhat = f;
                    app.changeTextPreferences.changeTo = r;
                    var n = 0;
                    try {
                        var arr = searchScope.changeText();
                        noteChangedTexts(arr);
                        n = arr.length;
                    } catch (e) {}
                    app.findTextPreferences = NothingEnum.NOTHING;
                    app.changeTextPreferences = NothingEnum.NOTHING;
                    if (n > 0) L("  replaced " + n + " occurrence(s) of \"" + find + "\"" + (label ? " " + label : ""));
                    return n;
                }
                if (hits === 0) {
                    var normFind = normalizeWS(find);
                    var normReplace = normalizeWS(String(replace || ""));
                    if (normFind !== find) hits = tryLiteral(normFind, normReplace, "(after whitespace-normalize fallback)");
                }
                if (hits === 0) {
                    var stripped = stripList(find);
                    var strippedReplace = stripList(String(replace || ""));
                    if (stripped !== find) hits = tryLiteral(stripped, strippedReplace, "(after list-prefix-strip fallback)");
                    if (hits === 0) {
                        var both = normalizeWS(stripped);
                        var bothReplace = normalizeWS(strippedReplace);
                        if (both !== stripped) hits = tryLiteral(both, bothReplace, "(after list-prefix-strip + whitespace-normalize fallback)");
                    }
                }
                // Flexible-whitespace GREP fallback. Builds a pattern from
                // the normalized find with all whitespace runs replaced by
                // \s+ so it matches even when InDesign uses NBSPs, soft
                // hyphens, or different spacing than the PDF extraction.
                if (hits === 0) {
                    var normFind2 = normalizeWS(find);
                    if (normFind2.length >= 6) {
                        var grepPat = flexibleGrep(normFind2);
                        var grepReplace = normalizeWS(String(replace || ""));
                        hits = tryGrep(grepPat, grepReplace, "(after flexible-WS GREP fallback)");
                    }
                }
                // Last resort: marked-scoped fallback (just the changed token,
                // not the whole line). Used for strike+comment edits where
                // the line_text from PDF doesn't reconstruct InDesign's text
                // (cell boundaries, non-breaking spaces, threaded frames).
                // Python only emits this when marked is unique-enough (≥ 5
                // alphanumeric chars), so the global-scope replace stays safe.
                if (hits === 0) {
                    var fbFind = edit.target && edit.target.fallback_find;
                    var fbReplace = edit.params && edit.params.fallback_replace_with;
                    if (fbFind && fbReplace !== undefined) {
                        hits = tryLiteral(fbFind, fbReplace, "(after marked-scoped fallback)");
                    }
                }
                // Context-extended fallback for short marked tokens (e.g.
                // "from"+1-word-context = "be from Attic"). Try both literal
                // and flex-WS GREP variants since cell-boundary text often
                // has irregular spacing.
                if (hits === 0) {
                    var fb2Find = edit.target && edit.target.fallback2_find;
                    var fb2Replace = edit.params && edit.params.fallback2_replace_with;
                    if (fb2Find && fb2Replace !== undefined) {
                        hits = tryLiteral(fb2Find, fb2Replace, "(after context-extended fallback)");
                        if (hits === 0) {
                            var grepPat2 = flexibleGrep(normalizeWS(fb2Find));
                            hits = tryGrep(grepPat2, normalizeWS(fb2Replace), "(after context-extended GREP fallback)");
                        }
                    }
                }
                // Cell-direct patch fallback. doc.changeText / TextFrame
                // .changeText sometimes report "1 occurrence replaced"
                // for find strings inside table cells but don't actually
                // mutate the cell — InDesign quirk specifically with
                // mixed-format cells. This pass walks every cell in the
                // search scope and, if any cell still contains the find
                // string, patches it via a character-range assignment
                // (preserves surrounding formatting). Catches both the
                // false-success case AND any case where changeText
                // genuinely missed a cell.
                var cellHits = 0;
                try {
                    cellHits = applyCellPatch(searchScope, find, String(replace || ""));
                } catch (e) {
                    L("  applyCellPatch threw (" + e + "), skipping cell-direct fallback");
                    cellHits = 0;
                }
                if (cellHits > 0) {
                    hits += cellHits;
                    L("  replaced " + cellHits + " occurrence(s) of \"" + find + "\" via cell-direct patch");
                }
                // Order-dependency fallback. Two edits on the same cell
                // can collide: edit A changes "§" to "‡" first, then
                // edit B with find="…Discounts§" matches nothing because
                // the cell now reads "…Discounts‡". When the literal
                // patch above misses, retry the find with common
                // single-char substitutions that earlier edits may have
                // already applied (§↔‡, †↔‡, etc.). Applies only inside
                // the existing scope so it's safe.
                if (cellHits === 0 && hits === 0) {
                    // Use \u escapes — when the .jsx is read by
                    // ExtendScript without an explicit encoding, raw
                    // multi-byte chars in source become mojibake and
                    // indexOf misses. §=§, ‡=‡, †=†.
                    var SECT = "\u00A7", DDAG = "\u2021", DAG = "\u2020";
                    var subPairs = [
                        [SECT, DDAG], [DDAG, SECT],
                        [DAG, DDAG],  [DDAG, DAG],
                        [SECT, DAG],  [DAG, SECT]
                    ];
                    for (var spi = 0; spi < subPairs.length; spi++) {
                        var fromCh = subPairs[spi][0];
                        var toCh = subPairs[spi][1];
                        if (String(find).indexOf(fromCh) < 0) continue;
                        var altFind = String(find).split(fromCh).join(toCh);
                        var altReplace = String(replace || "").split(fromCh).join(toCh);
                        var altHits = 0;
                        try { altHits = applyCellPatch(searchScope, altFind, altReplace); } catch (e) { altHits = 0; }
                        if (altHits > 0) {
                            hits += altHits;
                            L("  replaced " + altHits + " occurrence(s) of \"" + altFind +
                              "\" via cell-direct patch (after '" + fromCh + "→" + toCh + "' substitution)");
                            break;
                        }
                    }
                }
                if (hits === 0) {
                    L("  replaced 0 occurrence(s) of \"" + find + "\"");
                }
            }
            return;
        }

        FLAG("Unknown edit op: " + op);
    }

    JT_start("step 4.2: applying edits");
    L("STEP 2: applying edits");
    // Reorder: process DELETE_PAGE last, in REVERSE page order, so earlier
    // deletions don't shift the indices of subsequent ones.
    var nonDeletePage = [], deletePages = [];
    for (var i = 0; i < editPlan.edits.length; i++) {
        if (editPlan.edits[i].op === "DELETE_PAGE") deletePages.push(editPlan.edits[i]);
        else nonDeletePage.push(editPlan.edits[i]);
    }
    deletePages.sort(function(a, b) {
        var pa = (a.target && a.target.page) || 0;
        var pb = (b.target && b.target.page) || 0;
        return pb - pa; // DESC so highest page index deleted first
    });
    var orderedEdits = nonDeletePage.concat(deletePages);
    var pageStructureChanged = false;
    for (var i = 0; i < orderedEdits.length; i++) {
        var op = orderedEdits[i].op;
        if (op === "DELETE_PAGE" || op === "APPEND_PAGES_FROM_INDD" || op === "PLACE_ASSET_NEW_PAGE" || op === "INSERT_ROW_AT") {
            pageStructureChanged = true;
        }
        try { applyEdit(orderedEdits[i]); } catch (e) {
            FLAG("Edit " + i + " failed: " + e + " (op=" + orderedEdits[i].op + ")");
        }
    }

    // If we added or removed pages, the document's TOC text frame is now out
    // of sync. Regenerate via the doc's TOC style. Also enable PDF bookmarks
    // + hyperlinks on each TOC style so exported PDF has clickable entries.
    if (pageStructureChanged) {
        try {
            var tocStylesAvailable = doc.tocStyles;
            for (var ts = 0; ts < tocStylesAvailable.length; ts++) {
                var tocStyle = tocStylesAvailable[ts];
                if (tocStyle.name === "[No TOC Style]") continue;
                try {
                    // Capture the TOC source-style names BEFORE createTOC, since
                    // some DOM properties may get reset during regeneration.
                    var sourceStyleNames = {};
                    var sourceStyleObjects = [];  // actual ParagraphStyle objects
                    for (var ei = 0; ei < tocStyle.tocStyleEntries.length; ei++) {
                        try {
                            var en = tocStyle.tocStyleEntries[ei];
                            var nm = "";
                            try { nm = String(en.styleName || ""); } catch (e) {}
                            if (!nm) { try { nm = String(en.name || ""); } catch (e) {} }
                            if (!nm) continue;
                            sourceStyleNames[nm] = true;
                            var bare = nm.indexOf(":") >= 0 ? nm.substring(nm.lastIndexOf(":") + 1) : nm;
                            sourceStyleNames[bare] = true;
                            // Resolve to actual style object for direct comparison
                            try {
                                for (var i = 0; i < doc.paragraphStyles.length; i++) {
                                    var ps = doc.paragraphStyles[i];
                                    if (String(ps.name) === nm || String(ps.name) === bare) {
                                        sourceStyleObjects.push(ps); break;
                                    }
                                }
                                for (var g = 0; g < doc.paragraphStyleGroups.length; g++) {
                                    var grp = doc.paragraphStyleGroups[g];
                                    for (var j = 0; j < grp.paragraphStyles.length; j++) {
                                        var gps = grp.paragraphStyles[j];
                                        if (String(gps.name) === bare) {
                                            sourceStyleObjects.push(gps); break;
                                        }
                                    }
                                }
                            } catch (e) {}
                        } catch (e) {}
                    }
                    var ssNames = [];
                    for (var k in sourceStyleNames) { ssNames.push(k); }
                    L("  TOC source style names: [" + ssNames.join(", ") + "] resolved " + sourceStyleObjects.length + " style object(s)");

                    // The user's source .indd already has working TOC hyperlinks
                    // — we just need createTOC to PRESERVE those and add a link
                    // for the new appended page. Keep auto-bookmarks ON; the
                    // PDF preset (CMYK Web) handles the rest at export time.
                    try { tocStyle.createPDFBookmarks = true; } catch (e) {}
                    try { tocStyle.makeTextAnchor     = true; } catch (e) {}
                    var tocStory = doc.createTOC(tocStyle, true);
                    L("  Updated TOC using style: " + tocStyle.name);

                    // Programmatic clickable-TOC: walk the regenerated TOC story,
                    // for each entry find the matching source heading paragraph,
                    // create a HyperlinkTextDestination at the source, and create
                    // a Hyperlink from the TOC entry text to that destination.
                    // This is independent of createPDFBookmarks honoring.
                    try {
                        // Collect source heading paragraphs across the doc.
                        // Match on style OBJECT identity OR name (handles group prefixes).
                        var sourceParas = [];  // {text, para, page}
                        for (var pgi = 0; pgi < doc.pages.length; pgi++) {
                            var pageObj = doc.pages[pgi];
                            for (var tfi = 0; tfi < pageObj.textFrames.length; tfi++) {
                                var tfo = pageObj.textFrames[tfi];
                                try {
                                    for (var pa = 0; pa < tfo.paragraphs.length; pa++) {
                                        var paraO = tfo.paragraphs[pa];
                                        var paraStyle = paraO.appliedParagraphStyle;
                                        var pNm = String(paraStyle.name);
                                        var matched = !!sourceStyleNames[pNm];
                                        if (!matched) {
                                            for (var so = 0; so < sourceStyleObjects.length; so++) {
                                                if (sourceStyleObjects[so] === paraStyle) { matched = true; break; }
                                                try {
                                                    if (String(sourceStyleObjects[so].id) === String(paraStyle.id)) { matched = true; break; }
                                                } catch (e) {}
                                            }
                                        }
                                        if (!matched) continue;
                                        var ptxt = String(paraO.contents || "").replace(/[\r\n]+/g, " ").replace(/\s+/g, " ");
                                        ptxt = ptxt.replace(/^\s+/, "").replace(/\s+$/, "");
                                        if (!ptxt) continue;
                                        sourceParas.push({ text: ptxt, para: paraO, page: pageObj });
                                    }
                                } catch (e) {}
                            }
                        }
                        L("  found " + sourceParas.length + " heading source paragraph(s) for TOC linking");
                        if (sourceParas.length > 0) {
                            var preview = "";
                            for (var sp = 0; sp < Math.min(sourceParas.length, 5); sp++) {
                                preview += " | '" + sourceParas[sp].text.substring(0, 30) + "'";
                            }
                            L("  TOC sources preview:" + preview);
                        }

                        // Resolve the TOC story. createTOC() may return a single
                        // Story or an Array of stories depending on doc state.
                        var tocStoryObj = tocStory;
                        try {
                            if (tocStory && tocStory.length !== undefined && tocStory.length > 0 && !tocStory.paragraphs) {
                                tocStoryObj = tocStory[0];
                            }
                        } catch (e) {}
                        var tocParaCount = 0;
                        try { tocParaCount = tocStoryObj && tocStoryObj.paragraphs ? tocStoryObj.paragraphs.length : 0; } catch (e) {}
                        L("  TOC story has " + tocParaCount + " paragraph(s)");

                        // NB: Do NOT clear existing hyperlinks/bookmarks here.
                        // The source .indd already has working TOC links and
                        // createTOC preserves them when regenerated with
                        // createPDFBookmarks=true.

                        // Walk TOC story paragraphs and link each.
                        // SKIP the linking loop entirely — the doc already has
                        // working TOC hyperlinks and createTOC preserves them.
                        // Set USE_PROGRAMMATIC_TOC_LINKS=true to re-enable if
                        // a future doc lacks pre-built links.
                        var USE_PROGRAMMATIC_TOC_LINKS = false;
                        var linkCount = 0;
                        var posIdx = 0;  // positional index into sourceParas
                        if (USE_PROGRAMMATIC_TOC_LINKS && tocStoryObj && tocStoryObj.paragraphs) {
                            for (var ti = 0; ti < tocStoryObj.paragraphs.length; ti++) {
                                var tocPara = tocStoryObj.paragraphs[ti];
                                var entryTxt = "";
                                try {
                                    entryTxt = String(tocPara.contents || "");
                                } catch (e) {}
                                // Strip ALL non-printable chars (page-number marker
                                // , tab, BOM, etc.) and collapse whitespace
                                var cleaned = entryTxt.replace(/[\x00-\x1F\x7F]/g, " ").replace(/\s+/g, " ").replace(/^\s+|\s+$/g, "");
                                // Strip trailing page number
                                var coreTxt = cleaned.replace(/\s+\d+$/, "").replace(/\s+$/, "");
                                if (ti < 5) L("  TOC entry " + ti + ": '" + coreTxt + "'");
                                if (!coreTxt) continue;

                                // Try text matching first
                                var match = null;
                                for (var si = 0; si < sourceParas.length; si++) {
                                    var stxt = sourceParas[si].text.replace(/[\x00-\x1F\x7F]/g, "").replace(/\s+/g, " ").replace(/^\s+|\s+$/g, "");
                                    if (stxt === coreTxt) { match = sourceParas[si]; break; }
                                    if (stxt.length >= 6 && coreTxt.length >= 6 && (stxt.indexOf(coreTxt) === 0 || coreTxt.indexOf(stxt) === 0)) {
                                        match = sourceParas[si]; break;
                                    }
                                }
                                // Fallback: positional match (TOC entries appear in
                                // doc order, same as our sourceParas scan).
                                if (!match && posIdx < sourceParas.length) {
                                    match = sourceParas[posIdx];
                                    L("  TOC entry " + ti + " positional fallback → '" + match.text.substring(0, 40) + "'");
                                }
                                if (!match) continue;
                                posIdx++;

                                var anchorName = "TOC_" + ti + "_" + (linkCount + 1);
                                var dest = null, destErr = "";
                                try {
                                    dest = doc.hyperlinkTextDestinations.add(match.para.insertionPoints[0], { name: anchorName });
                                } catch (e) {
                                    destErr = String(e);
                                    try { dest = doc.hyperlinkTextDestinations.add(match.para, { name: anchorName }); } catch (ee) { destErr += " | " + ee; }
                                }
                                if (!dest) { L("  dest err entry " + ti + ": " + destErr); continue; }

                                // Build an explicit Text range covering the TOC
                                // paragraph excluding the trailing paragraph mark.
                                var src = null, srcErr = "";
                                var attempts = [
                                    function() {
                                        var nChars = tocPara.characters.length;
                                        if (nChars > 1) {
                                            return tocPara.characters.itemByRange(0, nChars - 2);
                                        }
                                        return tocPara.characters.itemByRange(0, nChars - 1);
                                    },
                                    function() { return tocPara.texts[0]; },
                                    function() { return tocPara; },
                                    function() {
                                        return tocPara.parent.characters.itemByRange(
                                            tocPara.characters[0].index,
                                            tocPara.characters[-2] ? tocPara.characters[-2].index : tocPara.characters[0].index
                                        );
                                    }
                                ];
                                for (var ai = 0; ai < attempts.length && !src; ai++) {
                                    try {
                                        var rng = attempts[ai]();
                                        src = doc.hyperlinkTextSources.add(rng);
                                    } catch (e) {
                                        srcErr += "[" + ai + ":" + String(e) + "] ";
                                    }
                                }
                                if (!src) { L("  src err entry " + ti + ": " + srcErr); continue; }

                                try {
                                    doc.hyperlinks.add(src, dest, { name: "TOClink_" + anchorName, visible: false });
                                    linkCount++;
                                } catch (e) { L("  hyperlink add err entry " + ti + ": " + e); }
                            }
                        }
                        L("  created " + linkCount + " TOC entry hyperlink(s)");
                    } catch (e) {
                        L("  TOC hyperlink step err: " + e);
                    }
                } catch (e) {
                    L("  TOC update err for style '" + tocStyle.name + "': " + e);
                }
            }
        } catch (e) { L("  TOC step err: " + e); }
    }
    if (editPlan.human_notes && editPlan.human_notes.length > 0) {
        for (var n = 0; n < editPlan.human_notes.length; n++) FLAG("Human note: " + editPlan.human_notes[n]);
    }

    // ==========================================================
    // STEP 3: GENERIC POST-EDIT CANONICALIZATION
    // Runs on ALL modified tables and ALL frames.
    //   3a: Disable hyphenation on every body cell of modified tables
    //   3b: Atomic-cell single-line fit (emails, URLs, phones) via tracking
    //   3c: Restore alternating-fill consistency on modified tables
    //   3d: Detect/extend overflowing text frames where safe
    // ==========================================================
    JT_start("step 4.3: post-edit canonicalization");
    L("\nSTEP 3: post-edit canonicalization");

    // 3a: Hyphenation OFF on modified tables
    var hyphCount = 0;
    for (var tid in modifiedTables) {
        for (var i = 0; i < allTables.length; i++) {
            if (allTables[i].id !== tid) continue;
            var t = allTables[i].table;
            for (var r = t.headerRowCount; r < t.rows.length; r++) {
                for (var c = 0; c < t.columns.length; c++) {
                    try {
                        var paras = t.rows[r].cells[c].paragraphs;
                        for (var pi = 0; pi < paras.length; pi++) { paras[pi].hyphenation = false; hyphCount++; }
                    } catch (e) {}
                }
            }
        }
    }
    if (hyphCount > 0) L("  3a: hyphenation disabled on " + hyphCount + " paragraph(s) in modified tables");

    // 3b: Atomic-cell single-line fit (across all modified tables)
    var atomicFixed = 0, atomicFailed = [];
    for (var tid in modifiedTables) {
        for (var i = 0; i < allTables.length; i++) {
            if (allTables[i].id !== tid) continue;
            var t = allTables[i].table;
            for (var r = t.headerRowCount; r < t.rows.length; r++) {
                for (var c = 0; c < t.columns.length; c++) {
                    try {
                        var cell = t.rows[r].cells[c];
                        var contents = String(cell.contents || "").replace(/[\r\n\s]+$/g, "").replace(/^[\r\n\s]+/g, "");
                        if (!contents || /\s/.test(contents)) continue; // not atomic
                        if (cell.lines.length <= 1) continue; // already fits
                        var t0 = 0; try { t0 = cell.texts[0].tracking; } catch (e) {}
                        var curT = t0, attempts = 0;
                        while (cell.lines.length > 1 && curT > -50 && attempts < 20) {
                            curT -= 5; try { cell.texts[0].tracking = curT; } catch (e) { break; }
                            attempts++;
                        }
                        if (cell.lines.length <= 1) atomicFixed++;
                        else {
                            try { cell.texts[0].tracking = t0; } catch (e) {}
                            atomicFailed.push("table " + tid + " r" + r + "c" + c + " (\"" + contents.substring(0, 30) + "\")");
                        }
                    } catch (e) {}
                }
            }
        }
    }
    if (atomicFixed > 0) L("  3b: fit " + atomicFixed + " atomic cell(s) to single line via tracking");
    if (atomicFailed.length > 0) FLAG(atomicFailed.length + " atomic cell(s) still wrap after tracking floor: " + atomicFailed.slice(0, 3).join(" | "));

    // 3c: Alternating-fill restoration on modified tables
    safe(function () {
        for (var tid in modifiedTables) {
            for (var i = 0; i < allTables.length; i++) {
                if (allTables[i].id !== tid) continue;
                var t = allTables[i].table;
                var headerRows = t.headerRowCount;
                if (t.rows.length - headerRows < 2) continue;
                // Sample the existing fills from row 0 and row 1 of body
                var row0Fill = null, row1Fill = null;
                try { row0Fill = t.rows[headerRows].cells[1].fillColor; } catch (e) {}
                try { row1Fill = t.rows[headerRows + 1].cells[1].fillColor; } catch (e) {}
                if (!row0Fill || !row1Fill) continue;
                if (row0Fill === row1Fill) continue; // not alternating
                // Re-stamp for ALL body rows in cols 1..N (col 0 may have its own scheme)
                var stamped = 0;
                for (var r = headerRows; r < t.rows.length; r++) {
                    var fill = ((r - headerRows) % 2 === 0) ? row0Fill : row1Fill;
                    for (var c = 1; c < t.columns.length; c++) {
                        try { t.rows[r].cells[c].fillColor = fill; t.rows[r].cells[c].fillTint = 100; stamped++; } catch (e) {}
                    }
                }
                // Also configure the table's alternating-fills property so future inserts inherit
                try {
                    t.alternatingFills  = AlternatingFillsTypes.ALTERNATING_ROWS;
                    t.startRowFillColor = row0Fill;
                    t.startRowFillCount = 1;
                    t.startRowFillTint  = 100;
                    t.endRowFillColor   = row1Fill;
                    t.endRowFillCount   = 1;
                    t.endRowFillTint    = 100;
                } catch (e) {}
                L("  3c: stamped " + stamped + " body cells alternating fill on " + tid);
            }
        }
    }, "alt-fill restoration");

    // 3d: Overflow detection + safe extension on all frames
    safe(function () {
        var fixed = 0, failed = [];
        for (var p = 0; p < doc.pages.length; p++) {
            var page = doc.pages[p];
            for (var f = 0; f < page.textFrames.length; f++) {
                var tf = page.textFrames[f];
                if (!tf.overflows) continue;
                // Find safe ceiling: topmost item below this frame that horizontally overlaps
                var b = tf.geometricBounds; // [y1, x1, y2, x2]
                var origBottom = b[2], frameLeft = b[1], frameRight = b[3];
                var pageH = doc.documentPreferences.pageHeight;
                var marginBottom = page.marginPreferences.bottom;
                var pageMarginBottom = pageH - marginBottom;
                var topmostBelow = null;
                try {
                    var bnds = page.pageItems.everyItem().geometricBounds;
                    for (var i = 0; i < bnds.length; i++) {
                        var bb = bnds[i];
                        if (!bb || bb.length < 4) continue;
                        if (Math.abs(bb[0]-b[0])<0.01 && Math.abs(bb[1]-b[1])<0.01 && Math.abs(bb[2]-b[2])<0.01 && Math.abs(bb[3]-b[3])<0.01) continue;
                        if (bb[0] < origBottom - 0.01) continue;
                        if (bb[2] < frameLeft - 0.01 || bb[1] > frameRight + 0.01) continue;
                        if (topmostBelow === null || bb[0] < topmostBelow) topmostBelow = bb[0];
                    }
                } catch (e) {}
                var ceiling = (topmostBelow !== null ? topmostBelow : pageMarginBottom) - 0.0625;
                if (ceiling > origBottom) {
                    try { tf.geometricBounds = [b[0], b[1], ceiling, b[3]]; } catch (e) {}
                }
                if (!tf.overflows) { fixed++; }
                else { failed.push("page " + (p+1) + " frame " + f); }
            }
        }
        if (fixed > 0) L("  3d: extended " + fixed + " overflowing frame(s) to safe ceiling");
        if (failed.length > 0) FLAG(failed.length + " frame(s) still overflow after extension: " + failed.slice(0, 3).join(", "));
    }, "overflow extension");

    // 3e: Stale line-break removal in modified stories
    // ------------------------------------------------
    // When body copy is replaced, designer-placed line breaks often
    // end up wrong because the new text wraps differently. Common
    // symptom: a short word stranded alone at the end of a line
    // (e.g. "FREE") with a break before continuing lowercase text
    // that would have fit on the previous line.
    //
    // Implementation uses findGrep/changeGrep scoped to each modified
    // story rather than walking story.characters — InDesign's
    // characters collection silently omits some break codepoints
    // (e.g. raw U+000A line feeds from imported plain text), so the
    // grep approach is the only one that reliably finds them.
    //
    // Two safety conditions baked into the regex:
    //   (a) match must be followed by a lowercase letter — that
    //       filters out new sentences, headings, and proper nouns.
    //   (b) we don't touch hard paragraph breaks (\r) — merging
    //       paragraphs can lose styling intent. Only U+2028 (forced
    //       line break) and U+000A (LF) are merged.
    //
    // Safety net: if a story's text container overflows after the
    // change, we replay the original break char back in.
    safe(function () {
        var storyCount = 0;
        for (var _sid in modifiedStories) storyCount++;
        if (storyCount === 0) {
            L("  3e: no modified stories tracked, skipping stale-break pass");
            return;
        }
        // GREP class: forced line break (~b == U+2028) OR U+000A LF.
        // Using \x{...} hex escapes so InDesign's GREP can't quietly
        // remap the metachars.
        //
        // Capture ONLY the last non-whitespace char before the break,
        // then consume any whitespace on either side of it. Replacing
        // with `$1 ` lands "FREE [SPACE][LF]energy" as "FREE energy" —
        // a clean single space, no double-space leftover from the
        // designer's trailing whitespace before the break.
        var pattern = "(\\S)\\s*[\\x{000A}\\x{2028}]\\s*(?=[a-z])";
        var replaceTo = "$1 ";
        var totalChanged = 0, totalRestored = 0, totalSkippedCellPara = 0;
        for (var sid in modifiedStories) {
            var story = modifiedStories[sid];
            if (!story || !story.isValid) continue;

            var hasTables = false;
            try { hasTables = story.tables && story.tables.length > 0; } catch (e) {}

            if (!hasTables) {
                // Fast path — no inline tables in this story, so a single
                // story-wide changeGrep is safe.
                var beforeContents = null;
                try { beforeContents = story.contents; } catch (e) {}
                var parentFrame = null;
                try { parentFrame = story.textContainers[0]; } catch (e) {}
                var overflowBefore = false;
                try { if (parentFrame) overflowBefore = parentFrame.overflows; } catch (e) {}
                app.findGrepPreferences = NothingEnum.NOTHING;
                app.changeGrepPreferences = NothingEnum.NOTHING;
                app.findGrepPreferences.findWhat = pattern;
                app.changeGrepPreferences.changeTo = replaceTo;
                var changed = [];
                try { changed = story.changeGrep(); } catch (e) {}
                app.findGrepPreferences = NothingEnum.NOTHING;
                app.changeGrepPreferences = NothingEnum.NOTHING;
                var n = changed.length;
                if (n > 0) {
                    var overflowAfter = false;
                    try { if (parentFrame) overflowAfter = parentFrame.overflows; } catch (e) {}
                    if (!overflowBefore && overflowAfter && beforeContents !== null) {
                        try { story.contents = beforeContents; } catch (e) {}
                        totalRestored += n;
                    } else {
                        totalChanged += n;
                    }
                }
                continue;
            }

            // Story has inline tables. Walk paragraphs individually and
            // skip cell paragraphs. paragraph.parentTextFrames returns
            // the page text frames that contain the paragraph; for cell
            // paragraphs (which live in the cell's own story, not in
            // any TextFrame) the array is empty. That's a deterministic
            // test we can rely on, unlike the class-name comparison we
            // tried before.
            var paragraphCount = 0;
            try { paragraphCount = story.paragraphs.length; } catch (e) {}
            for (var pi = 0; pi < paragraphCount; pi++) {
                var para = null;
                try { para = story.paragraphs[pi]; } catch (e) {}
                if (!para || !para.isValid) continue;
                var ptf = null;
                try { ptf = para.parentTextFrames; } catch (e) {}
                if (!ptf || ptf.length === 0) {
                    totalSkippedCellPara++;
                    continue; // cell paragraph — leave alone
                }
                var paraFrame = ptf[0];
                var pOverflowBefore = false;
                try { pOverflowBefore = paraFrame.overflows; } catch (e) {}
                var paraBefore = null;
                try { paraBefore = para.contents; } catch (e) {}
                app.findGrepPreferences = NothingEnum.NOTHING;
                app.changeGrepPreferences = NothingEnum.NOTHING;
                app.findGrepPreferences.findWhat = pattern;
                app.changeGrepPreferences.changeTo = replaceTo;
                var pChanged = [];
                try { pChanged = para.changeGrep(); } catch (e) {}
                app.findGrepPreferences = NothingEnum.NOTHING;
                app.changeGrepPreferences = NothingEnum.NOTHING;
                var pn = pChanged.length;
                if (pn === 0) continue;
                var pOverflowAfter = false;
                try { pOverflowAfter = paraFrame.overflows; } catch (e) {}
                if (!pOverflowBefore && pOverflowAfter && paraBefore !== null) {
                    try { para.contents = paraBefore; } catch (e) {}
                    totalRestored += pn;
                } else {
                    totalChanged += pn;
                }
            }
        }
        L("  3e: scanned " + storyCount + " modified stor(ies); reflowed " +
          totalChanged + " line break(s) in body paragraphs; restored " +
          totalRestored + " (overflow); skipped " + totalSkippedCellPara + " cell paragraph(s)");
    }, "3e stale-break removal");

    // 3f: noBreak on email addresses and URLs (doc-wide, idempotent)
    // ------------------------------------------------------------
    // An email or URL split across two lines is always a layout bug.
    // Apply InDesign's "No Break" character attribute to anything
    // matching an email/URL shape — InDesign then refuses to break
    // inside the run and either keeps it on its current line or moves
    // the whole thing to the next. Doc-wide rather than scoped to
    // modified stories because (a) the cost is negligible, (b) email
    // formatting is universally desirable, (c) it's idempotent so
    // re-runs are no-ops.
    safe(function () {
        function applyNoBreak(pattern, label) {
            app.findGrepPreferences = NothingEnum.NOTHING;
            app.changeGrepPreferences = NothingEnum.NOTHING;
            app.findGrepPreferences.findWhat = pattern;
            var found = [];
            try { found = doc.findGrep(); } catch (e) {}
            app.findGrepPreferences = NothingEnum.NOTHING;
            var n = 0;
            for (var i = 0; i < found.length; i++) {
                try {
                    if (!found[i].noBreak) { found[i].noBreak = true; n++; }
                } catch (e) {}
            }
            if (n > 0) L("  3f: " + label + " — set noBreak on " + n + " run(s)");
            return n;
        }
        applyNoBreak("[\\w._%+-]+@[\\w.-]+\\.[A-Za-z]{2,}", "emails");
        applyNoBreak("https?://[\\S]+", "URLs");
    }, "3f email/URL noBreak");

    // 3g: Body-copy auto-fit when a modified story now overflows.
    // ----------------------------------------------------------
    // Existing pass 3b adjusts tracking on atomic single-line cells.
    // 3g extends the same idea to body paragraphs: when a REPLACE_TEXT
    // edit lands a few characters too long for the frame, try
    // progressively tighter tracking (-5, -10, -15, -20 in 1/1000 em)
    // on the story's paragraphs before giving up and letting the QA
    // pass flag TEXT_OVERSET. Tracking-only — we don't touch font size
    // automatically (would too easily create visible inconsistency
    // with surrounding documents).
    //
    // Only stories whose parent frame ACTUALLY overflows are touched,
    // and the original tracking is restored if no step within the
    // tolerance band fits.
    safe(function () {
        // Off by default — the user found the tracking adjustments too
        // aggressive on tables and other tight layouts. Opt-in via the
        // `body_auto_fit` qaConfig flag (also exposed in Settings).
        if (!qaConfig.body_auto_fit) return;
        var TRACKING_STEPS = [-5, -10, -15, -20];  // 1/1000 em
        var fitted = 0, restored = 0;
        for (var sid in modifiedStories) {
            var story = modifiedStories[sid];
            if (!story || !story.isValid) continue;
            var frame = null;
            try { frame = story.textContainers[0]; } catch (e) {}
            if (!frame) continue;
            var overflowsNow = false;
            try { overflowsNow = frame.overflows; } catch (e) {}
            if (!overflowsNow) continue;  // nothing to fit

            // Snapshot tracking on every paragraph so we can restore.
            var paras = story.paragraphs;
            var orig = [];
            for (var pi = 0; pi < paras.length; pi++) {
                try { orig.push(paras[pi].tracking); } catch (e) { orig.push(null); }
            }

            var fixed = false;
            for (var ts = 0; ts < TRACKING_STEPS.length; ts++) {
                var delta = TRACKING_STEPS[ts];
                for (var pi = 0; pi < paras.length; pi++) {
                    if (orig[pi] != null) {
                        try { paras[pi].tracking = orig[pi] + delta; } catch (e) {}
                    }
                }
                var stillOver = true;
                try { stillOver = frame.overflows; } catch (e) {}
                if (!stillOver) { fixed = true; break; }
            }

            if (fixed) {
                fitted++;
            } else {
                // Restore — overflow couldn't be resolved within tolerance.
                for (var pi = 0; pi < paras.length; pi++) {
                    if (orig[pi] != null) {
                        try { paras[pi].tracking = orig[pi]; } catch (e) {}
                    }
                }
                restored++;
            }
        }
        if (fitted > 0 || restored > 0) {
            L("  3g: body-copy auto-fit — fitted " + fitted +
              " story(ies) via tracking; restored " + restored +
              " (still overflows after -20 tracking — TEXT_OVERSET will flag)");
        }
    }, "3g body-copy auto-fit");

    // ==========================================================
    // STEP 4: COMPREHENSIVE QA SCAN
    // ==========================================================
    JT_start("step 4.4: comprehensive QA scan");
    L("\nSTEP 4: comprehensive QA scan");

    safe(function () {
        // Trailing whitespace before paragraph/line breaks is invisible —
        // safe to auto-strip. Multi-space sequences are NOT safe to collapse
        // because designers commonly use 2-3 spaces as a typographic
        // separator between checkbox/label units, between columnar items,
        // or to align text. So we now only REPORT multi-space occurrences;
        // the user can clean those up manually if intended.
        app.findGrepPreferences = NothingEnum.NOTHING; app.changeGrepPreferences = NothingEnum.NOTHING;
        app.findGrepPreferences.findWhat = "  +";
        var multiHits = 0;
        try { multiHits = doc.findGrep().length; } catch (e) {}
        app.findGrepPreferences = NothingEnum.NOTHING; app.changeGrepPreferences = NothingEnum.NOTHING;
        app.findGrepPreferences.findWhat = " +(?=\\r|\\n|$)"; app.changeGrepPreferences.changeTo = "";
        var trimmed = 0;
        try { trimmed = doc.changeGrep().length; } catch (e) {}
        if (trimmed > 0) FINDING("info", "TEXT_TRAILING_WS", "text", "doc-wide",
            "auto-fixed " + trimmed + " trailing-whitespace occurrence(s)", true);
        if (multiHits > 0) FINDING("info", "TEXT_MULTI_SPACE", "text", "doc-wide",
            multiHits + " run(s) of 2+ consecutive spaces (left intact — these are often intentional separators in checkbox / columnar layouts)", false);
        app.findGrepPreferences = NothingEnum.NOTHING; app.changeGrepPreferences = NothingEnum.NOTHING;
    }, "whitespace");

    // Mojibake cleanup \u2014 fixes UTF-8-as-MacRoman damage from prior runs, like
    // "\u201A\u00C4\u00F4" (which is U+2019's UTF-8 bytes E2 80 99 read as MacRoman).
    // Iterative because nested mojibake (e.g. "\u201A\u00C4\u00F4\u00C4\u00F4\u00C4\u00FA") exists when this
    // happened multiple times.
    safe(function () {
        var totalFixed = 0;
        // Sequence pairs: damaged → correct. Apply most-specific first.
        var pairs = [
            ["\u201A\u00C4\u00B6", "\u2026"],   // \u2026 was \u201A\u00C4\u00B6
            ["\u201A\u00C4\u00BC", "\u2014"],   // \u2014 was \u201A\u00C4\u00B6 no wait check
            ["\u201A\u00C4\u00BB", "\u2013"],   // \u2013
            ["\u201A\u00C4\u00B4", "\u2014"],   // \u2014
            ["\u201A\u00C4\u00F4", "\u2019"],   // \u2019 was \u201A\u00C4\u00F4
            ["\u201A\u00C4\u00FA", "\u201C"],   // \u201C was \u201A\u00C4\u00FA
            ["\u201A\u00C4\u00F9", "\u201D"],   // \u201D was \u201A\u00C4\u00F9
            ["\u201A\u00C4\u00B2", "\u2018"],   // \u2018
            ["\u201A\u00C4\u00B3", "\u2019"],   // \u2019 alt
        ];
        for (var iter = 0; iter < 5; iter++) { // up to 5 nesting levels
            var pass = 0;
            for (var i = 0; i < pairs.length; i++) {
                app.findGrepPreferences  = NothingEnum.NOTHING;
                app.changeGrepPreferences = NothingEnum.NOTHING;
                app.findGrepPreferences.findWhat   = pairs[i][0];
                app.changeGrepPreferences.changeTo = pairs[i][1];
                pass += doc.changeGrep().length;
            }
            totalFixed += pass;
            if (pass === 0) break;
        }
        if (totalFixed > 0) FINDING("info", "TEXT_MOJIBAKE_FIXED", "text", "doc-wide", "auto-fixed " + totalFixed + " mojibake occurrence(s) (curly-quote / dash chars previously mangled by encoding mismatch)", true);
        app.findGrepPreferences  = NothingEnum.NOTHING;
        app.changeGrepPreferences = NothingEnum.NOTHING;
    }, "mojibake cleanup");

    safe(function () {
        app.findGrepPreferences = NothingEnum.NOTHING; app.changeGrepPreferences = NothingEnum.NOTHING;
        // Use Unicode escapes \u2014 ExtendScript reads .jsx files in MacRoman by
        // default, so literal curly-quote chars in source get mojibake'd.
        app.findGrepPreferences.findWhat = "\"(\\S[^\"]*\\S)\""; app.changeGrepPreferences.changeTo = "\u201C$1\u201D";
        var n1 = doc.changeGrep().length;
        app.findGrepPreferences = NothingEnum.NOTHING; app.changeGrepPreferences = NothingEnum.NOTHING;
        app.findGrepPreferences.findWhat = "(?<=\\w)'(?=\\w|s\\b)"; app.changeGrepPreferences.changeTo = "\u2019";
        var n2 = doc.changeGrep().length;
        if (n1 + n2 > 0) FINDING("info", "TEXT_SMART_QUOTES", "text", "doc-wide", "auto-converted " + n1 + " quote pair(s) and " + n2 + " apostrophe(s) to typographic", true);
        app.findGrepPreferences = NothingEnum.NOTHING; app.changeGrepPreferences = NothingEnum.NOTHING;
    }, "smart quotes");

    safe(function () {
        app.findGrepPreferences = NothingEnum.NOTHING; app.findGrepPreferences.findWhat = "\\b\\w+ - \\w+\\b";
        var hits = doc.findGrep();
        if (hits.length > 0) FINDING("warning", "TEXT_HYPHEN_VS_DASH", "text", "doc-wide", hits.length + " word-hyphen-word occurrence(s); review for en-dash", false, "Replace with \u2013 where appropriate");
        app.findGrepPreferences = NothingEnum.NOTHING;
    }, "hyphen vs dash");

    safe(function () {
        app.findGrepPreferences = NothingEnum.NOTHING; app.changeGrepPreferences = NothingEnum.NOTHING;
        var n = 0;
        app.findGrepPreferences.findWhat = "\\.{3,}"; app.changeGrepPreferences.changeTo = "\u2026"; n += doc.changeGrep().length;
        app.findGrepPreferences = NothingEnum.NOTHING; app.changeGrepPreferences = NothingEnum.NOTHING;
        app.findGrepPreferences.findWhat = ",,+"; app.changeGrepPreferences.changeTo = ","; n += doc.changeGrep().length;
        if (n > 0) FINDING("info", "TEXT_DOUBLE_PUNCT", "text", "doc-wide", "auto-fixed " + n + " double-punctuation occurrence(s)", true);
        app.findGrepPreferences = NothingEnum.NOTHING; app.changeGrepPreferences = NothingEnum.NOTHING;
    }, "double punct");

    safe(function () {
        app.findGrepPreferences = NothingEnum.NOTHING; app.findGrepPreferences.findWhat = "\\r{2,}";
        var hits = doc.findGrep();
        if (hits.length > 0) FINDING("warning", "TEXT_EMPTY_PARAS", "text", "doc-wide", hits.length + " consecutive empty paragraph(s)", false);
        app.findGrepPreferences = NothingEnum.NOTHING;
    }, "empty paragraphs");

    safe(function () {
        app.findGrepPreferences = NothingEnum.NOTHING; app.findGrepPreferences.findWhat = "[\u00AE\u2122\u00A9]";
        var hits = doc.findGrep(); var fixed = 0;
        for (var i = 0; i < hits.length; i++) try { if (hits[i].position !== Position.SUPERSCRIPT) { hits[i].position = Position.SUPERSCRIPT; fixed++; } } catch (e) {}
        if (fixed > 0) FINDING("info", "TEXT_TM_SUPERSCRIPT", "text", "doc-wide", "auto-superscripted " + fixed + " trademark/registered/copyright mark(s)", true);
        app.findGrepPreferences = NothingEnum.NOTHING;
    }, "trademark superscript");

    safe(function () {
        var allLinks = doc.links; var missing = 0, modified = 0, missSamples = [], modSamples = [];
        for (var i = 0; i < allLinks.length; i++) {
            try {
                if (allLinks[i].status === LinkStatus.LINK_MISSING) { missing++; if (missSamples.length < 3) missSamples.push(allLinks[i].name); }
                else if (allLinks[i].status === LinkStatus.LINK_OUT_OF_DATE) { modified++; if (modSamples.length < 3) modSamples.push(allLinks[i].name); }
            } catch (e) {}
        }
        if (missing > 0)  FINDING("error",   "LINK_MISSING",      "links", "doc", missing + " missing link(s): " + missSamples.join(", "), false, "Re-link or replace asset");
        if (modified > 0) FINDING("warning", "LINK_OUT_OF_DATE",  "links", "doc", modified + " out-of-date link(s): " + modSamples.join(", "), false, "Update links");
    }, "link status");

    safe(function () {
        var unavailable = [];
        for (var f = 0; f < doc.fonts.length; f++) try { if (doc.fonts[f].status !== FontStatus.INSTALLED) unavailable.push(doc.fonts[f].fullName); } catch (e) {}
        if (unavailable.length > 0) FINDING("error", "FONT_UNAVAILABLE", "fonts", "doc", unavailable.length + " font(s) not properly installed: " + unavailable.slice(0,5).join(", "), false, "Activate via Adobe Fonts or install");
        var fontNames = [];
        for (var i = 0; i < doc.fonts.length; i++) try { fontNames.push(doc.fonts[i].fullName); } catch (e) {}
        FINDING("info", "FONT_INVENTORY", "fonts", "doc", doc.fonts.length + " font(s): " + fontNames.slice(0,8).join(", ") + (fontNames.length > 8 ? ", \u2026" : ""));
        var maxFontsThreshold = qaConfig.max_fonts || 4;
        if (doc.fonts.length > maxFontsThreshold && checkEnabled("FONT_TOO_MANY")) FINDING("warning", "FONT_TOO_MANY", "fonts", "doc", doc.fonts.length + " distinct fonts (consider consolidating to ≤" + maxFontsThreshold + ")");
    }, "fonts");

    // ---- BRAND_OFFFONT / BRAND_OFFCOLOR ----
    // Auto-discovered brand.json (loaded by orchestrate.py from the
    // .indd's parent or any ancestor folder) lists approved swatch
    // names and font family names. Anything in the doc whose name
    // isn't on the list gets flagged. Doesn't auto-fix — designer
    // intent could justify any one-off use, so this is review-only.
    // Skipped silently if no brand.json was found in the source tree.
    safe(function () {
        if (!qaConfig.brand) return;
        var brandSwatches = (qaConfig.brand.swatches || []);
        var brandFonts    = (qaConfig.brand.fonts    || []);
        function normName(s) { return String(s || "").toLowerCase().replace(/\s+/g, " ").replace(/^\s+|\s+$/g, ""); }
        var brandSwatchSet = {};
        for (var i = 0; i < brandSwatches.length; i++) brandSwatchSet[normName(brandSwatches[i])] = true;
        var brandFontSet = {};
        for (var i = 0; i < brandFonts.length; i++) brandFontSet[normName(brandFonts[i])] = true;

        // Skip InDesign's built-in default swatches every doc carries.
        var DEFAULT_SWATCHES = {
            "[none]": 1, "[paper]": 1, "[black]": 1, "[registration]": 1,
            "c=0 m=0 y=0 k=0": 1, "c=100 m=0 y=0 k=0": 1,
            "c=0 m=100 y=0 k=0": 1, "c=0 m=0 y=100 k=0": 1,
            "c=100 m=90 y=10 k=0": 1, "c=15 m=100 y=100 k=0": 1,
            "c=75 m=5 y=100 k=0": 1, "c=100 m=0 y=0 k=0": 1
        };
        if (brandSwatches.length > 0) {
            var offColor = [];
            for (var i = 0; i < doc.swatches.length; i++) {
                var sw; try { sw = doc.swatches[i]; } catch (e) { continue; }
                var nm = ""; try { nm = String(sw.name || ""); } catch (e) {}
                var key = normName(nm);
                if (!key) continue;
                if (DEFAULT_SWATCHES[key]) continue;
                if (!brandSwatchSet[key]) offColor.push(nm);
            }
            if (offColor.length > 0 && checkEnabled("BRAND_OFFCOLOR")) {
                FINDING("warning", "BRAND_OFFCOLOR", "brand", "doc",
                    offColor.length + " off-brand swatch(es): " + offColor.slice(0, 6).join(", "),
                    false,
                    "Replace with an approved brand swatch, or add to brand.json if intentional");
            }
        }

        // Off-brand fonts — match family name (part before first hyphen)
        // so "GoodPro-NarrBold" matches "GoodPro" in brand.json.
        if (brandFonts.length > 0) {
            var offFont = [];
            for (var i = 0; i < doc.fonts.length; i++) {
                var fn = ""; try { fn = String(doc.fonts[i].fullName || ""); } catch (e) {}
                if (!fn) continue;
                var family = fn.split(/[\s\t\-]/)[0];
                if (!family) continue;
                var fkey = normName(family);
                var fullKey = normName(fn);
                if (brandFontSet[fkey] || brandFontSet[fullKey]) continue;
                offFont.push(fn);
            }
            if (offFont.length > 0 && checkEnabled("BRAND_OFFFONT")) {
                FINDING("warning", "BRAND_OFFFONT", "brand", "doc",
                    offFont.length + " off-brand font(s): " + offFont.slice(0, 6).join(", "),
                    false,
                    "Replace with an approved brand font, or add to brand.json if intentional");
            }
        }
    }, "brand enforcement");


    // ---- STYLE_RESTRUCTURE: scan unstyled paragraphs and propose new styles ----
    // Walks every paragraph in every story, fingerprints by font+size+leading+
    // alignment+color+weight. Paragraphs with an applied style ([Basic Paragraph]
    // counts as unstyled here too) get the same treatment. Clusters with N+
    // members become candidate paragraph styles. The proposed map is written
    // to a sidecar JSON so the renderer can show a review modal; we don't
    // change anything in the doc — that's only on user opt-in via the
    // "Restructure styles" button.
    safe(function () {
        if (!checkEnabled("STYLE_RESTRUCTURE_CANDIDATES")) return;
        if (!styleProposalsPath || styleProposalsPath.charAt(0) === "_") return; // not substituted
        var minClusterSize = (qaConfig.style_restructure_min_cluster || 3);

        function paraFontName(p) {
            try {
                var f = p.appliedFont;
                if (f && f.fullName) return String(f.fullName).split("\t")[0];
                return String(f || "");
            } catch (e) { return ""; }
        }
        function paraColor(p) {
            try { return String(p.fillColor && p.fillColor.name ? p.fillColor.name : "Black"); }
            catch (e) { return "Black"; }
        }
        function paraJust(p) { try { return String(p.justification); } catch (e) { return ""; } }
        function paraStyleName(p) {
            try {
                var ps = p.appliedParagraphStyle;
                return ps ? String(ps.name) : "[None]";
            } catch (e) { return "[None]"; }
        }
        function isUnstyledStyleName(n) {
            // Treat [None], [Basic Paragraph], "[$ID...]" placeholders as unstyled
            if (!n) return true;
            if (n === "[None]" || n === "[Basic Paragraph]") return true;
            return false;
        }
        function round1(n) { return Math.round((Number(n) || 0) * 10) / 10; }
        function fingerprint(p) {
            var sz, ld, fs;
            try { sz = round1(p.pointSize); } catch (e) { sz = 0; }
            try { ld = (typeof p.leading === "number") ? round1(p.leading) : "auto"; } catch (e) { ld = "auto"; }
            try { fs = String(p.fontStyle || "Regular"); } catch (e) { fs = "Regular"; }
            return [paraFontName(p), sz, ld, fs, paraJust(p), paraColor(p)].join("|");
        }

        var clusters = {};   // signature → { font, size, leading, fontStyle, just, color, members:[{loc, text, styleName}] }
        var totalScanned = 0;
        var totalUnstyled = 0;
        var totalStyled = 0;
        for (var s = 0; s < doc.stories.length; s++) {
            var story = doc.stories[s];
            // Skip very short stories — usually labels / nav, not body
            try { if (story.paragraphs.length === 0) continue; } catch (e) { continue; }
            for (var p = 0; p < story.paragraphs.length; p++) {
                var para;
                try { para = story.paragraphs[p]; } catch (e) { continue; }
                var t;
                try { t = String(para.contents || ""); } catch (e) { continue; }
                var trimmed = t.replace(/^\s+|\s+$/g, "");
                if (!trimmed.length) continue; // skip empty paragraphs
                totalScanned++;
                var sn = paraStyleName(para);
                var styled = !isUnstyledStyleName(sn);
                if (styled) totalStyled++; else totalUnstyled++;
                // We only PROPOSE for unstyled clusters, but we cluster everything
                // so the user gets a complete picture in the report.
                var sig = fingerprint(para);
                if (!clusters[sig]) {
                    clusters[sig] = {
                        signature: sig,
                        font: paraFontName(para),
                        size: round1(para.pointSize || 0),
                        leading: (typeof para.leading === "number" ? round1(para.leading) : "auto"),
                        fontStyle: String(para.fontStyle || "Regular"),
                        justification: paraJust(para),
                        color: paraColor(para),
                        members_unstyled: [],
                        members_styled: []
                    };
                }
                var loc = "story" + s + "/p" + p;
                var bucket = styled ? clusters[sig].members_styled : clusters[sig].members_unstyled;
                if (bucket.length < 5) {
                    // Cap samples per cluster — full membership not needed for the modal
                    bucket.push({ loc: loc, text: trimmed.substring(0, 80), styleName: sn });
                }
                // Track total counts even past the sample cap
                clusters[sig]["count_" + (styled ? "styled" : "unstyled")] =
                    (clusters[sig]["count_" + (styled ? "styled" : "unstyled")] || 0) + 1;
            }
        }

        // Pick clusters that have ≥ minClusterSize unstyled members (those are
        // the ones we'd actually propose new styles for).
        var candidates = [];
        for (var sig in clusters) {
            if (!clusters.hasOwnProperty(sig)) continue;
            var c = clusters[sig];
            var unstyledCount = c.count_unstyled || 0;
            var styledCount = c.count_styled || 0;
            if (unstyledCount < minClusterSize) continue;
            candidates.push({
                signature: sig, font: c.font, size: c.size, leading: c.leading,
                fontStyle: c.fontStyle, justification: c.justification, color: c.color,
                count_unstyled: unstyledCount, count_styled: styledCount,
                samples_unstyled: c.members_unstyled, samples_styled: c.members_styled
            });
        }

        // Sort by font size desc → largest gets H1, next H2, etc.
        candidates.sort(function (a, b) { return b.size - a.size; });

        // Pick the most-common cluster for "Body" (unless it's also the largest)
        var bodyIdx = -1, bodyMax = -1;
        for (var ci = 0; ci < candidates.length; ci++) {
            if (candidates[ci].count_unstyled > bodyMax) { bodyMax = candidates[ci].count_unstyled; bodyIdx = ci; }
        }
        var headIdx = 1;
        for (var ci2 = 0; ci2 < candidates.length; ci2++) {
            if (ci2 === bodyIdx && candidates[ci2].size <= 14) {
                candidates[ci2].proposed_name = "Body";
            } else if (ci2 === candidates.length - 1 && candidates[ci2].size < 9) {
                candidates[ci2].proposed_name = "Caption";
            } else {
                candidates[ci2].proposed_name = "H" + headIdx;
                headIdx++;
            }
        }

        // Serialize to sidecar JSON
        var jf = File(styleProposalsPath); jf.encoding = "UTF-8"; jf.open("w");
        var items = [];
        for (var k = 0; k < candidates.length; k++) {
            var cand = candidates[k];
            var samplesUnstyled = [];
            for (var sui = 0; sui < cand.samples_unstyled.length; sui++) {
                samplesUnstyled.push("{\"loc\":" + jsonStr(cand.samples_unstyled[sui].loc) +
                    ",\"text\":" + jsonStr(cand.samples_unstyled[sui].text) +
                    ",\"styleName\":" + jsonStr(cand.samples_unstyled[sui].styleName) + "}");
            }
            var samplesStyled = [];
            for (var ssi = 0; ssi < cand.samples_styled.length; ssi++) {
                samplesStyled.push("{\"loc\":" + jsonStr(cand.samples_styled[ssi].loc) +
                    ",\"text\":" + jsonStr(cand.samples_styled[ssi].text) +
                    ",\"styleName\":" + jsonStr(cand.samples_styled[ssi].styleName) + "}");
            }
            items.push("{" +
                "\"signature\":" + jsonStr(cand.signature) + "," +
                "\"proposed_name\":" + jsonStr(cand.proposed_name) + "," +
                "\"font\":" + jsonStr(cand.font) + "," +
                "\"size\":" + cand.size + "," +
                "\"leading\":" + (cand.leading === "auto" ? "\"auto\"" : cand.leading) + "," +
                "\"fontStyle\":" + jsonStr(cand.fontStyle) + "," +
                "\"justification\":" + jsonStr(cand.justification) + "," +
                "\"color\":" + jsonStr(cand.color) + "," +
                "\"count_unstyled\":" + cand.count_unstyled + "," +
                "\"count_styled\":" + cand.count_styled + "," +
                "\"samples_unstyled\":[" + samplesUnstyled.join(",") + "]," +
                "\"samples_styled\":[" + samplesStyled.join(",") + "]" +
            "}");
        }
        jf.write("{" +
            "\"total_scanned\":" + totalScanned + "," +
            "\"total_styled\":" + totalStyled + "," +
            "\"total_unstyled\":" + totalUnstyled + "," +
            "\"min_cluster_size\":" + minClusterSize + "," +
            "\"candidates\":[" + items.join(",") + "]}");
        jf.close();

        if (candidates.length > 0) {
            var msg = "Found " + candidates.length + " candidate paragraph style(s) for "
                + totalUnstyled + " unstyled paragraph(s)"
                + (totalStyled > 0 ? " (" + totalStyled + " already styled)" : "")
                + ". Click 'Restructure styles' to review.";
            FINDING("info", "STYLE_RESTRUCTURE_CANDIDATES", "styles", "doc", msg, false, "restructure_styles");
        }
    }, "style restructure candidates");

    // Character styles with no Font Family set inherit at runtime, but the
    // result is unreliable — bullets can render in a fallback font instead
    // of the doc's actual body font. Auto-fix: detect character styles with
    // empty appliedFont and assign them the dominant body font.
    safe(function () {
        if (!checkEnabled("STYLE_FONTLESS_CHAR_STYLE")) return;

        // Pick the dominant body font: count font usage across body-ish
        // paragraph styles (body/bullet/table/callout/section/copy in name).
        var counts = {};
        var samples = {};
        try {
            for (var i = 0; i < doc.paragraphStyles.length; i++) {
                var ps = doc.paragraphStyles[i];
                var psName = String(ps.name || "").toLowerCase();
                if (psName.indexOf("[") === 0) continue;
                if (!/body|bullet|table|callout|section|copy/.test(psName)) continue;
                var fName = "", fStyle = "Regular";
                try {
                    var ap = ps.appliedFont;
                    if (ap) fName = ap.fullName ? String(ap.fullName).split("\t")[0] : String(ap);
                } catch (e) {}
                try { fStyle = String(ps.fontStyle || "Regular"); } catch (e) {}
                if (fName) {
                    var key = fName + "\t" + fStyle;
                    counts[key] = (counts[key] || 0) + 1;
                    samples[key] = { font: fName, style: fStyle };
                }
            }
        } catch (e) {}
        var bestKey = null, bestCount = 0;
        for (var k in counts) if (counts[k] > bestCount) { bestCount = counts[k]; bestKey = k; }
        if (!bestKey) return;
        var dominant = samples[bestKey];

        var fixed = 0, fixedNames = [];
        for (var ci = 0; ci < doc.characterStyles.length; ci++) {
            var cs = doc.characterStyles[ci];
            var csName = String(cs.name || "");
            if (csName === "[None]") continue;
            var apFont = null;
            try { apFont = cs.appliedFont; } catch (e) {}
            var apFontName = "";
            try {
                if (apFont) apFontName = apFont.fullName ? String(apFont.fullName) : String(apFont);
            } catch (e) {}
            apFontName = (apFontName || "").replace(/\s+/g, "");
            if (apFontName && apFontName.toLowerCase() !== "undefined") continue;
            try {
                cs.appliedFont = dominant.font;
                cs.fontStyle  = dominant.style;
                fixed++;
                fixedNames.push(csName);
            } catch (e) {
                L("  STYLE_FONTLESS_CHAR_STYLE err for '" + csName + "': " + e);
            }
        }
        if (fixed > 0) {
            FINDING("info", "STYLE_FONTLESS_CHAR_STYLE", "fonts", "doc",
                "Auto-fixed " + fixed + " character style(s) with empty Font Family → " +
                dominant.font + " " + dominant.style + ": " + fixedNames.slice(0, 8).join(", "),
                true);
        }
    }, "fontless character styles");

    safe(function () {
        if (!checkEnabled("IMG_LOW_RES") && !checkEnabled("IMG_COUNT")) return;
        var minDpiThreshold = qaConfig.min_dpi || 300;
        var graphics = doc.allGraphics; var lowRes = 0, samples = [];
        for (var g = 0; g < graphics.length; g++) {
            try {
                var eppi = graphics[g].effectivePpi;
                if (eppi && eppi.length >= 2) {
                    var minPpi = Math.min(eppi[0], eppi[1]);
                    if (minPpi < minDpiThreshold) {
                        lowRes++;
                        if (samples.length < 5) {
                            var fname = "?"; try { fname = graphics[g].itemLink ? graphics[g].itemLink.name : "?"; } catch (e) {}
                            samples.push(fname + " @ " + Math.round(minPpi) + "dpi");
                        }
                    }
                }
            } catch (e) {}
        }
        if (lowRes > 0 && checkEnabled("IMG_LOW_RES")) FINDING("error", "IMG_LOW_RES", "image", "doc-wide", lowRes + " image(s) below " + minDpiThreshold + "dpi: " + samples.join(", "), false, "Replace with higher-resolution");
        if (checkEnabled("IMG_COUNT")) FINDING("info", "IMG_COUNT", "image", "doc", graphics.length + " placed graphic(s)");
    }, "image res");

    safe(function () {
        var rgb = [], spots = [];
        for (var s = 0; s < doc.swatches.length; s++) try {
            if (doc.swatches[s].space === ColorSpace.RGB) rgb.push(doc.swatches[s].name);
            if (doc.swatches[s].colorModel === ColorModel.SPOT) spots.push(doc.swatches[s].name);
        } catch (e) {}
        if (rgb.length > 0) FINDING("warning", "COLOR_RGB_SWATCH", "color", "doc", rgb.length + " RGB swatch(es): " + rgb.slice(0,5).join(", "), false, "Convert to CMYK for print");
        if (spots.length > 0) FINDING("info", "COLOR_SPOT_COLORS", "color", "doc", spots.length + " spot color(s): " + spots.slice(0,5).join(", "), false);
    }, "swatches");

    safe(function () {
        var hyperlinks = doc.hyperlinks;
        if (hyperlinks.length === 0) return;
        var mismatches = 0, urlList = [], samples = [];
        for (var h = 0; h < hyperlinks.length; h++) {
            try {
                var link = hyperlinks[h];
                var dest = link.destination, destURL = "";
                try { destURL = dest.destinationURL || ""; } catch (e) {}
                var sourceText = "";
                try { sourceText = link.source.sourceText.contents; } catch (e) {}
                urlList.push({ src: sourceText, dest: destURL });
                var srcLooksLikeUrl = /^(https?:\/\/|www\.|[a-z0-9.-]+@[a-z0-9.-]+\.[a-z]+)/i.test(String(sourceText).replace(/\s+/g, ""));
                if (srcLooksLikeUrl && destURL && String(sourceText).replace(/\s+/g, "").toLowerCase() !== destURL.toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "")) {
                    mismatches++;
                    if (samples.length < 5) samples.push("\"" + String(sourceText).substring(0, 40) + "\" → " + destURL);
                }
            } catch (e) {}
        }
        FINDING("info", "HYPERLINK_INVENTORY", "links", "doc", hyperlinks.length + " hyperlink(s)");
        if (mismatches > 0) FINDING("warning", "HYPERLINK_TEXT_MISMATCH", "links", "doc",
            mismatches + " hyperlink(s) where displayed URL doesn't match destination: " + samples.join(" | "), false, "Verify destination URL");
        try {
            var hf = File(hyperlinksPath); hf.encoding = "UTF-8"; hf.open("w");
            var items = [];
            for (var i = 0; i < urlList.length; i++) items.push("{\"src\":" + jsonStr(urlList[i].src) + ",\"dest\":" + jsonStr(urlList[i].dest) + "}");
            hf.write("[" + items.join(",") + "]"); hf.close();
        } catch (e) {}
    }, "hyperlinks");

    // ---- HYPERLINK_MISSING: detect URLs / emails in body text that aren't
    // attached to a real hyperlink. Surfaces as a finding with a sidecar
    // proposal JSON; the renderer offers a "Create hyperlinks" button that
    // runs jsx/create_hyperlinks.jsx to apply the user-approved set.
    safe(function () {
        if (!checkEnabled("HYPERLINK_MISSING")) return;
        if (!hyperlinkProposalsPath || hyperlinkProposalsPath.charAt(0) === "_") return;

        // Build a set of (storyId, charIndex) ranges that are ALREADY inside a
        // hyperlink, so we can skip them. Each hyperlink's source has a
        // sourceText.parentStory + characters[0]/characters[-1] range.
        var coveredRanges = {}; // storyId → [ [start, end], ... ]
        for (var h = 0; h < doc.hyperlinks.length; h++) {
            try {
                var link = doc.hyperlinks[h];
                var src = link.source;
                if (!src || !src.sourceText) continue;
                var t = src.sourceText;
                var sid;
                try { sid = t.parentStory.id; } catch (e) { continue; }
                var first = -1, last = -1;
                try { first = t.characters[0].index; last = t.characters[-1].index; } catch (e) {}
                if (first < 0 || last < 0) continue;
                if (!coveredRanges[sid]) coveredRanges[sid] = [];
                coveredRanges[sid].push([first, last]);
            } catch (e) {}
        }
        function isCovered(storyId, idx) {
            var ranges = coveredRanges[storyId];
            if (!ranges) return false;
            for (var i = 0; i < ranges.length; i++) {
                if (idx >= ranges[i][0] && idx <= ranges[i][1]) return true;
            }
            return false;
        }

        // URL + email detection. Token-based to avoid catastrophic regex
        // backtracking on long body text — split on whitespace, then validate
        // each token for an `@` (email) or a known TLD (URL).
        var TLDS = { com:1, org:1, net:1, gov:1, edu:1, io:1, co:1, us:1, uk:1,
                     ai:1, app:1, info:1, biz:1, pro:1, tv:1, tech:1 };
        function isWS(ch) { return ch === " " || ch === "\t" || ch === "\n" || ch === "\r" || ch === "\f"; }
        function classifyToken(tok) {
            // Strip leading/trailing punctuation that's almost never part of a URL
            var leadRe  = /^[^A-Za-z0-9@\/]+/;
            var trailRe = /[^A-Za-z0-9\/]+$/;
            var lead = (tok.match(leadRe) || [""])[0].length;
            var clean = tok.replace(leadRe, "").replace(trailRe, "");
            if (!clean) return null;
            if (clean.indexOf("@") > 0) {
                // email: word@domain.tld(s)
                var atIdx = clean.indexOf("@");
                var local = clean.substring(0, atIdx);
                var domain = clean.substring(atIdx + 1);
                if (!local || !domain || domain.indexOf(".") < 1) return null;
                if (!/^[A-Za-z0-9][\w.+-]*$/.test(local)) return null;
                if (!/^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/.test(domain)) return null;
                return { kind: "email", text: clean, lead: lead };
            }
            if (clean.indexOf(".") > 0) {
                var hostPart = clean.split("/")[0].replace(/^https?:\/\//i, "");
                var bits = hostPart.split(".");
                if (bits.length < 2) return null;
                var tld = bits[bits.length - 1].toLowerCase();
                if (!TLDS[tld]) return null;
                // Sanity: every host component must be alphanumeric / hyphen
                for (var bi = 0; bi < bits.length; bi++) {
                    if (!/^[A-Za-z0-9-]+$/.test(bits[bi])) return null;
                }
                return { kind: "url", text: clean, lead: lead };
            }
            return null;
        }

        var proposals = [];
        var seen = {};
        var startTime = (new Date()).getTime();
        var BUDGET_MS = 8000;
        var aborted = false;

        for (var s = 0; s < doc.stories.length && !aborted; s++) {
            if ((new Date()).getTime() - startTime > BUDGET_MS) {
                L("hyperlink scan: budget exceeded after " + s + " story(ies); aborting");
                aborted = true; break;
            }
            var story;
            try { story = doc.stories[s]; } catch (e) { continue; }
            var sid;
            try { sid = story.id; } catch (e) { continue; }
            var content;
            try { content = String(story.contents || ""); } catch (e) { continue; }
            if (!content.length) continue;
            // Skip very large stories (likely imported / non-body content)
            if (content.length > 50000) continue;

            // Walk tokens between whitespace boundaries
            var i = 0, n = content.length;
            while (i < n) {
                while (i < n && isWS(content.charAt(i))) i++;
                if (i >= n) break;
                var tokStart = i;
                while (i < n && !isWS(content.charAt(i))) i++;
                var token = content.substring(tokStart, i);
                if (token.length < 4) continue; // too short to be a URL/email
                var info = classifyToken(token);
                if (!info) continue;
                var charIdx = tokStart + info.lead;
                if (isCovered(sid, charIdx)) continue;
                var clean = info.text;
                var dest;
                if (info.kind === "email") {
                    dest = "mailto:" + clean;
                } else {
                    dest = /^https?:\/\//i.test(clean) ? clean : "https://" + clean;
                }
                var key = sid + "|" + charIdx + "|" + clean;
                if (seen[key]) continue;
                seen[key] = true;
                proposals.push({
                    text: clean,
                    proposed_url: dest,
                    kind: info.kind,
                    story_id: sid,
                    char_index: charIdx
                });
            }
        }
        L("hyperlink scan: " + proposals.length + " candidate(s) in "
          + ((new Date()).getTime() - startTime) + "ms"
          + (aborted ? " (aborted)" : ""));

        // Write sidecar
        var pf = File(hyperlinkProposalsPath); pf.encoding = "UTF-8"; pf.open("w");
        var items = [];
        for (var p = 0; p < proposals.length; p++) {
            var pr = proposals[p];
            items.push("{" +
                "\"text\":" + jsonStr(pr.text) + "," +
                "\"proposed_url\":" + jsonStr(pr.proposed_url) + "," +
                "\"kind\":" + jsonStr(pr.kind) + "," +
                "\"story_id\":" + pr.story_id + "," +
                "\"char_index\":" + pr.char_index +
            "}");
        }
        pf.write("{\"proposals\":[" + items.join(",") + "]}");
        pf.close();

        if (proposals.length > 0) {
            FINDING("info", "HYPERLINK_MISSING", "links", "doc",
                "Found " + proposals.length + " unlinked URL/email(s). Click 'Create hyperlinks' to review.",
                false, "create_hyperlinks");
        }
    }, "hyperlink missing");

    safe(function () {
        var allFrames = doc.textFrames; var oversetFrames = 0, samples = [];
        for (var f = 0; f < allFrames.length; f++) try {
            if (allFrames[f].overflows) {
                oversetFrames++;
                var prev = ""; try { prev = String(allFrames[f].contents).substring(0, 30).replace(/[\r\n]+/g, " "); } catch (e) {}
                if (samples.length < 3) samples.push("\"" + prev + "...\"");
            }
        } catch (e) {}
        if (oversetFrames > 0) FINDING("error", "TEXT_OVERSET", "layout", "doc-wide", oversetFrames + " text frame(s) with overset text: " + samples.join(" | "), false, "Resize frame, reduce content, or thread");
    }, "overset");

    safe(function () {
        var hidden = [];
        for (var l = 0; l < doc.layers.length; l++) try {
            if (!doc.layers[l].visible && doc.layers[l].allPageItems.length > 0) hidden.push(doc.layers[l].name);
        } catch (e) {}
        if (hidden.length > 0) FINDING("info", "LAYER_HIDDEN_WITH_CONTENT", "layout", "doc", hidden.length + " hidden layer(s) with content: " + hidden.join(", "));
    }, "hidden layers");

    safe(function () {
        var n = 0;
        for (var p = 0; p < doc.pages.length; p++) {
            var items = doc.pages[p].allPageItems;
            for (var i = 0; i < items.length; i++) try { if (items[i].locked) n++; } catch (e) {}
        }
        if (n > 0) FINDING("info", "ITEM_LOCKED", "layout", "doc", n + " locked item(s)");
    }, "locked");

    safe(function () {
        var cmyk = "?", rgb = "?";
        try { cmyk = doc.cmykProfile; } catch (e) {}
        try { rgb = doc.rgbProfile; } catch (e) {}
        FINDING("info", "DOC_COLOR_PROFILE", "color", "doc", "CMYK=" + cmyk + " | RGB=" + rgb);
        FINDING("info", "DOC_DIMENSIONS", "doc", "doc", doc.pages.length + " page(s), " + doc.documentPreferences.pageWidth + "\" \u00D7 " + doc.documentPreferences.pageHeight + "\"");
        var bt = doc.documentPreferences.documentBleedTopOffset;
        var bb = doc.documentPreferences.documentBleedBottomOffset;
        var bl = doc.documentPreferences.documentBleedInsideOrLeftOffset;
        var br = doc.documentPreferences.documentBleedOutsideOrRightOffset;
        if (bt + bb + bl + br === 0) FINDING("warning", "DOC_NO_BLEED", "print", "doc", "No bleed configured", false, "Add bleed for print output");
        else FINDING("info", "DOC_BLEED", "print", "doc", "Bleed T=" + bt + " B=" + bb + " L=" + bl + " R=" + br);
    }, "doc info");

    safe(function () {
        if (!checkEnabled("COLOR_RICH_BLACK_SMALL")) return;
        var bodySizeMax = qaConfig.body_size_pt || 14;
        var rich = 0, samples = [];
        for (var s = 0; s < doc.stories.length && samples.length < 5; s++) {
            try {
                var paras = doc.stories[s].paragraphs;
                for (var p = 0; p < paras.length && samples.length < 5; p++) try {
                    var pt = paras[p].pointSize;
                    if (pt > bodySizeMax) continue;
                    var fc = paras[p].fillColor;
                    if (!fc || !fc.colorValue) continue;
                    var cv = fc.colorValue;
                    if (cv.length === 4 && cv[3] === 100 && (cv[0] > 0 || cv[1] > 0 || cv[2] > 0)) {
                        rich++;
                        if (samples.length < 3) samples.push("\"" + String(paras[p].contents).substring(0, 30) + "\" @ " + pt + "pt");
                    }
                } catch (e) {}
            } catch (e) {}
        }
        if (rich > 0) FINDING("warning", "COLOR_RICH_BLACK_SMALL", "color", "doc-wide", rich + " small text run(s) using rich black: " + samples.join(", "), false, "Change to 100% K only");
    }, "rich black");

    safe(function () {
        var n = 0;
        for (var p = 0; p < doc.pages.length; p++) {
            var items = doc.pages[p].allPageItems;
            for (var i = 0; i < items.length; i++) try { if (items[i].overridden) n++; } catch (e) {}
        }
        if (n > 0) FINDING("info", "MASTER_OVERRIDES", "layout", "doc", n + " master-page override(s)");
    }, "master overrides");

    // ==========================================================
    // STEP 4b: 508 COMPLIANCE CHECKS (gated by qaConfig.run_508_check)
    // Designer-side checks per the 508 doc:
    //   - Color contrast ≥ 4.5:1 (3:1 for ≥18pt or ≥14pt bold)
    //   - Line weights ≥ 1pt (hairlines disappear during PDF tagging)
    //   - Alt text on placed graphics
    //   - Document properties (title / author / subject / keywords)
    //   - "Create Tagged PDF" forced ON at export (handled in STEP 5)
    // ==========================================================
    if (qaConfig.run_508_check) {
        JT_start("step 4.4b: 508 compliance checks");
        L("\nSTEP 4b: 508 compliance checks");

        // ---- WCAG luminance + contrast ratio helpers (sRGB) ----
        function _srgbToLin(c) {
            c = c / 255.0;
            return (c <= 0.03928) ? (c / 12.92) : Math.pow((c + 0.055) / 1.055, 2.4);
        }
        function _luminance(rgb) {
            // rgb = [r, g, b] in 0–255
            var rL = _srgbToLin(rgb[0]), gL = _srgbToLin(rgb[1]), bL = _srgbToLin(rgb[2]);
            return 0.2126 * rL + 0.7152 * gL + 0.0722 * bL;
        }
        function _contrast(fg, bg) {
            var l1 = _luminance(fg), l2 = _luminance(bg);
            var hi = Math.max(l1, l2), lo = Math.min(l1, l2);
            return (hi + 0.05) / (lo + 0.05);
        }
        // Convert a doc Swatch / Color into approximate [r, g, b].
        // Handles RGB and CMYK; returns null for None / Mixed / unknowns.
        function _swatchToRgb(sw) {
            if (!sw) return null;
            try {
                var nm = String(sw.name || "");
                if (nm === "None" || nm === "Registration") return null;
                if (/paper/i.test(nm)) return [255, 255, 255];
            } catch (e) {}
            var space = null;
            try { space = sw.space; } catch (e) {}
            try {
                var vals = sw.colorValue;  // array of channel values
                if (!vals || !vals.length) return null;
                if (space === ColorSpace.RGB) {
                    return [Math.round(vals[0]), Math.round(vals[1]), Math.round(vals[2])];
                }
                if (space === ColorSpace.CMYK) {
                    // Naive CMYK→RGB; good enough for contrast classification
                    var c = vals[0]/100, m = vals[1]/100, y = vals[2]/100, k = vals[3]/100;
                    var r = 255 * (1 - c) * (1 - k);
                    var g = 255 * (1 - m) * (1 - k);
                    var b = 255 * (1 - y) * (1 - k);
                    return [Math.round(r), Math.round(g), Math.round(b)];
                }
                if (space === ColorSpace.LAB || space === ColorSpace.MIXED_INK) {
                    // Skip — too risky to approximate
                    return null;
                }
            } catch (e) {}
            return null;
        }
        // Find the immediate underlying fill (frame/rect behind a text frame).
        // Walks the page's pageItems, picks the topmost rectangle whose bounds
        // contain the text frame's center and whose fill resolves to RGB.
        // Falls back to Paper (white) for unframed text.
        function _underlyingBgRgb(textFrame, page) {
            try {
                var b = textFrame.geometricBounds; // [y1,x1,y2,x2]
                var cx = (b[1] + b[3]) / 2, cy = (b[0] + b[2]) / 2;
                var candidates = [];
                var items = page.pageItems;
                for (var i = 0; i < items.length; i++) {
                    try {
                        var it = items[i];
                        if (it === textFrame) continue;
                        var bb = it.geometricBounds;
                        if (!bb || bb.length < 4) continue;
                        if (cx < bb[1] || cx > bb[3] || cy < bb[0] || cy > bb[2]) continue;
                        var fc = null;
                        try { fc = it.fillColor; } catch (e) { continue; }
                        var rgb = _swatchToRgb(fc);
                        if (rgb) candidates.push({ rgb: rgb, area: (bb[2]-bb[0]) * (bb[3]-bb[1]), z: i });
                    } catch (e) {}
                }
                // Smallest area wins (closest to the text). Topmost (later index)
                // breaks ties.
                candidates.sort(function (a, b) {
                    if (a.area !== b.area) return a.area - b.area;
                    return b.z - a.z;
                });
                if (candidates.length > 0) return candidates[0].rgb;
            } catch (e) {}
            return [255, 255, 255]; // Paper / white default
        }

        // ---- 508_CONTRAST_LOW ----
        safe(function () {
            var lowCount = 0, samples = [];
            for (var p = 0; p < doc.pages.length; p++) {
                var page = doc.pages[p];
                for (var ti = 0; ti < page.textFrames.length; ti++) {
                    var tf = page.textFrames[ti];
                    var paras;
                    try { paras = tf.paragraphs; } catch (e) { continue; }
                    if (!paras || paras.length === 0) continue;
                    // Sample first paragraph fill + size
                    var firstChar;
                    try { firstChar = paras[0].characters[0]; } catch (e) { continue; }
                    if (!firstChar) continue;
                    var fillRgb = null, sizePt = 12, isBold = false;
                    try { fillRgb = _swatchToRgb(firstChar.fillColor); } catch (e) {}
                    try { sizePt = Number(firstChar.pointSize) || 12; } catch (e) {}
                    try {
                        var fontStyle = String(firstChar.fontStyle || "").toLowerCase();
                        isBold = /bold|black|heavy/.test(fontStyle);
                    } catch (e) {}
                    if (!fillRgb) continue;
                    var bgRgb = _underlyingBgRgb(tf, page);
                    var ratio = _contrast(fillRgb, bgRgb);
                    // WCAG AA: 4.5:1 normal, 3:1 for large (≥18pt or ≥14pt bold)
                    var threshold = (sizePt >= 18 || (sizePt >= 14 && isBold)) ? 3.0 : 4.5;
                    if (ratio < threshold) {
                        lowCount++;
                        if (samples.length < 8) {
                            var snippet = "";
                            try { snippet = String(tf.contents || "").substring(0, 30); } catch (e) {}
                            samples.push("p" + (p+1) + " '" + snippet.replace(/\s+/g, " ") + "' (" + ratio.toFixed(2) + ":1)");
                        }
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

        // ---- 508_HAIRLINE_RULE ----
        safe(function () {
            var thin = 0, samples = [];
            for (var p = 0; p < doc.pages.length; p++) {
                var page = doc.pages[p];
                var items = page.pageItems;
                for (var i = 0; i < items.length; i++) {
                    var it = items[i];
                    var sw = null, sc = null;
                    try { sw = Number(it.strokeWeight) || 0; } catch (e) { continue; }
                    if (sw <= 0 || sw >= 1) continue;
                    try { sc = it.strokeColor; } catch (e) {}
                    var stroked = !!sc && String(sc.name || "") !== "None";
                    if (!stroked) continue;
                    thin++;
                    if (samples.length < 6) {
                        samples.push("p" + (p+1) + " " + (it.constructor.name || "item") + " " + sw + "pt");
                    }
                }
            }
            if (thin > 0) {
                FINDING("warning", "508_HAIRLINE_RULE", "508", "doc",
                    thin + " stroke(s) below 1pt (hairlines may disappear during PDF tagging): " + samples.join(" | "),
                    false,
                    "Increase stroke weight to ≥1pt for any rule that must remain visible");
            }
        }, "508 hairline rule");

        // ---- 508_IMG_NO_ALT ----
        safe(function () {
            var noAlt = 0, samples = [];
            try {
                var graphics = doc.allGraphics;
                for (var g = 0; g < graphics.length; g++) {
                    var gr = graphics[g];
                    var alt = "";
                    try { alt = String(gr.parent.altMetadataProperty.value || ""); } catch (e) {}
                    if (!alt) {
                        try { alt = String(gr.altMetadataProperty.value || ""); } catch (e) {}
                    }
                    if (alt && alt.length > 0) continue;
                    noAlt++;
                    if (samples.length < 6) {
                        var nm = "";
                        try { nm = String(gr.itemLink && gr.itemLink.name) || ""; } catch (e) {}
                        samples.push(nm || "graphic " + (g+1));
                    }
                }
            } catch (e) {}
            if (noAlt > 0) {
                FINDING("error", "508_IMG_NO_ALT", "508", "doc",
                    noAlt + " image(s) missing alt text: " + samples.join(", "),
                    false,
                    "Object > Object Export Options > Alt Text — add a description for each image");
            }
        }, "508 alt text");

        // ---- 508_DOC_PROPS_MISSING ----
        safe(function () {
            var props = doc.metadataPreferences;
            var title = "", author = "", subject = "", keywords = "";
            try { title    = String(props.documentTitle  || ""); } catch (e) {}
            try { author   = String(props.author         || ""); } catch (e) {}
            try { subject  = String(props.description    || ""); } catch (e) {}
            try { keywords = String(props.keywords       || ""); } catch (e) {}
            var missing = [];
            if (!title)    missing.push("title");
            if (!author)   missing.push("author");
            if (!subject)  missing.push("subject");
            if (!keywords) missing.push("keywords");
            if (missing.length > 0) {
                FINDING("warning", "508_DOC_PROPS_MISSING", "508", "doc",
                    "Document metadata missing: " + missing.join(", "),
                    false,
                    "File > File Info — set title (document name), author (agency), subject (doc type), keywords (search terms)");
            }
        }, "508 doc properties");

        // 508_TAGGED_PDF_OFF is auto-fixed at export time (STEP 5) by setting
        // pdfExportPreferences.exportingTaggedPDF = true.
    }

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

    JT_start("step 4.5: saving + exporting PDF");
    L("STEP 5: saving + exporting");
    doc.save(File(inddPath));

    // PDF export strategy: print-targeted presets (e.g. [High Quality Print])
    // strip interactive features — including TOC hyperlinks. We need a "web"-
    // style preset OR manual interactive-friendly prefs. Sequence:
    //   1) Find "CMYK WEB" / "CMYK Web" / similar preset
    //   2) Copy its properties into pdfExportPreferences (so we inherit
    //      its CMYK / compression settings)
    //   3) FORCE includeHyperlinks/includeBookmarks ON after the copy
    //   4) Export WITHOUT passing the preset arg (otherwise InDesign re-
    //      applies the preset at export and clobbers our overrides)
    var preset = null;
    var presetCandidates = ["CMYK WEB", "CMYK Web", "CMYK_Web", "CMYK-Web"];
    for (var pp = 0; pp < presetCandidates.length; pp++) {
        try {
            var p = app.pdfExportPresets.itemByName(presetCandidates[pp]);
            if (p && p.isValid) { preset = p; L("  found PDF preset: '" + presetCandidates[pp] + "'"); break; }
        } catch (e) {}
    }
    if (!preset) {
        // Log what IS available so we can see why "CMYK Web" wasn't there
        var avail = [];
        try {
            for (var pi = 0; pi < app.pdfExportPresets.length; pi++) {
                try { avail.push(String(app.pdfExportPresets[pi].name)); } catch (e) {}
            }
        } catch (e) {}
        L("  CMYK Web preset NOT FOUND. Available presets: " + avail.join(" | "));
        // Fall back to interactive-friendly preset
        var fallbacks = ["[Smallest File Size]", "[High Quality Print]", "[Press Quality]"];
        for (var fb = 0; fb < fallbacks.length; fb++) {
            try {
                var fp = app.pdfExportPresets.itemByName(fallbacks[fb]);
                if (fp && fp.isValid) { preset = fp; L("  using fallback preset: '" + fallbacks[fb] + "'"); break; }
            } catch (e) {}
        }
        if (!preset) preset = app.pdfExportPresets[0];
    }

    // Step 2: copy preset properties into pdfExportPreferences (so we keep
    // CMYK conversion, compression, etc. from the preset)
    try {
        app.pdfExportPreferences.properties = preset.properties;
        L("  copied preset properties to pdfExportPreferences");
    } catch (e) { L("  preset-properties copy err: " + e); }

    // Step 3: force interactive features ON
    try { app.pdfExportPreferences.includeHyperlinks         = true;  } catch (e) {}
    try { app.pdfExportPreferences.includeBookmarks          = true;  } catch (e) {}
    try { app.pdfExportPreferences.exportLayers              = false; } catch (e) {}
    // Some print presets explicitly set these to NONE — re-enable.
    try { app.pdfExportPreferences.interactiveElementsOption = InteractiveElementsOptions.INCLUDE_ALL; } catch (e) {}
    // 508: tagged PDF (required for screen-reader compliance)
    if (qaConfig.run_508_check) {
        try { app.pdfExportPreferences.exportingTaggedPDF = true; } catch (e) {}
        L("  508: forced exportingTaggedPDF = true");
        FINDING("info", "508_TAGGED_PDF_ON", "508", "doc",
            "Exported with Create Tagged PDF enabled (required for 508)", true);
    }

    // Step 4: export WITHOUT preset arg so our overrides are honored.
    doc.exportFile(ExportFormat.PDF_TYPE, File(pdfOut), false);
    L("Exported PDF: " + pdfOut + " (interactive features forced ON)");

    doc.close(SaveOptions.YES);
    app.scriptPreferences.userInteractionLevel = UserInteractionLevels.INTERACT_WITH_ALL;
    app.scriptPreferences.enableRedraw = true;

    var ff = File(flagsPath); ff.encoding = "UTF-8"; ff.open("w"); ff.write(flags.join("\n")); ff.close();

    // Emit the per-sub-step timing summary so orchestrate.py can tee it
    // through to /tmp/pb_orchestrate.log alongside the top-level summary.
    JT_summary();

    } catch (e) {
        try {
            var em = "FATAL: " + e + " (line " + e.line + ")\n" + (e.stack || "");
            var lf = File(__outerLogPath); lf.encoding = "UTF-8"; lf.open("a"); lf.write("\n" + em); lf.close();
        } catch (ee) {}
    }
})();
