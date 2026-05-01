// Apply user-reviewed hyperlink proposals: for each proposal whose `apply` is
// true, find the visible text in the doc and attach a real hyperlink pointing
// at the proposed URL.
//
// Inputs (substituted by orchestrate.py at render time):
//   __INDD_PATH__       the InDesign file to mutate in place
//   __PROPOSALS_PATH__  proposals JSON written by apply_edits_v2.jsx (with
//                        per-proposal `apply` flag + optionally edited URL)
//   __LOG_PATH__        log file
//   __PDF_OUT_PATH__    optional — re-export PDF after applying. Empty = skip.
//
// Strategy:
//   For each proposal we know the original story id + char index. We can
//   directly construct a Text reference at that position. To be robust to
//   the user editing text between the QA scan and Apply, we ALSO accept a
//   doc-wide find/change as a fallback when the position is stale.
#target indesign

(function () {
    var INDD     = "__INDD_PATH__";
    var PROPS    = "__PROPOSALS_PATH__";
    var LOG_PATH = "__LOG_PATH__";
    var PDF_OUT  = "__PDF_OUT_PATH__";

    var lines = [];
    function L(s) { lines.push(String(s)); }
    function flushLog() {
        try { var lf = File(LOG_PATH); lf.encoding="UTF-8"; lf.open("a"); lf.write(lines.join("\n") + "\n"); lf.close(); lines = []; } catch (e) {}
    }
    L("\n--- CREATE HYPERLINKS ---");

    var doc;
    try { doc = app.open(File(INDD)); } catch (e) { L("FATAL open: " + e); flushLog(); return; }

    var pf = File(PROPS); pf.encoding = "UTF-8"; pf.open("r");
    var pj = pf.read(); pf.close();
    var proposal = eval("(" + pj + ")");
    L("proposals: " + (proposal.proposals ? proposal.proposals.length : 0));

    function findStoryById(id) {
        for (var s = 0; s < doc.stories.length; s++) {
            try { if (doc.stories[s].id === id) return doc.stories[s]; } catch (e) {}
        }
        return null;
    }
    function uniqueLinkName(base) {
        var n = base;
        var i = 2;
        while (true) {
            var exists = false;
            try {
                for (var hi = 0; hi < doc.hyperlinks.length; hi++) {
                    if (String(doc.hyperlinks[hi].name) === n) { exists = true; break; }
                }
            } catch (e) {}
            if (!exists) return n;
            n = base + "_" + i; i++;
        }
    }
    function getOrCreateUrlDest(url) {
        // Reuse an existing destination if it already points at this URL —
        // avoids polluting the doc with duplicate destinations.
        for (var di = 0; di < doc.hyperlinkURLDestinations.length; di++) {
            try {
                var d = doc.hyperlinkURLDestinations[di];
                if (String(d.destinationURL) === url) return d;
            } catch (e) {}
        }
        try { return doc.hyperlinkURLDestinations.add(url); }
        catch (e) { L("dest add err " + url + ": " + e); return null; }
    }

    var created = 0, skipped = 0, failed = 0;
    var proposals = proposal.proposals || [];
    for (var pi = 0; pi < proposals.length; pi++) {
        var p = proposals[pi];
        if (p.apply === false) { skipped++; continue; }
        var url = p.proposed_url;
        var text = p.text;
        if (!url || !text) { failed++; continue; }

        var charRange = null;
        // Strategy A: use the saved story_id + char_index (fast, exact)
        try {
            var story = findStoryById(p.story_id);
            if (story) {
                var startIdx = p.char_index;
                var endIdx = startIdx + text.length - 1;
                if (endIdx < story.characters.length) {
                    var probe = String(story.characters.itemByRange(startIdx, endIdx).contents || "");
                    if (probe === text) {
                        charRange = story.characters.itemByRange(startIdx, endIdx);
                    }
                }
            }
        } catch (e) {}

        // Strategy B: doc-wide findText fallback (text moved or got edited)
        if (!charRange) {
            app.findTextPreferences = NothingEnum.NOTHING;
            app.changeTextPreferences = NothingEnum.NOTHING;
            app.findTextPreferences.findWhat = text;
            try {
                var hits = doc.findText();
                if (hits && hits.length > 0) charRange = hits[0];
            } catch (e) {}
            app.findTextPreferences = NothingEnum.NOTHING;
        }

        if (!charRange) { L("not found: " + text); failed++; continue; }

        try {
            var dest = getOrCreateUrlDest(url);
            if (!dest) { failed++; continue; }
            var src = doc.hyperlinkTextSources.add(charRange);
            doc.hyperlinks.add(src, dest, {
                name: uniqueLinkName("autolink_" + (created + 1)),
                visible: false
            });
            created++;
            L("linked '" + text.substring(0, 40) + "' → " + url);
        } catch (e) {
            L("create err for " + text + ": " + e);
            failed++;
        }
    }

    L("created=" + created + " skipped=" + skipped + " failed=" + failed);
    try { doc.save(File(INDD)); L("saved"); } catch (e) { L("save err: " + e); }

    if (PDF_OUT && PDF_OUT.length && PDF_OUT.charAt(0) !== "_") {
        try {
            var preset = null;
            for (var pri = 0; pri < app.pdfExportPresets.length; pri++) {
                var nm = String(app.pdfExportPresets[pri].name).toLowerCase();
                if (nm.indexOf("cmyk web") >= 0 || nm.indexOf("high quality") >= 0) { preset = app.pdfExportPresets[pri]; break; }
            }
            doc.exportFile(ExportFormat.PDF_TYPE, File(PDF_OUT), false, preset || undefined);
            L("re-exported PDF");
        } catch (e) { L("export err: " + e); }
    }

    try { doc.close(SaveOptions.NO); } catch (e) {}
    flushLog();
})();
