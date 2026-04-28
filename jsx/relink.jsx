// Apply automatic relinks for previously-missing assets.
// Reads relinks.json (produced by Python after Box search) with shape:
//   [ { "source_filename": "I&M-logo-white.eps", "target_path": "/Users/.../I&M-logo-white.eps" }, ... ]
// For each entry, finds a matching Link in the doc and re-points it.
// Then re-saves the doc and re-exports the PDF.
#target indesign

(function () {
    var inddPath        = "__INDD_PATH__";
    var pdfOut          = "__PDF_OUT_PATH__";
    var relinksPath     = "__RELINKS_PATH__";
    var logPath         = "__LOG_PATH__";

    var lines = [];
    function L(s) { lines.push(String(s)); $.writeln(s); }

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

    try {
        // Read relinks.json
        var rj = "";
        try { var rf = File(relinksPath); rf.encoding = "UTF-8"; rf.open("r"); rj = rf.read(); rf.close(); } catch (e) {
            L("No relinks.json found, nothing to do."); return;
        }
        var relinks = [];
        try { relinks = eval("(" + rj + ")"); } catch (e) { L("Could not parse relinks.json: " + e); return; }
        if (!relinks || relinks.length === 0) { L("relinks.json empty"); return; }

        L("RELINK STEP — " + relinks.length + " relink(s) to apply");

        app.scriptPreferences.userInteractionLevel = UserInteractionLevels.NEVER_INTERACT;
        app.scriptPreferences.enableRedraw = false;
        var doc = app.open(File(inddPath), false);
        L("Opened: " + doc.name);

        var allLinks = doc.links;
        var success = 0, failed = [];

        for (var i = 0; i < relinks.length; i++) {
            var entry = relinks[i];
            var srcName = entry.source_filename;
            var tgtPath = entry.target_path;
            if (!srcName || !tgtPath) continue;
            var matched = false;
            for (var j = 0; j < allLinks.length; j++) {
                try {
                    var lk = allLinks[j];
                    if (lk.name === srcName && lk.status === LinkStatus.LINK_MISSING) {
                        lk.relink(File(tgtPath));
                        try { lk.update(); } catch (e) {}
                        L("  ✓ relinked '" + srcName + "' → " + tgtPath);
                        success++;
                        matched = true;
                        break;
                    }
                } catch (e) { L("  relink err for " + srcName + ": " + e); }
            }
            if (!matched) { failed.push(srcName); L("  ✗ couldn't find matching missing-link entry for: " + srcName); }
        }

        L("Saving doc + re-exporting PDF…");
        doc.save(File(inddPath));

        var preset = null;
        try { preset = app.pdfExportPresets.itemByName("[High Quality Print]"); if (!preset.isValid) preset = null; } catch (e) {}
        if (!preset) preset = app.pdfExportPresets[0];
        doc.exportFile(ExportFormat.PDF_TYPE, File(pdfOut), false, preset);
        L("Re-exported: " + pdfOut);

        doc.close(SaveOptions.YES);
        app.scriptPreferences.userInteractionLevel = UserInteractionLevels.INTERACT_WITH_ALL;
        app.scriptPreferences.enableRedraw = true;

        L("RELINK STEP done — success=" + success + " failed=" + failed.length);

        // Write a result file so Python can update findings.json
        try {
            var rr = File(relinksPath + ".result");
            rr.encoding = "UTF-8"; rr.open("w");
            rr.write("{\"success\":" + success + ",\"failed\":" + failed.length + ",\"relinked\":[");
            for (var k = 0; k < relinks.length; k++) {
                if (k > 0) rr.write(",");
                rr.write("{\"source_filename\":" + jsonStr(relinks[k].source_filename) + ",\"target_path\":" + jsonStr(relinks[k].target_path) + "}");
            }
            rr.write("]}");
            rr.close();
        } catch (e) {}
    } catch (e) {
        try {
            var lf = File(logPath); lf.encoding = "UTF-8"; lf.open("a");
            lf.write("\nRELINK FATAL: " + e + " (line " + e.line + ")");
            lf.close();
        } catch (ee) {}
    }

    try {
        var fp = File(logPath); fp.encoding = "UTF-8"; fp.open("a");
        fp.write("\n--- relink.jsx log ---\n" + lines.join("\n"));
        fp.close();
    } catch (e) {}
})();
