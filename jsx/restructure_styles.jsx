// Create new paragraph styles based on a clustering proposal, then apply
// each style to the unstyled paragraphs that match its formatting fingerprint.
//
// Inputs (substituted by orchestrate.py at render time):
//   __INDD_PATH__       the InDesign file to mutate in place
//   __PROPOSALS_PATH__  the JSON file written by apply_edits_v2.jsx during the
//                        QA scan, with the user's edits applied (renamed,
//                        deselected, etc.) on top.
//   __LOG_PATH__        log file
//   __PDF_OUT_PATH__    optional — re-export the PDF after applying. Empty = skip.
//
// Proposal JSON shape (matches what apply_edits_v2.jsx writes — we add an
// `apply` boolean per candidate that the renderer toggles):
//   {
//     "candidates": [
//        { "signature": "...|...", "proposed_name": "H1", "apply": true,
//          "font": "Boston Bold", "size": 24, "leading": 28,
//          "fontStyle": "Bold", "justification": "LEFT_ALIGN",
//          "color": "[Black]" }, ...
//     ]
//   }
//
// What we do:
//   1. Open doc
//   2. For each candidate where apply=true:
//        a. Create a paragraph style with proposed_name (skip if name collides)
//        b. Walk every paragraph in every story; for each unstyled paragraph
//           whose fingerprint matches, apply the new style.
//   3. Save + (optionally) re-export PDF.
//
// We never touch paragraphs that already have a non-default applied style —
// that's the safety contract the user agreed to.
#target indesign

(function () {
    var INDD       = "__INDD_PATH__";
    var PROPS      = "__PROPOSALS_PATH__";
    var LOG_PATH   = "__LOG_PATH__";
    var PDF_OUT    = "__PDF_OUT_PATH__";

    var lines = [];
    function L(s) { lines.push(String(s)); }
    function flushLog() {
        try { var lf = File(LOG_PATH); lf.encoding="UTF-8"; lf.open("a"); lf.write(lines.join("\n") + "\n"); lf.close(); lines = []; } catch (e) {}
    }

    L("\n--- RESTRUCTURE STYLES ---");
    L("indd:  " + INDD);
    L("props: " + PROPS);

    var doc;
    try { doc = app.open(File(INDD)); } catch (e) { L("FATAL open: " + e); flushLog(); return; }

    // Read proposal JSON
    var pf = File(PROPS); pf.encoding = "UTF-8"; pf.open("r");
    var pj = pf.read(); pf.close();
    var proposal = eval("(" + pj + ")");
    L("candidates: " + (proposal.candidates ? proposal.candidates.length : 0));

    function isUnstyledStyleName(n) {
        if (!n) return true;
        if (n === "[None]" || n === "[Basic Paragraph]") return true;
        return false;
    }
    function paraFontName(p) {
        try { var f = p.appliedFont; return (f && f.fullName) ? String(f.fullName).split("\t")[0] : String(f || ""); }
        catch (e) { return ""; }
    }
    function paraColor(p) {
        try { return String(p.fillColor && p.fillColor.name ? p.fillColor.name : "Black"); }
        catch (e) { return "Black"; }
    }
    function paraJust(p) { try { return String(p.justification); } catch (e) { return ""; } }
    function paraStyleName(p) {
        try { var ps = p.appliedParagraphStyle; return ps ? String(ps.name) : "[None]"; }
        catch (e) { return "[None]"; }
    }
    function round1(n) { return Math.round((Number(n) || 0) * 10) / 10; }
    function fingerprint(p) {
        var sz, ld, fs;
        try { sz = round1(p.pointSize); } catch (e) { sz = 0; }
        try { ld = (typeof p.leading === "number") ? round1(p.leading) : "auto"; } catch (e) { ld = "auto"; }
        try { fs = String(p.fontStyle || "Regular"); } catch (e) { fs = "Regular"; }
        return [paraFontName(p), sz, ld, fs, paraJust(p), paraColor(p)].join("|");
    }

    function findUniqueName(baseName) {
        // If a paragraph style already exists with this name, append " 2", " 3", …
        var n = baseName;
        var i = 2;
        while (true) {
            var exists = false;
            try {
                for (var pi = 0; pi < doc.paragraphStyles.length; pi++) {
                    if (String(doc.paragraphStyles[pi].name) === n) { exists = true; break; }
                }
            } catch (e) {}
            if (!exists) return n;
            n = baseName + " " + i;
            i++;
        }
    }

    function findFontByName(fullName) {
        if (!fullName) return null;
        for (var fi = 0; fi < app.fonts.length; fi++) {
            try {
                var fnm = String(app.fonts[fi].fullName).split("\t")[0];
                if (fnm === fullName) return app.fonts[fi];
            } catch (e) {}
        }
        return null;
    }
    function findColorByName(name) {
        try {
            var sw = doc.swatches.itemByName(name);
            if (sw && sw.isValid) return sw;
        } catch (e) {}
        return null;
    }

    // Build a sig→candidate map for fast lookup
    var sigMap = {};
    for (var ci = 0; ci < proposal.candidates.length; ci++) {
        var c = proposal.candidates[ci];
        if (c.apply === false) { L("skip (deselected): " + c.proposed_name); continue; }
        sigMap[c.signature] = c;
    }

    // Create styles up-front
    var createdStyles = {}; // signature → ParagraphStyle
    for (var sig in sigMap) {
        if (!sigMap.hasOwnProperty(sig)) continue;
        var cand = sigMap[sig];
        var name = findUniqueName(cand.proposed_name);
        var ps;
        try { ps = doc.paragraphStyles.add({ name: name }); }
        catch (e) { L("create err " + name + ": " + e); continue; }

        // Apply formatting to the new style
        try {
            var fontObj = findFontByName(cand.font);
            if (fontObj) ps.appliedFont = fontObj;
        } catch (e) {}
        try { if (cand.fontStyle) ps.fontStyle = cand.fontStyle; } catch (e) {}
        try { if (cand.size) ps.pointSize = cand.size; } catch (e) {}
        try { if (cand.leading !== "auto" && cand.leading != null) ps.leading = cand.leading; } catch (e) {}
        try { if (cand.justification) ps.justification = Justification[cand.justification]; } catch (e) {}
        try {
            var col = findColorByName(cand.color);
            if (col) ps.fillColor = col;
        } catch (e) {}

        createdStyles[sig] = ps;
        L("created '" + name + "' (" + cand.font + " " + cand.size + "pt " + cand.fontStyle + ")");
    }

    // Apply: walk all paragraphs, for each unstyled one whose fingerprint
    // matches a created style, apply that style.
    var applied = 0;
    for (var s = 0; s < doc.stories.length; s++) {
        var story;
        try { story = doc.stories[s]; } catch (e) { continue; }
        for (var p = 0; p < story.paragraphs.length; p++) {
            var para;
            try { para = story.paragraphs[p]; } catch (e) { continue; }
            var t;
            try { t = String(para.contents || ""); } catch (e) { continue; }
            if (t.replace(/^\s+|\s+$/g, "").length === 0) continue;
            // Safety contract: only re-style paragraphs that are currently unstyled
            if (!isUnstyledStyleName(paraStyleName(para))) continue;
            var sig = fingerprint(para);
            var ps = createdStyles[sig];
            if (!ps) continue;
            try { para.appliedParagraphStyle = ps; applied++; } catch (e) { L("apply err: " + e); }
        }
    }

    L("applied to " + applied + " paragraph(s)");

    // Save
    try { doc.save(File(INDD)); L("saved"); } catch (e) { L("save err: " + e); }

    // Optional re-export
    if (PDF_OUT && PDF_OUT.length && PDF_OUT.charAt(0) !== "_") {
        try {
            var preset = null;
            for (var pi = 0; pi < app.pdfExportPresets.length; pi++) {
                var nm = String(app.pdfExportPresets[pi].name).toLowerCase();
                if (nm.indexOf("cmyk web") >= 0 || nm.indexOf("high quality") >= 0) { preset = app.pdfExportPresets[pi]; break; }
            }
            doc.exportFile(ExportFormat.PDF_TYPE, File(PDF_OUT), false, preset || undefined);
            L("re-exported PDF");
        } catch (e) { L("export err: " + e); }
    }

    try { doc.close(SaveOptions.NO); } catch (e) {}
    flushLog();
})();
