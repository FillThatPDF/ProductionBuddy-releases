// InDesign Data Merge driver — find/replace flavor.
//
// Inputs (substituted by orchestrate.py at render time):
//   __TEMPLATE_INDD__   tagged template (.indd) with <<placeholder>> literals
//   __CSV_PATH__        the data CSV produced by data_merge.py
//   __OUTPUT_DIR__      where the per-state .indd files should land
//   __LOG_PATH__        log file
//   __NAME_COLUMN__     CSV column whose value is used in the output filename
//
// Strategy (NOT InDesign's native Data Merge):
//   For each record in CSV:
//     1. Open the template fresh (read-only effectively — closed without save)
//     2. For each column, find/replace literal "<<col>>" with the row value
//     3. (Image columns whose header starts with "@" are skipped here —
//        they need frame-level relinking, handled separately)
//     4. saveACopy() to <TemplateName>_<RecordName>.indd
//     5. Close template without saving
//
// We use literal find/change text so values like "$1,234" don't get
// interpreted as regex/grep metacharacters.
#target indesign

(function () {
    var TEMPLATE   = "__TEMPLATE_INDD__";
    var CSV_PATH   = "__CSV_PATH__";
    var OUTPUT_DIR = "__OUTPUT_DIR__";
    var LOG_PATH   = "__LOG_PATH__";
    var NAME_COL   = "__NAME_COLUMN__";

    var logBuf = [];
    function L(s) { logBuf.push(String(s)); }
    function flush() {
        try {
            var lf = File(LOG_PATH); lf.encoding = "UTF-8"; lf.open("a");
            lf.write(logBuf.join("\n") + "\n"); lf.close();
        } catch (e) {}
        logBuf = [];
    }

    function safeName(s) {
        return String(s || "").replace(/[\/\\:\*\?"<>\|]/g, "").replace(/\s+/g, "_");
    }

    L("\n--- DATA MERGE STEP ---");
    L("template:  " + TEMPLATE);
    L("csv:       " + CSV_PATH);
    L("output:    " + OUTPUT_DIR);
    L("name col:  " + NAME_COL);

    app.scriptPreferences.userInteractionLevel = UserInteractionLevels.NEVER_INTERACT;
    app.scriptPreferences.enableRedraw = false;

    function parseCsvRow(line) {
        var out = [], cur = "", inQ = false;
        for (var i = 0; i < line.length; i++) {
            var ch = line.charAt(i);
            if (inQ) {
                if (ch === "\"") {
                    if (i + 1 < line.length && line.charAt(i + 1) === "\"") { cur += "\""; i++; }
                    else inQ = false;
                } else cur += ch;
            } else {
                if (ch === ",") { out.push(cur); cur = ""; }
                else if (ch === "\"") inQ = true;
                else cur += ch;
            }
        }
        out.push(cur);
        return out;
    }

    // Read CSV (records may span multiple lines because of quoted newlines)
    var csvFile = File(CSV_PATH); csvFile.encoding = "UTF-8"; csvFile.open("r");
    var csvText = csvFile.read(); csvFile.close();
    // Parse with quote-aware row splitting
    function splitRows(text) {
        var rows = [], cur = "", inQ = false;
        for (var i = 0; i < text.length; i++) {
            var ch = text.charAt(i);
            if (ch === "\"") {
                if (inQ && i + 1 < text.length && text.charAt(i + 1) === "\"") { cur += "\"\""; i++; }
                else { inQ = !inQ; cur += ch; }
            } else if ((ch === "\n" || ch === "\r") && !inQ) {
                if (ch === "\r" && i + 1 < text.length && text.charAt(i + 1) === "\n") i++;
                if (cur.length) { rows.push(cur); cur = ""; }
            } else cur += ch;
        }
        if (cur.length) rows.push(cur);
        return rows;
    }
    var rows = splitRows(csvText);
    if (rows.length < 2) { L("CSV has no data rows"); flush(); return; }
    var headers = parseCsvRow(rows[0]);
    var nameColIdx = -1;
    for (var hi = 0; hi < headers.length; hi++) {
        if (String(headers[hi]).toLowerCase() === String(NAME_COL).toLowerCase()) {
            nameColIdx = hi; break;
        }
    }

    // Identify text-substitution columns (skip @image-style and the name col)
    var subColumns = [];
    for (var ci = 0; ci < headers.length; ci++) {
        var h = String(headers[ci] || "");
        if (h.charAt(0) === "@") continue; // image column, handled elsewhere
        if (h === "") continue;
        subColumns.push({ name: h, idx: ci });
    }
    L("substitution columns: " + subColumns.length);

    var fcOpts = app.findChangeTextOptions;
    fcOpts.includeFootnotes = true;
    fcOpts.includeHiddenLayers = true;
    fcOpts.includeLockedLayersForFind = false;
    fcOpts.includeLockedStoriesForFind = false;
    fcOpts.includeMasterPages = true;

    var generated = 0, failed = 0;
    for (var r = 1; r < rows.length; r++) {
        if (!rows[r] || !rows[r].length) continue;
        var fields = parseCsvRow(rows[r]);
        var recordName = (nameColIdx >= 0 && nameColIdx < fields.length)
            ? fields[nameColIdx] : ("record_" + r);
        recordName = safeName(recordName) || ("record_" + r);

        L("[" + r + "] '" + recordName + "'");
        flush();

        var doc = null;
        try {
            doc = app.open(File(TEMPLATE));
        } catch (e) {
            L("  ! could not open template: " + e);
            failed++; continue;
        }

        // Pass 1: for any column whose value is NA / 0 / empty, delete the
        // paragraph containing the placeholder AND the immediately preceding
        // paragraph (the label). This collapses "Contract Manufacturing
        // Organizations / NA" into nothing instead of a dangling label.
        function isEmptyish(v) {
            if (v === null || v === undefined) return true;
            var s = String(v).replace(/^\s+|\s+$/g, "");
            if (s === "" || s.toUpperCase() === "NA") return true;
            // strip $ and commas, see if numerically zero
            var num = s.replace(/[$,\s]/g, "");
            if (num === "0" || num === "0.0" || num === "0.00") return true;
            return false;
        }

        var blanksCleaned = 0;
        for (var bi = 0; bi < subColumns.length; bi++) {
            var bcol = subColumns[bi];
            var bval = (bcol.idx < fields.length) ? fields[bcol.idx] : "";
            if (!isEmptyish(bval)) continue;

            // Iteratively clean one occurrence at a time. Each pass re-finds
            // the next remaining placeholder, which avoids stale-reference
            // issues when removing paragraphs across multiple stories.
            var safety = 0;
            while (safety++ < 50) {
                app.findTextPreferences = NothingEnum.NOTHING;
                app.changeTextPreferences = NothingEnum.NOTHING;
                app.findTextPreferences.findWhat = "<<" + bcol.name + ">>";
                var hits = [];
                try { hits = doc.findText(); } catch (e) { break; }
                if (!hits || hits.length === 0) break;

                try {
                    var hit = hits[0];
                    var paras = hit.paragraphs;
                    if (!paras || paras.length === 0) break;
                    var para = paras[0];

                    // Case A: placeholder lives inside a table cell. Remove the
                    // entire row so the label and value disappear together.
                    var paraParent = null;
                    try { paraParent = para.parent; } catch (e) {}
                    var isInCell = false;
                    try {
                        isInCell = paraParent && paraParent.constructor &&
                                   String(paraParent.constructor.name) === "Cell";
                    } catch (e) {}
                    if (isInCell) {
                        try {
                            var cell = paraParent;
                            var row = cell.parentRow;
                            row.remove();
                            blanksCleaned++;
                            continue;
                        } catch (e) {
                            break;
                        }
                    }

                    // Case B: placeholder lives in a regular story / text frame.
                    var story = para.parentStory;
                    var paraIdx = -1;
                    for (var pi = 0; pi < story.paragraphs.length; pi++) {
                        if (story.paragraphs[pi].index === para.index) {
                            paraIdx = pi; break;
                        }
                    }
                    // Delete preceding paragraph (label) if it looks like a label
                    if (paraIdx > 0) {
                        var prev = story.paragraphs[paraIdx - 1];
                        var prevText = prev.contents;
                        if (prevText && prevText.replace(/\s/g, "") !== "" &&
                            prevText.indexOf("<<") < 0) {
                            prev.remove();
                        }
                    }
                    // Re-find and delete the placeholder's paragraph
                    app.findTextPreferences = NothingEnum.NOTHING;
                    app.findTextPreferences.findWhat = "<<" + bcol.name + ">>";
                    var hits2 = [];
                    try { hits2 = doc.findText(); } catch (e) {}
                    if (hits2 && hits2.length > 0) {
                        try { hits2[0].paragraphs[0].remove(); } catch (_) {}
                    }
                    blanksCleaned++;
                } catch (e) {
                    // Couldn't process this hit — break to avoid an infinite loop
                    break;
                }
            }
        }
        app.findTextPreferences = NothingEnum.NOTHING;
        app.changeTextPreferences = NothingEnum.NOTHING;

        // Pass 2: regular substitution for remaining placeholders
        var totalSubs = 0;
        for (var s = 0; s < subColumns.length; s++) {
            var col = subColumns[s];
            var rawVal = (col.idx < fields.length) ? fields[col.idx] : "";
            if (isEmptyish(rawVal)) continue;
            app.findTextPreferences = NothingEnum.NOTHING;
            app.changeTextPreferences = NothingEnum.NOTHING;
            app.findTextPreferences.findWhat = "<<" + col.name + ">>";
            // Multi-line list values: convert \n (CSV) to \r (InDesign paragraph break)
            var changeStr = String(rawVal).replace(/\r\n/g, "\r").replace(/\n/g, "\r");
            app.changeTextPreferences.changeTo = changeStr;
            try {
                var hits = doc.changeText();
                totalSubs += hits.length;
            } catch (e) {
                L("  ! change failed for " + col.name + ": " + e);
            }
        }
        app.findTextPreferences = NothingEnum.NOTHING;
        app.changeTextPreferences = NothingEnum.NOTHING;
        L("  subs=" + totalSubs + " blank-cleaned=" + blanksCleaned);

        var baseName = doc.name.replace(/\.indd$/i, "");
        var outFile = File(OUTPUT_DIR + "/" + baseName + "_" + recordName + ".indd");
        try {
            doc.saveACopy(outFile);
            doc.close(SaveOptions.NO);
            generated++;
            L("  -> " + outFile.fsName);
        } catch (e) {
            L("  ! save failed for " + recordName + ": " + e);
            try { doc.close(SaveOptions.NO); } catch (_) {}
            failed++;
        }
        flush();
    }

    L("DONE — generated=" + generated + " failed=" + failed);
    flush();

    app.scriptPreferences.userInteractionLevel = UserInteractionLevels.INTERACT_WITH_ALL;
    app.scriptPreferences.enableRedraw = true;
})();
