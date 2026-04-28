// Generic edit executor + post-edit canonicalization + comprehensive QA scan.
// v0.3: works on any document. Multi-table aware. Generic alt-fill preservation.
// Path tokens are substituted by orchestrate.py at runtime.
#target indesign

(function () {
    var __outerLogPath = "__LOG_PATH__";
    try {

    var inddPath        = "__INDD_PATH__";
    var pdfOut          = "__PDF_OUT_PATH__";
    var logPath         = "__LOG_PATH__";
    var flagsPath       = "__FLAGS_PATH__";
    var findingsPath    = "__FINDINGS_PATH__";
    var hyperlinksPath  = "__HYPERLINKS_PATH__";
    var editsPath       = "__EDITS_PATH__";
    var qaConfigPath    = "__QA_CONFIG_PATH__";

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

    L("STEP 0: starting");
    app.scriptPreferences.userInteractionLevel = UserInteractionLevels.NEVER_INTERACT;
    app.scriptPreferences.enableRedraw = false;
    var doc = app.open(File(inddPath), false);
    L("STEP 1: opened doc: " + doc.name);

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
                allTables.push({
                    id: "p" + (p+1) + "_tf" + f + "_t" + t,
                    table: tbl,
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
        if (newText !== undefined) cell.contents = String(newText || "");
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
    // EDIT DISPATCHER
    // ==========================================================
    var modifiedTables = {}; // table id → true; for post-edit canonicalization
    function markTableModified(tbl) {
        for (var i = 0; i < allTables.length; i++) if (allTables[i].table === tbl) { modifiedTables[allTables[i].id] = true; return; }
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
            // the table's column count (LLMs sometimes hallucinate single-value
            // rows for atomic-word annotations like "Program" or "Subtype").
            // Allow up to \u00B11 column tolerance for trailing optional fields.
            if (values.length < tbl.columns.length - 1) {
                FLAG(op + ": refused \u2014 only " + values.length + " value(s) for " + tbl.columns.length + "-column table. Annotation: \"" + (edit.source_annotation || "").substring(0, 80) + "\"");
                return;
            }
            markTableModified(tbl);
            var headerRows = tbl.headerRowCount;
            var insertAt = (op === "INSERT_ROW_AT" && edit.params && edit.params.index != null) ? edit.params.index : tbl.rows.length;
            // Pick a body row to use as formatting template
            var sampleIdx = Math.max(headerRows, Math.min(tbl.rows.length - 1, insertAt - 1));
            var sampleSnaps = [];
            for (var c = 0; c < tbl.columns.length; c++) sampleSnaps.push(snapshotCellFormat(tbl.rows[sampleIdx].cells[c]));
            // Add row at end then move (InDesign tables don't support arbitrary insertion well; we add and move via swapping).
            var newRow;
            if (op === "INSERT_ROW_AT" && insertAt < tbl.rows.length) {
                newRow = tbl.rows[insertAt - 1].insertRows(LocationOptions.AFTER, 1, 0)[0];
            } else {
                newRow = tbl.rows.add(LocationOptions.AT_END);
            }
            for (var c = 0; c < tbl.columns.length; c++) {
                var text = c < values.length ? values[c] : "";
                applyCellFormat(newRow.cells[c], sampleSnaps[c], text);
            }
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
            if (!find) { FLAG("REPLACE_TEXT: no find string"); return; }
            app.findGrepPreferences = NothingEnum.NOTHING;
            app.changeGrepPreferences = NothingEnum.NOTHING;
            app.findGrepPreferences.findWhat = find;
            app.changeGrepPreferences.changeTo = String(replace || "");
            var hits = doc.changeGrep().length;
            L("  replaced " + hits + " occurrence(s) of \"" + find + "\"");
            app.findGrepPreferences = NothingEnum.NOTHING;
            app.changeGrepPreferences = NothingEnum.NOTHING;
            return;
        }

        FLAG("Unknown edit op: " + op);
    }

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

    // ==========================================================
    // STEP 4: COMPREHENSIVE QA SCAN
    // ==========================================================
    L("\nSTEP 4: comprehensive QA scan");

    safe(function () {
        app.findGrepPreferences = NothingEnum.NOTHING; app.changeGrepPreferences = NothingEnum.NOTHING;
        app.findGrepPreferences.findWhat = "  +"; app.changeGrepPreferences.changeTo = " ";
        var n1 = doc.changeGrep().length;
        app.findGrepPreferences = NothingEnum.NOTHING; app.changeGrepPreferences = NothingEnum.NOTHING;
        app.findGrepPreferences.findWhat = " +(?=\\r|\\n|$)"; app.changeGrepPreferences.changeTo = "";
        var n2 = doc.changeGrep().length;
        if (n1 + n2 > 0) FINDING("info", "TEXT_WHITESPACE", "text", "doc-wide", "auto-fixed " + n1 + " multi-space, " + n2 + " trailing-whitespace occurrence(s)", true);
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

    } catch (e) {
        try {
            var em = "FATAL: " + e + " (line " + e.line + ")\n" + (e.stack || "");
            var lf = File(__outerLogPath); lf.encoding = "UTF-8"; lf.open("a"); lf.write("\n" + em); lf.close();
        } catch (ee) {}
    }
})();
