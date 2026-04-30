// Auto-tag an InDesign template with <<placeholder>> tokens for Data Merge.
//
// Inputs (substituted by orchestrate.py at render time):
//   __TEMPLATE_INDD__   path to the untagged template (.indd) to tag in-place
//   __PAIRS_JSON__      JSON-encoded list of pair objects (see below)
//   __LIST_TOKENS_JSON__  JSON-encoded list of placeholder names whose
//                         template content is a long bullet list to clear
//                         (e.g., ["top20","grant_prog"]). For each token,
//                         the JSX scans for a frame whose story starts with
//                         <<token>> and any leftover hardcoded list lines —
//                         it resets the story to just the placeholder so
//                         merge-time can flow the new list cleanly.
//   __OUTPUT_INDD__     where to save the tagged copy (or empty = save in place)
//   __REPORT_PATH__     path to a text report of what was tagged
//   __LOG_PATH__        path to a JSX log
//
// Pair object shape:
//   {
//     "kind":  "literal" | "grep" | "frame_equals" | "labeled" | "footer" | "state_word",
//     "find":  "literal text" | "regex" | "exact frame contents",
//     "replace": "<<placeholder>>" | "label: <<placeholder>>",
//     "name":  "human-readable name for the report"
//   }
//
// Pair kinds:
//   literal       — direct find/change of the literal text
//   grep          — regex find/change (use ^ / $ for paragraph anchors)
//   frame_equals  — match any text frame whose entire trimmed contents == find;
//                   replace the whole frame contents with `replace`
//   labeled       — same as literal but only matches when preceded by a
//                   colon-space (e.g., "Cell Therapy: 31") — implementation
//                   identical to literal, kept distinct for the report
//   footer        — same as literal; report-only distinction
//   state_word    — the reference state name standing alone (e.g., "California")
//                   used as a frame_equals
#target indesign

(function () {
    var TEMPLATE   = "__TEMPLATE_INDD__";
    var OUTPUT     = "__OUTPUT_INDD__";
    var REPORT     = "__REPORT_PATH__";
    var LOG_PATH   = "__LOG_PATH__";

    var logBuf = [];
    function L(s) { logBuf.push(String(s)); }
    function flush() {
        try {
            var lf = File(LOG_PATH); lf.encoding = "UTF-8"; lf.open("a");
            lf.write(logBuf.join("\n") + "\n"); lf.close();
        } catch (e) {}
        logBuf = [];
    }

    // Read PAIRS and LIST_TOKENS from sidecar files written by orchestrate.py
    // (embedding large JSON inside the JSX source breaks on quote escaping).
    var pairs;
    var listTokens;
    try {
        var pjFile = File("__PAIRS_JSON_PATH__");
        pjFile.encoding = "UTF-8"; pjFile.open("r");
        pairs = eval("(" + pjFile.read() + ")");
        pjFile.close();
        var ltFile = File("__LIST_TOKENS_JSON_PATH__");
        ltFile.encoding = "UTF-8"; ltFile.open("r");
        listTokens = eval("(" + ltFile.read() + ")");
        ltFile.close();
    } catch (e) {
        L("FATAL: could not read pairs/list-tokens json: " + e);
        flush();
        return;
    }

    L("\n--- TAG TEMPLATE STEP ---");
    L("template:   " + TEMPLATE);
    L("output:     " + OUTPUT);
    L("pairs:      " + pairs.length);
    L("list_tokens: " + listTokens.join(", "));

    app.scriptPreferences.userInteractionLevel = UserInteractionLevels.NEVER_INTERACT;
    app.scriptPreferences.enableRedraw = false;

    var doc;
    try { doc = app.open(File(TEMPLATE)); }
    catch (e) { L("FATAL: cannot open template: " + e); flush(); return; }

    app.findChangeTextOptions.includeFootnotes = true;
    app.findChangeTextOptions.includeHiddenLayers = true;
    app.findChangeTextOptions.includeMasterPages = true;
    app.findChangeGrepOptions.includeFootnotes = true;
    app.findChangeGrepOptions.includeHiddenLayers = true;
    app.findChangeGrepOptions.includeMasterPages = true;

    var report = [];   // {name, kind, hits}
    var totalHits = 0;
    var unmatched = [];

    function applyLiteral(p) {
        app.findTextPreferences = NothingEnum.NOTHING;
        app.changeTextPreferences = NothingEnum.NOTHING;
        app.findTextPreferences.findWhat = p.find;
        app.changeTextPreferences.changeTo = p.replace;
        var n = 0;
        try { n = doc.changeText().length; } catch (e) { L("err literal " + p.name + ": " + e); }
        return n;
    }
    function applyGrep(p) {
        app.findGrepPreferences = NothingEnum.NOTHING;
        app.changeGrepPreferences = NothingEnum.NOTHING;
        app.findGrepPreferences.findWhat = p.find;
        app.changeGrepPreferences.changeTo = p.replace;
        var n = 0;
        try { n = doc.changeGrep().length; } catch (e) { L("err grep " + p.name + ": " + e); }
        return n;
    }
    function applyFrameEquals(p) {
        var frames = doc.textFrames.everyItem().getElements();
        var n = 0;
        for (var i = 0; i < frames.length; i++) {
            try {
                var c = String(frames[i].contents || "");
                var trimmed = c.replace(/^\s+|\s+$/g, "");
                if (trimmed === p.find) {
                    frames[i].contents = p.replace;
                    n++;
                }
            } catch (e) {}
        }
        return n;
    }
    function applyLiteralVariants(p) {
        // Try each variant in priority order — sum hits across all that match.
        // First variant that matches > 0 short-circuits remaining since the
        // doc state has changed.
        var n = 0;
        for (var v = 0; v < p.variants.length; v++) {
            app.findTextPreferences = NothingEnum.NOTHING;
            app.changeTextPreferences = NothingEnum.NOTHING;
            app.findTextPreferences.findWhat = p.variants[v];
            app.changeTextPreferences.changeTo = p.replace;
            var hit = 0;
            try { hit = doc.changeText().length; } catch (e) {}
            n += hit;
            if (hit > 0) break;  // doc state changed; first-match wins
        }
        return n;
    }
    function applyListBlock(p) {
        // Find any text frame whose parent story starts with the anchor (the
        // first entry of the reference state's list, e.g. "Anaheim Clinical
        // Trials LLC"), then collapse the entire story to just the placeholder.
        // Threaded frames share a story, so one assignment clears them all.
        var frames = doc.textFrames.everyItem().getElements();
        var processedStories = {};
        var n = 0;
        for (var i = 0; i < frames.length; i++) {
            try {
                var story = frames[i].parentStory;
                var sid = story.id;
                if (processedStories[sid]) continue;
                var c = String(story.contents || "").replace(/^\s+/, "");
                if (c.indexOf(p.anchor) === 0) {
                    story.contents = p.replace;
                    processedStories[sid] = true;
                    n++;
                }
            } catch (e) {}
        }
        return n;
    }
    function applyNearLabel(p) {
        // Find any text frame whose contents start with a number followed by
        // a paragraph/line break and the label, then replace that number with
        // the placeholder doc-wide (since the same number may repeat across
        // pages but only the workforce-context one started this match).
        var frames = doc.textFrames.everyItem().getElements();
        var labelEsc = p.label.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
        var re = new RegExp("^([\\$\\d,\\.]+)\\s*[\\r\\n]+\\s*" + labelEsc, "i");
        var matchedNumbers = {};
        for (var i = 0; i < frames.length; i++) {
            try {
                var c = String(frames[i].contents || "");
                var m = c.match(re);
                if (m) matchedNumbers[m[1]] = true;
            } catch (e) {}
        }
        var n = 0;
        for (var num in matchedNumbers) {
            if (!matchedNumbers.hasOwnProperty(num)) continue;
            app.findTextPreferences = NothingEnum.NOTHING;
            app.changeTextPreferences = NothingEnum.NOTHING;
            app.findTextPreferences.findWhat = num;
            app.changeTextPreferences.changeTo = p.replace;
            try { n += doc.changeText().length; } catch (e) {}
        }
        return n;
    }

    for (var pi = 0; pi < pairs.length; pi++) {
        var p = pairs[pi];
        var hits = 0;
        if (p.kind === "grep") hits = applyGrep(p);
        else if (p.kind === "frame_equals" || p.kind === "state_word") hits = applyFrameEquals(p);
        else if (p.kind === "literal_variants") hits = applyLiteralVariants(p);
        else if (p.kind === "near_label") hits = applyNearLabel(p);
        else if (p.kind === "list_block") hits = applyListBlock(p);
        else hits = applyLiteral(p);
        report.push({ name: p.name, kind: p.kind, hits: hits, find: p.find, replace: p.replace });
        totalHits += hits;
        if (hits === 0) unmatched.push(p);
        L("[" + p.kind + "] " + p.name + ": " + hits + " hit(s)");
    }
    app.findTextPreferences = NothingEnum.NOTHING;
    app.changeTextPreferences = NothingEnum.NOTHING;
    app.findGrepPreferences = NothingEnum.NOTHING;
    app.changeGrepPreferences = NothingEnum.NOTHING;

    // List-block clearing: for each list token, find any story whose contents
    // start with the placeholder and reset the story to just the placeholder.
    // This wipes the leftover hardcoded California list so merge-time can flow
    // each state's actual list into the threaded frames.
    var listsCleared = 0;
    for (var lt = 0; lt < listTokens.length; lt++) {
        var token = "<<" + listTokens[lt] + ">>";
        var allFrames = doc.textFrames.everyItem().getElements();
        var processedStories = {};
        for (var i = 0; i < allFrames.length; i++) {
            try {
                var story = allFrames[i].parentStory;
                var sid = story.id;
                if (processedStories[sid]) continue;
                var c = String(story.contents || "");
                if (c.indexOf(token) === 0 && c.length > token.length) {
                    story.contents = token;
                    processedStories[sid] = true;
                    listsCleared++;
                    L("list-block cleared: " + token + " (story " + sid + ")");
                }
            } catch (e) {}
        }
    }

    // Save out
    try {
        if (OUTPUT && OUTPUT.length && OUTPUT !== TEMPLATE) {
            doc.save(File(OUTPUT));
            L("saved as " + OUTPUT);
        } else {
            doc.save();
            L("saved in place");
        }
        doc.close(SaveOptions.NO);
    } catch (e) {
        L("save error: " + e);
    }

    // Write the report
    try {
        var rf = File(REPORT); rf.encoding = "UTF-8"; rf.open("w");
        rf.writeln("# Auto-Tag Report");
        rf.writeln("");
        rf.writeln("Template: " + TEMPLATE);
        rf.writeln("Total tag hits: " + totalHits);
        rf.writeln("List blocks cleared: " + listsCleared);
        rf.writeln("");
        rf.writeln("## Successful tags");
        for (var r = 0; r < report.length; r++) {
            if (report[r].hits > 0) {
                rf.writeln("- [" + report[r].kind + "] " + report[r].name +
                           " — " + report[r].hits + " hit(s) → " + report[r].replace);
            }
        }
        rf.writeln("");
        rf.writeln("## Unmatched (please add manually)");
        if (unmatched.length === 0) {
            rf.writeln("(none — all values were tagged)");
        } else {
            for (var u = 0; u < unmatched.length; u++) {
                rf.writeln("- [" + unmatched[u].kind + "] " + unmatched[u].name +
                           " — looking for: " + unmatched[u].find +
                           "  → wanted: " + unmatched[u].replace);
            }
        }
        rf.close();
    } catch (e) {
        L("report write error: " + e);
    }

    L("DONE — total_hits=" + totalHits + " lists_cleared=" + listsCleared +
      " unmatched=" + unmatched.length);
    flush();

    app.scriptPreferences.userInteractionLevel = UserInteractionLevels.INTERACT_WITH_ALL;
    app.scriptPreferences.enableRedraw = true;
})();
