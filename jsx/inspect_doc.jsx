// Read-only deep inspection: emit a JSON map of the document structure for the Claude API.
// Goes beyond a flat structure list — captures style property values, per-table headers and
// alternating-fill detection, story context samples, hyperlinks, and detected document type.
// Path tokens are substituted by orchestrate.py at runtime.
#target indesign

(function () {
    var inddPath = "__INDD_PATH__";
    var outPath  = "__INSPECT_OUT_PATH__";

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
    function safeName(o) { try { return o ? o.name : null; } catch (e) { return null; } }
    function safeProp(o, p) { try { return o[p]; } catch (e) { return null; } }
    function safeColorName(c) { try { return c ? c.name : null; } catch (e) { return null; } }

    app.scriptPreferences.userInteractionLevel = UserInteractionLevels.NEVER_INTERACT;
    var doc = app.open(File(inddPath), false);

    // ---- Style inventories with key property values ----
    function paragraphStyleSummary(ps) {
        return "{" +
            "\"name\":" + jsonStr(ps.name) + "," +
            "\"font\":" + jsonStr(safeName(safeProp(ps, "appliedFont"))) + "," +
            "\"pointSize\":" + (safeProp(ps, "pointSize") || "null") + "," +
            "\"leading\":" + (function(){ try { var v = ps.leading; return typeof v === "number" ? v : "null"; } catch (e) { return "null"; } })() + "," +
            "\"fillColor\":" + jsonStr(safeColorName(safeProp(ps, "fillColor"))) + "," +
            "\"justification\":" + jsonStr(String(safeProp(ps, "justification"))) +
        "}";
    }
    function characterStyleSummary(cs) {
        return "{" +
            "\"name\":" + jsonStr(cs.name) + "," +
            "\"font\":" + jsonStr(safeName(safeProp(cs, "appliedFont"))) + "," +
            "\"fillColor\":" + jsonStr(safeColorName(safeProp(cs, "fillColor"))) + "," +
            "\"position\":" + jsonStr(String(safeProp(cs, "position"))) +
        "}";
    }
    function cellStyleSummary(cs) {
        return "{" +
            "\"name\":" + jsonStr(cs.name) + "," +
            "\"fillColor\":" + jsonStr(safeColorName(safeProp(cs, "fillColor"))) +
        "}";
    }

    var paraStyles = [];
    for (var i = 0; i < doc.paragraphStyles.length; i++) try { paraStyles.push(paragraphStyleSummary(doc.paragraphStyles[i])); } catch (e) {}
    var charStyles = [];
    for (var i = 0; i < doc.characterStyles.length; i++) try { charStyles.push(characterStyleSummary(doc.characterStyles[i])); } catch (e) {}
    var cellStyles = [];
    for (var i = 0; i < doc.cellStyles.length; i++) try { cellStyles.push(cellStyleSummary(doc.cellStyles[i])); } catch (e) {}

    var swatches = [];
    for (var i = 0; i < doc.swatches.length; i++) {
        try {
            var sw = doc.swatches[i];
            var space = "?", model = "?";
            try { space = String(sw.space); } catch (e) {}
            try { model = String(sw.colorModel); } catch (e) {}
            swatches.push("{\"name\":" + jsonStr(sw.name) + ",\"space\":" + jsonStr(space) + ",\"model\":" + jsonStr(model) + "}");
        } catch (e) {}
    }

    // ---- Detect alternating fill on a table by examining first 4 body rows ----
    function detectAltFill(tbl) {
        var headerRows = tbl.headerRowCount;
        if (tbl.rows.length - headerRows < 2) return { type: "unknown" };
        var lastCol = tbl.columns.length - 1;
        var fills = [];
        for (var r = headerRows; r < Math.min(tbl.rows.length, headerRows + 4); r++) {
            var rowFills = [];
            for (var c = 0; c < tbl.columns.length; c++) {
                try {
                    var fc = tbl.rows[r].cells[c].fillColor;
                    rowFills.push(fc ? fc.name : "(null)");
                } catch (e) { rowFills.push("?"); }
            }
            fills.push(rowFills);
        }
        // Compare row 1 vs row 2 (second body row vs first) — if different in non-col-0, alternating
        if (fills.length >= 2) {
            var diffCols = 0;
            for (var c = 1; c < tbl.columns.length; c++) {
                if (fills[0][c] !== fills[1][c]) diffCols++;
            }
            if (diffCols >= 1) return { type: "per_cell_alternating", row0_fills: fills[0], row1_fills: fills[1] };
        }
        // Otherwise check table-level alternating
        var alt = "?", startFill = "?", endFill = "?";
        try { alt = String(tbl.alternatingFills); } catch (e) {}
        try { startFill = tbl.startRowFillColor ? tbl.startRowFillColor.name : null; } catch (e) {}
        try { endFill = tbl.endRowFillColor ? tbl.endRowFillColor.name : null; } catch (e) {}
        return { type: "table_level", alt: alt, start: startFill, end: endFill };
    }

    // ---- Per-table inspection ----
    function inspectTable(tbl, tableId) {
        var headerRows = tbl.headerRowCount;
        var cols = tbl.columns.length;
        var rows = tbl.rows.length;

        // Header signature (concatenated header cell text)
        var headerCells = [];
        if (headerRows > 0) {
            for (var c = 0; c < cols; c++) {
                var t = ""; try { t = String(tbl.rows[0].cells[c].contents).substring(0, 50).replace(/[\r\n]+/g, " "); } catch (e) {}
                headerCells.push(jsonStr(t));
            }
        }

        // First-body-row sample with cell styles + paragraph styles (so Claude knows what to apply on new rows)
        var bodyRowSample = [];
        if (rows > headerRows) {
            for (var c = 0; c < cols; c++) {
                var cell = tbl.rows[headerRows].cells[c];
                var contents = ""; try { contents = String(cell.contents).substring(0, 60).replace(/[\r\n]+/g, " "); } catch (e) {}
                bodyRowSample.push("{" +
                    "\"contents\":" + jsonStr(contents) + "," +
                    "\"cellStyle\":" + jsonStr(safeName(safeProp(cell, "appliedCellStyle"))) + "," +
                    "\"paraStyle\":" + jsonStr(safeName(safeProp(cell.paragraphs[0], "appliedParagraphStyle"))) + "," +
                    "\"fillColor\":" + jsonStr(safeColorName(safeProp(cell, "fillColor"))) +
                "}");
            }
        }

        // Detect alternating fill
        var altFill = detectAltFill(tbl);

        return "{" +
            "\"id\":" + jsonStr(tableId) + "," +
            "\"rows\":" + rows + "," +
            "\"columns\":" + cols + "," +
            "\"headerRows\":" + headerRows + "," +
            "\"headerCells\":[" + headerCells.join(",") + "]," +
            "\"firstBodyRow\":[" + bodyRowSample.join(",") + "]," +
            "\"altFill\":" + jsonStr(altFill.type) + "," +
            "\"appliedTableStyle\":" + jsonStr(safeName(safeProp(tbl, "appliedTableStyle"))) +
        "}";
    }

    // ---- Per-page inspection ----
    var pages = [];
    for (var p = 0; p < doc.pages.length; p++) {
        var page = doc.pages[p];
        var frames = [];
        for (var f = 0; f < page.textFrames.length; f++) {
            var tf = page.textFrames[f];
            var preview = ""; try { preview = String(tf.contents).substring(0, 120).replace(/[\r\n]+/g, " "); } catch (e) {}
            var bounds = []; try { bounds = tf.geometricBounds; } catch (e) {}
            var tables = [];
            try {
                for (var t = 0; t < tf.tables.length; t++) {
                    tables.push(inspectTable(tf.tables[t], "p" + (p+1) + "_tf" + f + "_t" + t));
                }
            } catch (e) {}
            frames.push("{" +
                "\"id\":" + jsonStr("p" + (p+1) + "_tf" + f) + "," +
                "\"bounds\":[" + bounds.join(",") + "]," +
                "\"preview\":" + jsonStr(preview) + "," +
                "\"overflows\":" + (safeProp(tf, "overflows") ? "true" : "false") + "," +
                "\"tables\":[" + tables.join(",") + "]" +
            "}");
        }
        pages.push("{\"page\":" + (p+1) + ",\"frames\":[" + frames.join(",") + "]}");
    }

    // ---- Hyperlinks inventory ----
    var hyperlinks = [];
    for (var h = 0; h < doc.hyperlinks.length; h++) {
        try {
            var lk = doc.hyperlinks[h];
            var src = "", dst = "";
            try { src = lk.source.sourceText.contents; } catch (e) {}
            try { dst = lk.destination.destinationURL || ""; } catch (e) {}
            hyperlinks.push("{\"src\":" + jsonStr(src) + ",\"dest\":" + jsonStr(dst) + "}");
        } catch (e) {}
    }

    // ---- Story context (first 200 chars of each story for doc-type detection) ----
    var storiesPreview = [];
    for (var s = 0; s < Math.min(doc.stories.length, 10); s++) {
        try {
            var content = String(doc.stories[s].contents).substring(0, 200).replace(/[\r\n]+/g, " ");
            if (content.length > 5) storiesPreview.push(jsonStr(content));
        } catch (e) {}
    }

    // ---- Placed-image inventory (paths + filenames) ----
    // Used by the hi-res swap pre-pass to identify watermarked stock-photo
    // comps and re-link them to licensed hi-res versions in the user's
    // Box Images folder.
    var placedImages = [];
    try {
        var allG = doc.allGraphics;
        for (var gi = 0; gi < allG.length; gi++) {
            try {
                var lk = allG[gi].itemLink;
                if (!lk) continue;
                var lkPath = "", lkName = "";
                try { lkPath = String(lk.filePath || ""); } catch (e) {}
                try { lkName = String(lk.name || ""); } catch (e) {}
                if (!lkPath && !lkName) continue;
                placedImages.push(
                    "{\"path\":" + jsonStr(lkPath) +
                    ",\"name\":" + jsonStr(lkName) + "}"
                );
            } catch (e) {}
        }
    } catch (e) {}

    // ---- Document-type heuristic ----
    var docType = "unknown";
    var hasTableWithRaters = false, hasFormFields = false;
    for (var p = 0; p < doc.pages.length; p++) {
        for (var f = 0; f < doc.pages[p].textFrames.length; f++) {
            try {
                for (var t = 0; t < doc.pages[p].textFrames[f].tables.length; t++) {
                    var ttable = doc.pages[p].textFrames[f].tables[t];
                    if (ttable.rows.length >= 10 && ttable.columns.length >= 4) hasTableWithRaters = true;
                }
            } catch (e) {}
        }
    }
    if (hasTableWithRaters) docType = "directory_or_table_doc";

    var json = "{" +
        "\"doc_name\":" + jsonStr(doc.name) + "," +
        "\"doc_type_hint\":" + jsonStr(docType) + "," +
        "\"page_count\":" + doc.pages.length + "," +
        "\"page_size\":[" + doc.documentPreferences.pageWidth + "," + doc.documentPreferences.pageHeight + "]," +
        "\"bleed\":{" +
            "\"top\":" + doc.documentPreferences.documentBleedTopOffset + "," +
            "\"bottom\":" + doc.documentPreferences.documentBleedBottomOffset + "," +
            "\"left\":" + doc.documentPreferences.documentBleedInsideOrLeftOffset + "," +
            "\"right\":" + doc.documentPreferences.documentBleedOutsideOrRightOffset +
        "}," +
        "\"paragraph_styles\":[" + paraStyles.join(",") + "]," +
        "\"character_styles\":[" + charStyles.join(",") + "]," +
        "\"cell_styles\":[" + cellStyles.join(",") + "]," +
        "\"swatches\":[" + swatches.join(",") + "]," +
        "\"pages\":[" + pages.join(",") + "]," +
        "\"hyperlinks\":[" + hyperlinks.join(",") + "]," +
        "\"stories_preview\":[" + storiesPreview.join(",") + "]," +
        "\"placed_images\":[" + placedImages.join(",") + "]" +
    "}";

    var f = File(outPath);
    f.encoding = "UTF-8"; f.open("w"); f.write(json); f.close();
    doc.close(SaveOptions.NO);
})();
