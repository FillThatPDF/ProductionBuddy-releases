// Apply 6 edits from marked-up PDF to a copy of the rater directory.
// v2: snapshot existing rows + new records into a single array, sort, then write all rows in one pass.
#target indesign

(function () {
    var __outerLogPath = "/Users/36981/Desktop/Prdouction AI/Test/apply_log.txt";
    try {
    var lines = [];
    var inddPath = "/Users/36981/Desktop/Prdouction AI/Test/58168_CE_DTE_NHC_HERS_Rater_Directory_v04_AI_EDITED.indd";
    var pdfOut   = "/Users/36981/Desktop/Prdouction AI/Test/58168_CE_DTE_NHC_HERS_Rater_Directory_v04_AI_EDITED.pdf";
    var logPath  = "/Users/36981/Desktop/Prdouction AI/Test/apply_log.txt";
    var flagsPath= "/Users/36981/Desktop/Prdouction AI/Test/flags_for_review.txt";

    function flushLog() {
        try {
            var lf = File(logPath); lf.encoding="UTF-8"; lf.open("w"); lf.write(lines.join("\n")); lf.close();
        } catch (e) {}
    }
    function L(s) { lines.push(String(s)); $.writeln(s); flushLog(); }

    var flags = [];
    function FLAG(s) { flags.push(s); L("[FLAG] " + s); }

    L("STEP 0: starting");
    app.scriptPreferences.userInteractionLevel = UserInteractionLevels.NEVER_INTERACT;
    app.scriptPreferences.enableRedraw = false;
    L("STEP 0.5: about to open " + inddPath);
    var doc;
    try {
        doc = app.open(File(inddPath), false);
        L("STEP 1: opened doc: " + doc.name);
    } catch (e) {
        L("FATAL on open: " + e + " (line " + e.line + ")");
        return;
    }
    var __fatalGuard = function () {};
    try { __fatalGuard = (function(){ return function(label, fn) { try { return fn(); } catch (ee) { L("ERROR at " + label + ": " + ee + " (line " + ee.line + ")"); throw ee; } }; })(); } catch (e) {}

    // ---------- Locate rater table ----------
    var tbl = null;
    for (var p = 0; p < doc.pages.length && !tbl; p++) {
        var page = doc.pages[p];
        for (var f = 0; f < page.textFrames.length && !tbl; f++) {
            var tf = page.textFrames[f];
            for (var t = 0; t < tf.tables.length; t++) {
                var cand = tf.tables[t];
                if (cand.columns.length === 6 && cand.rows.length >= 20) { tbl = cand; break; }
            }
        }
    }
    if (!tbl) { L("ERROR: rater table not found"); doc.close(SaveOptions.NO); return; }

    var headerRows = tbl.headerRowCount;
    var totalCols  = tbl.columns.length;
    var checkCol   = totalCols - 1;
    var checkChar  = String.fromCharCode(61692); // Wingdings 0xF0FC
    L("Rater table: rows=" + tbl.rows.length + " cols=" + totalCols + " header=" + headerRows);

    // ---------- Snapshot existing body rows ----------
    function snapshotCell(cell) {
        var charsData = [];
        try {
            for (var ci = 0; ci < cell.characters.length; ci++) {
                var ch = cell.characters[ci];
                var rec = {
                    contents:  ch.contents,
                    font:      ch.appliedFont,
                    pointSize: ch.pointSize,
                    charStyle: ch.appliedCharacterStyle
                };
                try { rec.position  = ch.position; }   catch (e) {}
                try { rec.fillColor = ch.fillColor; }  catch (e) {}
                try { rec.fillTint  = ch.fillTint; }   catch (e) {}
                charsData.push(rec);
            }
        } catch (e) {}
        var paraStyle = null, cellStyle = null, contents = "";
        try { paraStyle = cell.paragraphs[0].appliedParagraphStyle; } catch (e) {}
        try { cellStyle = cell.appliedCellStyle; } catch (e) {}
        try { contents = cell.contents; } catch (e) {}
        return { paraStyle: paraStyle, cellStyle: cellStyle, contents: contents, chars: charsData };
    }

    var records = [];
    for (var r = headerRows; r < tbl.rows.length; r++) {
        var row = tbl.rows[r];
        var rec = { cells: [] };
        for (var c = 0; c < totalCols; c++) rec.cells.push(snapshotCell(row.cells[c]));
        records.push(rec);
    }
    L("STEP 3: snapshotted " + records.length + " existing body rows");

    // ---------- Discover formatting templates ----------
    // Find a row that already has a check mark and snapshot it for the check column template
    var checkCellTemplate = null;
    for (var r = 0; r < records.length; r++) {
        if (records[r].cells[checkCol].contents && records[r].cells[checkCol].contents.length > 0) {
            checkCellTemplate = records[r].cells[checkCol];
            L("Check-mark template from existing record " + r + " (font=" +
              (checkCellTemplate.chars[0] && checkCellTemplate.chars[0].font && checkCellTemplate.chars[0].font.fullName) + ")");
            break;
        }
    }
    if (!checkCellTemplate) FLAG("No existing check-mark cell to copy formatting from");

    // Per-column body templates from row 0 of records
    var colTemplates = [];
    for (var c = 0; c < totalCols; c++) colTemplates.push(records[0].cells[c]);

    // ---------- EDIT 5 & 6: add check marks to specified rows ----------
    function findRecordByCompanyPrefix(prefix) {
        for (var i = 0; i < records.length; i++) {
            var s = records[i].cells[0].contents;
            if (typeof s === "string" && s.indexOf(prefix) === 0) return i;
        }
        return -1;
    }
    function setCheckMark(prefix) {
        var i = findRecordByCompanyPrefix(prefix);
        if (i < 0) { FLAG("Could not find row for: " + prefix); return; }
        if (records[i].cells[checkCol].contents && records[i].cells[checkCol].contents.length > 0) {
            L("EDIT-CHK: '" + prefix + "' already has a mark; skipping");
            return;
        }
        // Build a check cell from the template
        var src = checkCellTemplate;
        var newCell = {
            paraStyle: src ? src.paraStyle : null,
            cellStyle: src ? src.cellStyle : null,
            contents:  checkChar,
            chars: [{
                contents:  checkChar,
                font:      src && src.chars[0] ? src.chars[0].font : null,
                pointSize: src && src.chars[0] ? src.chars[0].pointSize : null,
                charStyle: src && src.chars[0] ? src.chars[0].charStyle : null
            }]
        };
        records[i].cells[checkCol] = newCell;
        L("EDIT-CHK: marked '" + prefix + "' (record index " + i + ")");
    }
    L("STEP 4: applying check marks");
    setCheckMark("Energy Auditors, LLC");
    setCheckMark("The Home Inspector General");

    // ---------- EDIT 1, 2, 3: add 3 new raters ----------
    var emailCharStyle = null;
    try {
        var es = doc.characterStyles.itemByName("Email_link");
        if (es && es.isValid) emailCharStyle = es;
    } catch (e) {}

    // Helpers: pull the dominant font/size from a template cell
    function templateFont(tmpl) {
        if (tmpl && tmpl.chars && tmpl.chars.length > 0) return tmpl.chars[0].font || null;
        return null;
    }
    function templatePointSize(tmpl) {
        if (tmpl && tmpl.chars && tmpl.chars.length > 0) return tmpl.chars[0].pointSize || null;
        return null;
    }
    function makePlainCell(c, text) {
        var tmpl = colTemplates[c];
        var ch = {
            contents:  text,
            font:      templateFont(tmpl),
            pointSize: templatePointSize(tmpl),
            charStyle: null
        };
        return {
            paraStyle: tmpl ? tmpl.paraStyle : null,
            cellStyle: tmpl ? tmpl.cellStyle : null,
            contents:  text,
            chars:     [ch],
            hyphenation: false
        };
    }
    // Sample blue fill color from a known existing email cell, so new email
    // cells match (the original applies blue via per-character fillColor, not
    // consistently via Email_link char style).
    var emailBlueFill = null, emailBlueTint = 100;
    try {
        var t3 = colTemplates[3];
        if (t3 && t3.chars && t3.chars.length > 0) {
            for (var ci = 0; ci < t3.chars.length; ci++) {
                if (t3.chars[ci].fillColor) {
                    emailBlueFill = t3.chars[ci].fillColor;
                    if (t3.chars[ci].fillTint != null) emailBlueTint = t3.chars[ci].fillTint;
                    break;
                }
            }
        }
    } catch (e) {}
    L("Email blue fill detected: " + (emailBlueFill ? emailBlueFill.name : "(none)"));

    function makeEmailCell(text) {
        var tmpl = colTemplates[3];
        return {
            paraStyle: tmpl ? tmpl.paraStyle : null,
            cellStyle: tmpl ? tmpl.cellStyle : null,
            contents:  text,
            chars: [{
                contents:  text,
                font:      templateFont(tmpl),
                pointSize: templatePointSize(tmpl),
                charStyle: emailCharStyle,
                fillColor: emailBlueFill,
                fillTint:  emailBlueTint
            }],
            hyphenation: false
        };
    }
    function makeCheckCell(checked) {
        if (!checked) return makePlainCell(checkCol, "");
        var src = checkCellTemplate;
        return {
            paraStyle: src ? src.paraStyle : null,
            cellStyle: src ? src.cellStyle : null,
            contents:  checkChar,
            chars: [{
                contents:  checkChar,
                font:      src && src.chars[0] ? src.chars[0].font : null,
                pointSize: src && src.chars[0] ? src.chars[0].pointSize : null,
                charStyle: src && src.chars[0] ? src.chars[0].charStyle : null
            }]
        };
    }

    var newRaters = [
        { company:"Energy Savers of Michigan",  rater:"Rick Myers",     phone:"586-604-4460", email:"energysaversofmi@gmail.com", territory:"Southeastern", checked:true },
        { company:"FiberClass Insulation",      rater:"Steven Hippler", phone:"248-847-5459", email:"steven.hippler@installed.net", territory:"Southeastern", checked:true },
        { company:"JDC Energy Inspector, LLC",  rater:"James Chase",    phone:"616-264-9357", email:"jimmychase83@gmail.com",     territory:"Western",      checked:true }
    ];
    L("STEP 5: appending " + newRaters.length + " new raters");
    for (var i = 0; i < newRaters.length; i++) {
        var nr = newRaters[i];
        records.push({
            cells: [
                makePlainCell(0, nr.company),
                makePlainCell(1, nr.rater),
                makePlainCell(2, nr.phone),
                makeEmailCell(nr.email),
                makePlainCell(4, nr.territory),
                makeCheckCell(nr.checked)
            ]
        });
        L("EDIT-ADD: queued '" + nr.company + "'");
    }

    FLAG("Edit #1 contained a note for human review: \"Rick Myers also works for Eco Achievers — there will be some duplication.\" Not auto-acted on. Please decide if Eco Achievers row should be removed/merged.");

    // ---------- EDIT 4: sort all records alphabetically by company ----------
    function sortKey(rec) {
        var s = (rec.cells[0].contents || "").toLowerCase();
        return s.replace(/^\s+/, "").replace(/\s+/g, " ");
    }
    L("STEP 6: sorting records");
    records.sort(function(a, b) { var ka = sortKey(a), kb = sortKey(b); return ka < kb ? -1 : (ka > kb ? 1 : 0); });
    L("Sorted order:");
    for (var i = 0; i < records.length; i++) L("  " + (i+1) + ". " + records[i].cells[0].contents.replace(/[\r\n]+/g, " "));

    // ---------- Resize table body to match record count ----------
    L("STEP 7: resizing table");
    var targetBodyCount = records.length; // 25
    var currentBodyCount = tbl.rows.length - headerRows;
    if (targetBodyCount > currentBodyCount) {
        for (var i = 0; i < targetBodyCount - currentBodyCount; i++) tbl.rows.add(LocationOptions.AT_END);
    } else if (targetBodyCount < currentBodyCount) {
        for (var i = 0; i < currentBodyCount - targetBodyCount; i++) tbl.rows[-1].remove();
    }
    L("Adjusted table to " + tbl.rows.length + " rows (1 header + " + (tbl.rows.length-1) + " body)");

    // ---------- Write all records back ----------
    function writeCell(cellObj, recCell) {
        try { if (recCell.cellStyle) cellObj.appliedCellStyle = recCell.cellStyle; } catch (e) {}
        try { if (recCell.paraStyle) cellObj.paragraphs[0].appliedParagraphStyle = recCell.paraStyle; } catch (e) {}
        cellObj.contents = recCell.contents || "";
        // If this is a new/cleaned record (chars present), apply font + size to the entire cell text run
        try {
            if (recCell.chars && recCell.chars.length > 0 && cellObj.characters.length > 0) {
                var s = recCell.chars[0];
                if (s.font || s.pointSize || s.charStyle || s.fillColor || s.position !== undefined) {
                    var run = cellObj.texts[0];
                    try { if (s.font) run.appliedFont = s.font; } catch (e) {}
                    try { if (s.pointSize) run.pointSize = s.pointSize; } catch (e) {}
                    try { if (s.charStyle) run.appliedCharacterStyle = s.charStyle; } catch (e) {}
                    try { if (s.fillColor) run.fillColor = s.fillColor; } catch (e) {}
                    try { if (s.fillTint != null) run.fillTint = s.fillTint; } catch (e) {}
                    try { if (s.position != null) run.position = s.position; } catch (e) {}
                }
                // For original rows we snapshotted, also reapply per-char to preserve char-level
                // overrides (font, size, charStyle, position/superscript, fillColor/text-color).
                if (recCell.chars.length > 1) {
                    for (var ci = 0; ci < recCell.chars.length && ci < cellObj.characters.length; ci++) {
                        var d = cellObj.characters[ci];
                        var sc = recCell.chars[ci];
                        try { if (sc.font)      d.appliedFont = sc.font; } catch (e) {}
                        try { if (sc.pointSize) d.pointSize  = sc.pointSize; } catch (e) {}
                        try { if (sc.charStyle) d.appliedCharacterStyle = sc.charStyle; } catch (e) {}
                        try { if (sc.position !== undefined && sc.position !== null) d.position = sc.position; } catch (e) {}
                        try { if (sc.fillColor) d.fillColor = sc.fillColor; } catch (e) {}
                        try { if (sc.fillTint !== undefined && sc.fillTint !== null) d.fillTint = sc.fillTint; } catch (e) {}
                    }
                }
            }
        } catch (e) {}
        // Force hyphenation off where requested
        try {
            if (recCell.hyphenation === false) {
                for (var pi = 0; pi < cellObj.paragraphs.length; pi++) {
                    cellObj.paragraphs[pi].hyphenation = false;
                }
            }
        } catch (e) {}
    }
    L("STEP 8: writing " + records.length + " records back");
    for (var r = 0; r < records.length; r++) {
        var row = tbl.rows[headerRows + r];
        var rec = records[r];
        for (var c = 0; c < totalCols; c++) writeCell(row.cells[c], rec.cells[c]);
        if (r % 5 === 0) L("  wrote row " + r);
    }
    L("STEP 8 done: wrote " + records.length + " records");

    // ---------- STEP 8.5: post-write QA fixes ----------
    L("STEP 8.5: QA fixes (hyphenation, alternating fill, email styling)");

    // 8.5a: Disable hyphenation on ALL body cells. Words too long for a column
    // should wrap to next line as a unit, not break with a hyphen.
    var hyphCount = 0;
    for (var r = headerRows; r < tbl.rows.length; r++) {
        for (var c = 0; c < tbl.columns.length; c++) {
            try {
                var cell = tbl.rows[r].cells[c];
                var paras = cell.paragraphs;
                for (var pi = 0; pi < paras.length; pi++) {
                    paras[pi].hyphenation = false;
                    hyphCount++;
                }
            } catch (e) {}
        }
    }
    L("  8.5a: hyphenation disabled on " + hyphCount + " paragraphs");

    // 8.5b: Re-apply Email_link character style to entire email column.
    var emailColCount = 0;
    try {
        var emailCharStyleX = doc.characterStyles.itemByName("Email_link");
        if (emailCharStyleX && emailCharStyleX.isValid) {
            for (var r = headerRows; r < tbl.rows.length; r++) {
                try {
                    var emailCell = tbl.rows[r].cells[3];
                    if (emailCell.contents && emailCell.contents.length > 0) {
                        emailCell.texts[0].appliedCharacterStyle = emailCharStyleX;
                        emailColCount++;
                    }
                } catch (e) {}
            }
        }
    } catch (e) { L("  8.5b email char style err: " + e); }
    L("  8.5b: re-applied Email_link char style to " + emailColCount + " email cells");

    // 8.5c: Set up alternating-row fill correctly via the TABLE'S OWN STYLE.
    //
    // InDesign tables internally implement alternating fills as per-cell stamps
    // applied at config time. After config, modifying alternating spec does NOT
    // auto-refresh existing cells. Sorting/inserting rows can also leave new
    // rows un-stamped. So the canonical fix is:
    //   (1) Configure the table-level alternating-fill spec (the "style").
    //   (2) Apply the col-0 cellStyle uniformly so col 0 stays uniform blue.
    //   (3) Re-stamp each non-col-0 body cell with fill drawn FROM THE TABLE'S
    //       OWN spec (not hardcoded values). Single source of truth = the
    //       table's alternating-fill config.
    try {
        var graySwatch  = doc.swatches.itemByName("C=0 M=0 Y=0 K=10");
        var paperSwatch = doc.swatches.itemByName("Paper");
        var col0Style   = doc.cellStyles.itemByName("Column 1 color bkg");

        // (1) Configure table-level alternating fills (the canonical style).
        try {
            tbl.alternatingFills  = AlternatingFillsTypes.ALTERNATING_ROWS;
            tbl.startRowFillColor = graySwatch;
            tbl.startRowFillCount = 1;
            tbl.startRowFillTint  = 100;
            tbl.endRowFillColor   = paperSwatch;
            tbl.endRowFillCount   = 1;
            tbl.endRowFillTint    = 100;
            L("  8.5c (1): table alternating-rows configured: " + tbl.startRowFillColor.name +
              "(" + tbl.startRowFillCount + ") / " + tbl.endRowFillColor.name + "(" + tbl.endRowFillCount + ")");
        } catch (e) { L("  8.5c (1) alt-fill config err: " + e); }

        // (2) Apply the col-0 cellStyle uniformly + restore the white dividers
        // (Paper-colored cell strokes) that visually separate the blue cells.
        var col0Applied = 0, strokesSet = 0;
        if (col0Style && col0Style.isValid) {
            for (var r = headerRows; r < tbl.rows.length; r++) {
                try { tbl.rows[r].cells[0].appliedCellStyle = col0Style; col0Applied++; } catch (e) {}
                // Set white strokes (1pt, Paper) on all four edges of col-0 cells.
                var cellSides = ["top", "bottom", "left", "right"];
                for (var s = 0; s < cellSides.length; s++) {
                    try {
                        var cl0 = tbl.rows[r].cells[0];
                        cl0[cellSides[s] + "EdgeStrokeColor"]  = paperSwatch;
                        cl0[cellSides[s] + "EdgeStrokeWeight"] = 1;
                        cl0[cellSides[s] + "EdgeStrokeTint"]   = 100;
                        strokesSet++;
                    } catch (e) {}
                }
            }
            L("  8.5c (2): applied 'Column 1 color bkg' cellStyle to " + col0Applied + " col-0 cells; restored " + strokesSet + " strokes (Paper, 1pt)");
        } else {
            L("  8.5c (2): WARNING 'Column 1 color bkg' cellStyle not found");
        }

        // (3) Re-stamp body cells (cols 1-5) with the table's own alternating spec.
        var startFill = tbl.startRowFillColor, startCount = tbl.startRowFillCount, startTint = tbl.startRowFillTint;
        var endFill   = tbl.endRowFillColor,   endCount   = tbl.endRowFillCount,   endTint   = tbl.endRowFillTint;
        var cycleLen  = startCount + endCount;
        if (cycleLen <= 0) cycleLen = 2;
        var stampedCount = 0;
        for (var r = headerRows; r < tbl.rows.length; r++) {
            var bodyIdx = r - headerRows;
            var posInCycle = bodyIdx % cycleLen;
            var inStartZone = posInCycle < startCount;
            var fill = inStartZone ? startFill : endFill;
            var tint = inStartZone ? startTint : endTint;
            for (var c = 1; c < tbl.columns.length; c++) {
                try {
                    tbl.rows[r].cells[c].fillColor = fill;
                    tbl.rows[r].cells[c].fillTint  = tint;
                    stampedCount++;
                } catch (e) {}
            }
        }
        L("  8.5c (3): re-stamped " + stampedCount + " body cells (cols 1-5) using table's alt-fill spec");
    } catch (e) { L("  8.5c outer err: " + e); }

    // 8.5d: Detect any remaining mid-word breaks (a line ending with "-" mid-word)
    // and FLAG them — these survive even after disabling hyphenation if the column
    // is genuinely too narrow for the word.
    var hyphenatedFindings = [];
    for (var r = headerRows; r < tbl.rows.length; r++) {
        for (var c = 0; c < tbl.columns.length; c++) {
            try {
                var cell = tbl.rows[r].cells[c];
                var cellLines = cell.lines;
                for (var li = 0; li < cellLines.length - 1; li++) {
                    var lineText = String(cellLines[li].contents);
                    if (/-\s*$/.test(lineText)) {
                        hyphenatedFindings.push({ row: r, col: c, line: lineText.replace(/[\r\n]+/g, " ") });
                    }
                }
            } catch (e) {}
        }
    }
    if (hyphenatedFindings.length > 0) {
        var sample = [];
        for (var hi = 0; hi < Math.min(5, hyphenatedFindings.length); hi++) {
            sample.push("row " + hyphenatedFindings[hi].row + " col " + hyphenatedFindings[hi].col + ": \"…" + hyphenatedFindings[hi].line.slice(-30) + "\"");
        }
        FLAG("Found " + hyphenatedFindings.length + " line(s) ending with '-' mid-word (column may be too narrow for the word). Review: " + sample.join(" | "));
    } else {
        L("  8.5d: no mid-word hyphen breaks detected");
    }

    // 8.5e: Single-line preference for ATOMIC cells (no internal whitespace).
    // Emails, URLs, phone numbers, etc. should not wrap mid-token. Try gentle
    // tracking reduction to fit on one line; flag escalations to human.
    var trackingFloor = -50; // -50/1000 em is still readable; -100 starts to look cramped
    var trackingStep  = -5;
    var fitFixed = [], fitFailed = [];
    for (var r = headerRows; r < tbl.rows.length; r++) {
        for (var c = 0; c < tbl.columns.length; c++) {
            try {
                var cell = tbl.rows[r].cells[c];
                var contents = cell.contents;
                if (typeof contents !== "string" || contents.length === 0) continue;
                // Strip leading/trailing whitespace and paragraph marks
                var stripped = contents.replace(/[\r\n\s]+$/g, "").replace(/^[\r\n\s]+/g, "");
                // "Atomic" = no internal whitespace
                if (/\s/.test(stripped)) continue;
                if (cell.lines.length <= 1) continue;

                // Try tracking reduction
                var t0 = 0;
                try { t0 = cell.texts[0].tracking; } catch (e) {}
                var curT = t0;
                var attempts = 0;
                while (cell.lines.length > 1 && curT > trackingFloor && attempts < 20) {
                    curT += trackingStep;
                    try { cell.texts[0].tracking = curT; } catch (e) { break; }
                    attempts++;
                }
                if (cell.lines.length <= 1) {
                    fitFixed.push({ row: r, col: c, content: stripped.substring(0, 35), tracking: curT });
                } else {
                    // Restore to original tracking if we can't fix it
                    try { cell.texts[0].tracking = t0; } catch (e) {}
                    fitFailed.push({ row: r, col: c, content: stripped.substring(0, 35) });
                }
            } catch (e) {}
        }
    }
    if (fitFixed.length > 0) {
        var samples = [];
        for (var i = 0; i < Math.min(3, fitFixed.length); i++) samples.push("r" + fitFixed[i].row + "c" + fitFixed[i].col + " (\"" + fitFixed[i].content + "\" → tracking " + fitFixed[i].tracking + ")");
        L("  8.5e: fit " + fitFixed.length + " atomic cells to single line via tracking. Examples: " + samples.join("; "));
    }
    if (fitFailed.length > 0) {
        var samples2 = [];
        for (var i = 0; i < Math.min(5, fitFailed.length); i++) samples2.push("row " + fitFailed[i].row + " col " + fitFailed[i].col + ": \"" + fitFailed[i].content + "\"");
        FLAG("Atomic content still wraps after tracking floor (" + trackingFloor + "/1000em). Column may need to be widened: " + samples2.join(" | "));
    }
    if (fitFixed.length === 0 && fitFailed.length === 0) {
        L("  8.5e: no atomic-cell wrap issues found");
    }

    L("STEP 9: layout-aware fit pass");
    // ---------- Layout-aware fit pass ----------
    // Strategy: find collision-free safe zone, then shrink (insets → font) until fit.
    var parentTF = tbl.parent;
    while (parentTF && !(parentTF instanceof TextFrame)) {
        try { parentTF = parentTF.parent; } catch (e) { break; }
    }

    function isAncestorOf(maybeAncestor, item) {
        var p = item.parent;
        while (p) { if (p === maybeAncestor) return true; try { p = p.parent; } catch(e){ return false; } }
        return false;
    }

    function findSafeBottom(frame) {
        L("  findSafeBottom: entering");
        var page = frame.parentPage;
        var origBounds = frame.geometricBounds;
        var origBottom = origBounds[2], frameLeft = origBounds[1], frameRight = origBounds[3];
        L("  findSafeBottom: origBottom=" + origBottom + " left=" + frameLeft + " right=" + frameRight);
        var pageH = doc.documentPreferences.pageHeight;
        var marginBottom = page.marginPreferences.bottom;
        var pageMarginBottom = pageH - marginBottom;
        L("  findSafeBottom: pageH=" + pageH + " marginBottom=" + marginBottom);

        // Use everyItem() bulk fetch — fast and reliable
        var allBounds = [];
        try {
            allBounds = page.pageItems.everyItem().geometricBounds;
            L("  findSafeBottom: page.pageItems count=" + allBounds.length);
        } catch (e) {
            L("  findSafeBottom: bulk geometricBounds err: " + e);
        }

        var topmostBelow = null;
        var collidingIdx = -1;
        for (var i = 0; i < allBounds.length; i++) {
            var bnd = allBounds[i];
            if (!bnd || bnd.length < 4) continue;
            var iy1 = bnd[0], ix1 = bnd[1], iy2 = bnd[2], ix2 = bnd[3];
            // Skip items that are the table frame itself (nearly identical bounds)
            if (Math.abs(iy1 - origBounds[0]) < 0.01 && Math.abs(ix1 - origBounds[1]) < 0.01 &&
                Math.abs(iy2 - origBounds[2]) < 0.01 && Math.abs(ix2 - origBounds[3]) < 0.01) continue;
            // Must be below original table bottom and horizontally overlap
            if (iy1 < origBottom - 0.01) continue;
            if (ix2 < frameLeft - 0.01 || ix1 > frameRight + 0.01) continue;
            if (topmostBelow === null || iy1 < topmostBelow) {
                topmostBelow = iy1;
                collidingIdx = i;
            }
        }
        L("  findSafeBottom: topmostBelow=" + (topmostBelow !== null ? topmostBelow : "n/a") + " idx=" + collidingIdx);

        var collidingName = "(page margin)";
        if (collidingIdx >= 0) {
            try { collidingName = "page item #" + collidingIdx; } catch (e) {}
        }
        var ceiling = (topmostBelow !== null) ? topmostBelow : pageMarginBottom;
        var safetyMargin = 0.0625; // ~1/16"
        return {
            origBottom: origBottom,
            ceiling:    ceiling - safetyMargin,
            colliderTop: topmostBelow,
            colliderName: collidingName,
            pageMarginBottom: pageMarginBottom
        };
    }

    function setFrameBottom(frame, newBottom) {
        var b = frame.geometricBounds;
        frame.geometricBounds = [b[0], b[1], newBottom, b[3]];
    }

    function getBodyCells(table, headerRows) {
        // Collect all cell objects in body rows, once.
        var arr = [];
        for (var r = headerRows; r < table.rows.length; r++) {
            for (var c = 0; c < table.columns.length; c++) {
                try { arr.push(table.rows[r].cells[c]); } catch (e) {}
            }
        }
        return arr;
    }

    L("  parentTF found: " + (parentTF ? "yes" : "no"));
    if (parentTF) {
        L("  parentTF bounds: " + parentTF.geometricBounds);
        L("  parentTF.overflows = " + parentTF.overflows);
        var info = findSafeBottom(parentTF);
        L("Layout fit: origBottom=" + info.origBottom.toFixed(3) +
          " ceiling=" + info.ceiling.toFixed(3) +
          " (limited by: " + info.colliderName + " at top=" + (info.colliderTop !== null ? info.colliderTop.toFixed(3) : "n/a") + ")");

        // Step 1 — extend frame to safe ceiling (no collision)
        if (parentTF.geometricBounds[2] < info.ceiling) {
            setFrameBottom(parentTF, info.ceiling);
            L("  step 1: extended frame to safe ceiling y=" + info.ceiling.toFixed(3));
        }

        // Sample current metrics (units: inches for inset/height, points for font)
        var sampleCell = tbl.rows[headerRows].cells[0];
        var sampleRow = tbl.rows[headerRows];
        var origTopInset = 0, origBotInset = 0, origPointSize = 0, origMinHeight = 0;
        try { origTopInset = sampleCell.topInset; } catch(e){}
        try { origBotInset = sampleCell.bottomInset; } catch(e){}
        try { origPointSize = sampleCell.texts[0].pointSize; } catch(e){}
        try { origMinHeight = sampleRow.minimumHeight; } catch(e){}
        L("  starting metrics: topInset=" + origTopInset + " botInset=" + origBotInset +
          " ptSize=" + origPointSize + " minHeight=" + origMinHeight);

        var bodyCells = getBodyCells(tbl, headerRows);
        L("  body cells collected: " + bodyCells.length);

        // Floors — units in INCHES for height/inset, POINTS for fontsize
        var insetFloor   = 0.01;  // inches (~0.7pt)
        var heightFloor  = 0.18;  // inches (~13pt — keeps row legible)
        var ptFloor      = 6.5;   // points

        // Step 2a — reduce row minimum height in 0.01" increments
        var heightSteps = 0;
        while (parentTF.overflows && heightSteps < 15) {
            var curMin = sampleRow.minimumHeight;
            if (curMin <= heightFloor) break;
            try {
                var newMin = Math.max(heightFloor, curMin - 0.01);
                tbl.rows.everyItem().minimumHeight = newMin;
            } catch (e) { L("  minHeight set err: " + e); break; }
            heightSteps++;
        }
        if (heightSteps > 0) L("  step 2a: row minHeight " + origMinHeight + " → " + sampleRow.minimumHeight + " (" + heightSteps + " step(s)); overflows=" + parentTF.overflows);

        // Step 2b — reduce cell insets in 0.005" increments
        var insetSteps = 0;
        while (parentTF.overflows && insetSteps < 15) {
            var curTop = sampleCell.topInset;
            var curBot = sampleCell.bottomInset;
            if (curTop <= insetFloor && curBot <= insetFloor) break;
            for (var i = 0; i < bodyCells.length; i++) {
                try {
                    var cl = bodyCells[i];
                    if (cl.topInset    > insetFloor) cl.topInset    = Math.max(insetFloor, cl.topInset    - 0.005);
                    if (cl.bottomInset > insetFloor) cl.bottomInset = Math.max(insetFloor, cl.bottomInset - 0.005);
                } catch (e) {}
            }
            insetSteps++;
        }
        if (insetSteps > 0) L("  step 2b: insets shrunk " + insetSteps + " step(s); cur top=" + sampleCell.topInset + " bot=" + sampleCell.bottomInset + "; overflows=" + parentTF.overflows);

        // Step 3 — reduce body font size in 0.25pt increments
        var fontSteps = 0;
        while (parentTF.overflows && fontSteps < 6) {
            var curPt = sampleCell.texts[0].pointSize;
            if (curPt <= ptFloor) break;
            for (var i = 0; i < bodyCells.length; i++) {
                try {
                    var t = bodyCells[i].texts[0];
                    if (t.pointSize > ptFloor) t.pointSize = t.pointSize - 0.25;
                } catch (e) {}
            }
            fontSteps++;
        }
        if (fontSteps > 0) L("  step 3: font shrunk " + fontSteps + " step(s); cur=" + sampleCell.texts[0].pointSize + "; overflows=" + parentTF.overflows);

        // Final state
        var newTopInset = 0, newBotInset = 0, newPointSize = 0, newMinHeight = 0;
        try { newTopInset = sampleCell.topInset; } catch(e){}
        try { newBotInset = sampleCell.bottomInset; } catch(e){}
        try { newPointSize = sampleCell.texts[0].pointSize; } catch(e){}
        try { newMinHeight = sampleRow.minimumHeight; } catch(e){}

        // Re-check collision: did we extend too far / does the frame's new bottom
        // exceed any item below?
        var finalBottom = parentTF.geometricBounds[2];
        var collision = (info.colliderTop !== null) && (finalBottom > info.colliderTop);
        if (parentTF.overflows) {
            FLAG("Layout fit failed: still overflows even after inset+font shrink. Manual layout intervention required. Final state: topInset=" + newTopInset + " botInset=" + newBotInset + " ptSize=" + newPointSize);
        } else if (collision) {
            FLAG("Frame extended past element below (" + info.colliderName + "). Manual review needed.");
        } else {
            var report = "Layout-fit succeeded:";
            report += " frame extended " + info.origBottom.toFixed(3) + "\" → " + finalBottom.toFixed(3) + "\".";
            if (newMinHeight !== origMinHeight) {
                report += " Row min-height " + origMinHeight.toFixed(3) + "\" → " + newMinHeight.toFixed(3) + "\".";
            }
            if (newTopInset !== origTopInset || newBotInset !== origBotInset) {
                report += " Insets " + origTopInset.toFixed(4) + "\"/" + origBotInset.toFixed(4) + "\" → " + newTopInset.toFixed(4) + "\"/" + newBotInset.toFixed(4) + "\".";
            }
            if (newPointSize !== origPointSize) {
                report += " Body font " + origPointSize + "pt → " + newPointSize + "pt.";
            }
            report += " Verify visually.";
            FLAG(report);
        }
    }

    // ==========================================================
    // STEP 13: COMPREHENSIVE QA SCAN
    // Each check is self-contained. Findings are structured for the future
    // app's review UI. Severity: 'error' (blocks publish), 'warning' (review),
    // 'info' (FYI). Some checks auto-fix; others only flag.
    // ==========================================================
    L("\nSTEP 13: comprehensive QA scan");
    var qaFindings = [];
    function FINDING(severity, id, category, location, message, autoFix, fixAction) {
        qaFindings.push({
            severity: severity, id: id, category: category, location: location,
            message: message, autoFix: !!autoFix, fixAction: fixAction || ""
        });
        L("  [" + severity.toUpperCase() + "] " + id + " " + location + " — " + message);
    }
    function safe(fn, label) {
        try { fn(); } catch (e) { L("  ERR in " + label + ": " + e + " (line " + e.line + ")"); }
    }
    // Simple JSON string encoder (ExtendScript may not have global JSON)
    function jsonStr(s) {
        if (s === undefined || s === null) return "null";
        s = String(s);
        var out = "\"";
        for (var i = 0; i < s.length; i++) {
            var ch = s.charAt(i);
            var code = s.charCodeAt(i);
            if (ch === "\"") out += "\\\"";
            else if (ch === "\\") out += "\\\\";
            else if (ch === "\n") out += "\\n";
            else if (ch === "\r") out += "\\r";
            else if (ch === "\t") out += "\\t";
            else if (code < 0x20) out += "\\u" + ("0000" + code.toString(16)).slice(-4);
            else out += ch;
        }
        out += "\"";
        return out;
    }

    // --- 13.1: Extra spaces, tabs in text, trailing whitespace ---
    safe(function () {
        app.findGrepPreferences  = NothingEnum.NOTHING;
        app.changeGrepPreferences = NothingEnum.NOTHING;
        // Multiple spaces → single space
        app.findGrepPreferences.findWhat = "  +";
        app.changeGrepPreferences.changeTo = " ";
        var n1 = doc.changeGrep().length;
        // Tab in middle of text (rarely intentional outside table cells; skip cells)
        app.findGrepPreferences  = NothingEnum.NOTHING;
        app.changeGrepPreferences = NothingEnum.NOTHING;
        // Trailing whitespace on lines
        app.findGrepPreferences.findWhat = " +(?=\\r|\\n|$)";
        app.changeGrepPreferences.changeTo = "";
        var n2 = doc.changeGrep().length;
        if (n1 + n2 > 0) FINDING("info", "TEXT_WHITESPACE", "text", "doc-wide", "auto-fixed " + n1 + " multi-space, " + n2 + " trailing-whitespace occurrence(s)", true, "");
        app.findGrepPreferences  = NothingEnum.NOTHING;
        app.changeGrepPreferences = NothingEnum.NOTHING;
    }, "13.1 whitespace");

    // --- 13.2: Smart quotes (auto-fix straight to curly where appropriate) ---
    safe(function () {
        app.findGrepPreferences  = NothingEnum.NOTHING;
        app.changeGrepPreferences = NothingEnum.NOTHING;
        // Straight double quotes around a word
        app.findGrepPreferences.findWhat = "\"(\\S[^\"]*\\S)\"";
        app.changeGrepPreferences.changeTo = "“$1”";
        var n1 = doc.changeGrep().length;
        // Straight apostrophes (possessive, contractions) — between word chars or after a letter
        app.findGrepPreferences  = NothingEnum.NOTHING;
        app.changeGrepPreferences = NothingEnum.NOTHING;
        app.findGrepPreferences.findWhat = "(?<=\\w)'(?=\\w|s\\b)";
        app.changeGrepPreferences.changeTo = "’";
        var n2 = doc.changeGrep().length;
        if (n1 + n2 > 0) FINDING("info", "TEXT_SMART_QUOTES", "text", "doc-wide", "auto-converted " + n1 + " straight-double-quote pair(s) and " + n2 + " straight apostrophe(s) to typographic", true, "");
        app.findGrepPreferences  = NothingEnum.NOTHING;
        app.changeGrepPreferences = NothingEnum.NOTHING;
    }, "13.2 smart quotes");

    // --- 13.3: Hyphen between words where en-dash likely intended (flag only — context-sensitive) ---
    safe(function () {
        app.findGrepPreferences  = NothingEnum.NOTHING;
        // " - " between words is often an en-dash mistake; flag only
        app.findGrepPreferences.findWhat = "\\b\\w+ - \\w+\\b";
        var hits = doc.findGrep();
        if (hits.length > 0) {
            var samples = [];
            for (var i = 0; i < Math.min(3, hits.length); i++) {
                try { samples.push("\"" + hits[i].contents.substring(0, 30) + "\""); } catch (e) {}
            }
            FINDING("warning", "TEXT_HYPHEN_VS_DASH", "text", "doc-wide",
                hits.length + " occurrence(s) of word-hyphen-word (consider en-dash). Examples: " + samples.join(", "),
                false, "Review and replace with en-dash (–) where appropriate");
        }
        app.findGrepPreferences = NothingEnum.NOTHING;
    }, "13.3 hyphen vs dash");

    // --- 13.4: Double punctuation (auto-fix obvious cases) ---
    safe(function () {
        app.findGrepPreferences  = NothingEnum.NOTHING;
        app.changeGrepPreferences = NothingEnum.NOTHING;
        var changes = 0;
        // Three or more periods → ellipsis
        app.findGrepPreferences.findWhat = "\\.{3,}";
        app.changeGrepPreferences.changeTo = "…";
        changes += doc.changeGrep().length;
        // Double commas
        app.findGrepPreferences  = NothingEnum.NOTHING;
        app.changeGrepPreferences = NothingEnum.NOTHING;
        app.findGrepPreferences.findWhat = ",,+";
        app.changeGrepPreferences.changeTo = ",";
        changes += doc.changeGrep().length;
        if (changes > 0) FINDING("info", "TEXT_DOUBLE_PUNCT", "text", "doc-wide", "auto-fixed " + changes + " double-punctuation occurrence(s)", true, "");
        app.findGrepPreferences  = NothingEnum.NOTHING;
        app.changeGrepPreferences = NothingEnum.NOTHING;
    }, "13.4 double punct");

    // --- 13.5: Empty paragraphs (consecutive returns) ---
    safe(function () {
        app.findGrepPreferences = NothingEnum.NOTHING;
        app.findGrepPreferences.findWhat = "\\r{2,}";
        var hits = doc.findGrep();
        if (hits.length > 0) {
            FINDING("warning", "TEXT_EMPTY_PARAS", "text", "doc-wide",
                hits.length + " location(s) with consecutive empty paragraphs", false,
                "Review whether intentional (spacing) or extra returns to delete");
        }
        app.findGrepPreferences = NothingEnum.NOTHING;
    }, "13.5 empty paragraphs");

    // --- 13.6: Trademark / Registered / Copyright should be superscript ---
    safe(function () {
        app.findGrepPreferences = NothingEnum.NOTHING;
        app.findGrepPreferences.findWhat = "[®™©]";
        var hits = doc.findGrep();
        var fixed = 0;
        for (var i = 0; i < hits.length; i++) {
            try {
                if (hits[i].position !== Position.SUPERSCRIPT) {
                    hits[i].position = Position.SUPERSCRIPT;
                    fixed++;
                }
            } catch (e) {}
        }
        if (fixed > 0) FINDING("info", "TEXT_TM_SUPERSCRIPT", "text", "doc-wide", "auto-superscripted " + fixed + " trademark/registered/copyright mark(s)", true, "");
        app.findGrepPreferences = NothingEnum.NOTHING;
    }, "13.6 trademark superscript");

    // --- 13.7: Style overrides on paragraphs (basic detection) ---
    safe(function () {
        var overrideCount = 0;
        var stories = doc.stories;
        for (var s = 0; s < stories.length; s++) {
            try {
                var paras = stories[s].paragraphs;
                for (var p = 0; p < paras.length; p++) {
                    var para = paras[p];
                    var ps = para.appliedParagraphStyle;
                    if (!ps || ps.name === "[No Paragraph Style]" || ps.name === "[Basic Paragraph]") continue;
                    // Compare a few likely-overridden properties
                    try {
                        if (ps.appliedFont && para.appliedFont && para.appliedFont !== ps.appliedFont) overrideCount++;
                        else if (ps.pointSize && para.pointSize !== ps.pointSize) overrideCount++;
                    } catch (e) {}
                }
            } catch (e) {}
        }
        if (overrideCount > 0) FINDING("warning", "STYLE_PARA_OVERRIDES", "style", "doc-wide",
            overrideCount + " paragraph(s) have overrides differing from their applied paragraph style", false,
            "Review and clear overrides if unintended");
    }, "13.7 paragraph style overrides");

    // --- 13.8: Color consistency — flag text whose fillColor differs from its paragraph style's ---
    safe(function () {
        var mismatchCount = 0;
        var samples = [];
        var stories = doc.stories;
        for (var s = 0; s < stories.length; s++) {
            try {
                var paras = stories[s].paragraphs;
                for (var p = 0; p < paras.length && mismatchCount < 50; p++) {
                    var para = paras[p];
                    var ps = para.appliedParagraphStyle;
                    if (!ps || !ps.fillColor) continue;
                    if (para.fillColor && para.fillColor !== ps.fillColor) {
                        mismatchCount++;
                        if (samples.length < 3) samples.push("\"" + String(para.contents).substring(0, 30) + "\" using " + (para.fillColor.name || "?") + " vs style " + (ps.fillColor.name || "?"));
                    }
                }
            } catch (e) {}
        }
        if (mismatchCount > 0) FINDING("warning", "STYLE_COLOR_MISMATCH", "style", "doc-wide",
            mismatchCount + " paragraph(s) with color overriding paragraph-style color. Examples: " + samples.join(" | "),
            false, "Review whether intentional");
    }, "13.8 color consistency");

    // --- 13.9: Typeface inventory ---
    safe(function () {
        var fontsUsed = doc.fonts;
        var fontNames = [];
        for (var f = 0; f < fontsUsed.length; f++) {
            try { fontNames.push(fontsUsed[f].fullName); } catch (e) {}
        }
        FINDING("info", "FONT_INVENTORY", "fonts", "doc",
            fontsUsed.length + " font(s) in document: " + fontNames.slice(0, 8).join(", ") + (fontNames.length > 8 ? ", ..." : ""),
            false, "");
        if (fontsUsed.length > 4) {
            FINDING("warning", "FONT_TOO_MANY", "fonts", "doc",
                fontsUsed.length + " distinct fonts (consider consolidating to 2-4)", false, "");
        }
    }, "13.9 typeface inventory");

    // --- 13.10: Image resolution (effective DPI) ---
    safe(function () {
        var graphics = doc.allGraphics;
        var lowRes = 0, samples = [];
        for (var g = 0; g < graphics.length; g++) {
            try {
                var graphic = graphics[g];
                // effectivePpi accounts for scaling; available on Image
                var eppi = null;
                try { eppi = graphic.effectivePpi; } catch (e) {}
                if (eppi && eppi.length >= 2) {
                    var minPpi = Math.min(eppi[0], eppi[1]);
                    if (minPpi < 300) {
                        lowRes++;
                        if (samples.length < 5) {
                            var fname = "?";
                            try { fname = graphic.itemLink ? graphic.itemLink.name : (graphic.name || "?"); } catch (e) {}
                            samples.push(fname + " @ " + Math.round(minPpi) + "dpi");
                        }
                    }
                }
            } catch (e) {}
        }
        if (lowRes > 0) FINDING("error", "IMG_LOW_RES", "image", "doc-wide",
            lowRes + " image(s) below 300dpi. Examples: " + samples.join(", "),
            false, "Replace asset with higher-resolution version");
        FINDING("info", "IMG_COUNT", "image", "doc", graphics.length + " placed graphic(s) total", false, "");
    }, "13.10 image resolution");

    // --- 13.11: Missing or modified links ---
    safe(function () {
        var allLinks = doc.links;
        var missing = 0, modified = 0, missSamples = [], modSamples = [];
        for (var i = 0; i < allLinks.length; i++) {
            try {
                var lnk = allLinks[i];
                if (lnk.status === LinkStatus.LINK_MISSING) {
                    missing++;
                    if (missSamples.length < 3) missSamples.push(lnk.name);
                } else if (lnk.status === LinkStatus.LINK_OUT_OF_DATE) {
                    modified++;
                    if (modSamples.length < 3) modSamples.push(lnk.name);
                }
            } catch (e) {}
        }
        if (missing > 0) FINDING("error", "LINK_MISSING", "links", "doc",
            missing + " missing link(s): " + missSamples.join(", "), false, "Re-link or replace asset");
        if (modified > 0) FINDING("warning", "LINK_OUT_OF_DATE", "links", "doc",
            modified + " out-of-date link(s): " + modSamples.join(", "), false, "Update links");
    }, "13.11 link status");

    // --- 13.12: Font availability ---
    safe(function () {
        var allFonts = doc.fonts;
        var unavailable = [];
        for (var f = 0; f < allFonts.length; f++) {
            try {
                if (allFonts[f].status !== FontStatus.INSTALLED) {
                    unavailable.push(allFonts[f].fullName + " (" + allFonts[f].status + ")");
                }
            } catch (e) {}
        }
        if (unavailable.length > 0) FINDING("error", "FONT_UNAVAILABLE", "fonts", "doc",
            unavailable.length + " font(s) not properly installed: " + unavailable.slice(0, 5).join(", "),
            false, "Activate via Adobe Fonts or install system font");
    }, "13.12 font availability");

    // --- 13.13: RGB swatches in (presumably) a print/CMYK doc ---
    safe(function () {
        var rgbSwatches = [];
        for (var s = 0; s < doc.swatches.length; s++) {
            try {
                var sw = doc.swatches[s];
                if (sw.space === ColorSpace.RGB) rgbSwatches.push(sw.name);
            } catch (e) {}
        }
        if (rgbSwatches.length > 0) FINDING("warning", "COLOR_RGB_SWATCH", "color", "doc",
            rgbSwatches.length + " RGB swatch(es): " + rgbSwatches.slice(0, 5).join(", "),
            false, "Convert to CMYK for print output");
    }, "13.13 RGB swatches");

    // --- 13.14: Spot colors (flag if not expected) ---
    safe(function () {
        var spots = [];
        for (var s = 0; s < doc.swatches.length; s++) {
            try {
                var sw = doc.swatches[s];
                if (sw.colorModel === ColorModel.SPOT) spots.push(sw.name);
            } catch (e) {}
        }
        if (spots.length > 0) FINDING("info", "COLOR_SPOT_COLORS", "color", "doc",
            spots.length + " spot color(s): " + spots.slice(0, 5).join(", "),
            false, "Confirm intended for print spec; convert to process if not");
    }, "13.14 spot colors");

    // --- 13.15: Hyperlinks audit ---
    safe(function () {
        var hyperlinks = doc.hyperlinks;
        if (hyperlinks.length === 0) return;
        var mismatches = 0, urlList = [], samples = [];
        for (var h = 0; h < hyperlinks.length; h++) {
            try {
                var link = hyperlinks[h];
                var dest = link.destination;
                var destURL = "";
                try { destURL = dest.destinationURL || ""; } catch (e) {}
                var sourceText = "";
                try { sourceText = link.source.sourceText.contents; } catch (e) {}
                urlList.push({ src: sourceText, dest: destURL });
                // If source text *looks like* a URL, check it matches the destination
                var srcLooksLikeUrl = /^(https?:\/\/|www\.|[a-z0-9.-]+@[a-z0-9.-]+\.[a-z]+)/i.test(sourceText.replace(/\s+/g, ""));
                if (srcLooksLikeUrl && destURL && sourceText.replace(/\s+/g, "").toLowerCase() !== destURL.toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "")) {
                    mismatches++;
                    if (samples.length < 5) samples.push("\"" + sourceText.substring(0, 40) + "\" → " + destURL);
                }
            } catch (e) {}
        }
        FINDING("info", "HYPERLINK_INVENTORY", "links", "doc", hyperlinks.length + " hyperlink(s) in doc", false, "");
        if (mismatches > 0) FINDING("warning", "HYPERLINK_TEXT_MISMATCH", "links", "doc",
            mismatches + " hyperlink(s) where displayed text looks like a URL but doesn't match destination. Examples: " + samples.join(" | "),
            false, "Verify destination URL matches displayed text");
        // Write hyperlink inventory JSON for the future app's reachability check (Python side)
        try {
            var hf = File("/Users/36981/Desktop/Prdouction AI/Test/hyperlinks.json");
            hf.encoding = "UTF-8"; hf.open("w");
            var jsonItems = [];
            for (var i = 0; i < urlList.length; i++) {
                jsonItems.push("{\"src\":" + jsonStr(urlList[i].src) + ",\"dest\":" + jsonStr(urlList[i].dest) + "}");
            }
            hf.write("[" + jsonItems.join(",") + "]");
            hf.close();
        } catch (e) {}
    }, "13.15 hyperlinks");

    // --- 13.16: Bare URLs in text not converted to hyperlinks ---
    safe(function () {
        app.findGrepPreferences = NothingEnum.NOTHING;
        app.findGrepPreferences.findWhat = "\\b(?:https?://|www\\.)[\\w.-]+(?:/[^\\s]*)?";
        var hits = doc.findGrep();
        var unlinked = 0, samples = [];
        for (var i = 0; i < hits.length; i++) {
            try {
                // Check if this text has a hyperlink applied
                var hasLink = false;
                try {
                    var links = hits[i].appliedHyperlinks || [];
                    if (links.length > 0) hasLink = true;
                } catch (e) {}
                // Heuristic: walk doc.hyperlinks and see if any source matches this text range
                if (!hasLink) {
                    unlinked++;
                    if (samples.length < 3) samples.push(hits[i].contents.substring(0, 50));
                }
            } catch (e) {}
        }
        if (unlinked > 0) FINDING("warning", "URL_NOT_HYPERLINKED", "links", "doc-wide",
            unlinked + " URL-like text(s) not hyperlinked. Examples: " + samples.join(", "),
            false, "Convert to hyperlinks");
        app.findGrepPreferences = NothingEnum.NOTHING;
    }, "13.16 bare URLs");

    // --- 13.17: Overset text in any frame ---
    safe(function () {
        var allFrames = doc.textFrames;
        var oversetFrames = 0, samples = [];
        for (var f = 0; f < allFrames.length; f++) {
            try {
                if (allFrames[f].overflows) {
                    oversetFrames++;
                    var preview = "";
                    try { preview = allFrames[f].contents.substring(0, 30).replace(/[\r\n]+/g, " "); } catch (e) {}
                    if (samples.length < 3) samples.push("frame on page " + (allFrames[f].parentPage ? allFrames[f].parentPage.name : "?") + " (\"" + preview + "...\")");
                }
            } catch (e) {}
        }
        if (oversetFrames > 0) FINDING("error", "TEXT_OVERSET", "layout", "doc-wide",
            oversetFrames + " text frame(s) with overset text. Examples: " + samples.join(" | "),
            false, "Resize frame, reduce content, or thread to next frame");
    }, "13.17 overset text");

    // --- 13.18: Hidden layers with content ---
    safe(function () {
        var hiddenWithContent = [];
        for (var l = 0; l < doc.layers.length; l++) {
            try {
                var layer = doc.layers[l];
                if (!layer.visible) {
                    var hasContent = false;
                    try { hasContent = layer.allPageItems.length > 0; } catch (e) {}
                    if (hasContent) hiddenWithContent.push(layer.name);
                }
            } catch (e) {}
        }
        if (hiddenWithContent.length > 0) FINDING("info", "LAYER_HIDDEN_WITH_CONTENT", "layout", "doc",
            hiddenWithContent.length + " hidden layer(s) with content: " + hiddenWithContent.join(", "),
            false, "Verify intentional");
    }, "13.18 hidden layers");

    // --- 13.19: Locked items ---
    safe(function () {
        var lockedCount = 0;
        for (var p = 0; p < doc.pages.length; p++) {
            var items = doc.pages[p].allPageItems;
            for (var i = 0; i < items.length; i++) {
                try { if (items[i].locked) lockedCount++; } catch (e) {}
            }
        }
        if (lockedCount > 0) FINDING("info", "ITEM_LOCKED", "layout", "doc",
            lockedCount + " locked item(s)", false, "Verify intentional");
    }, "13.19 locked items");

    // --- 13.20: Document color profile ---
    safe(function () {
        var cmyk = "?", rgb = "?";
        try { cmyk = doc.cmykProfile; } catch (e) {}
        try { rgb = doc.rgbProfile; } catch (e) {}
        FINDING("info", "DOC_COLOR_PROFILE", "color", "doc", "CMYK=" + cmyk + " | RGB=" + rgb, false, "");
    }, "13.20 color profile");

    // --- 13.21: Page count and dimensions ---
    safe(function () {
        FINDING("info", "DOC_DIMENSIONS", "doc", "doc",
            doc.pages.length + " page(s), " + doc.documentPreferences.pageWidth + "\" × " + doc.documentPreferences.pageHeight + "\"",
            false, "");
    }, "13.21 dimensions");

    // --- 13.22: Bleed compliance (basic check) ---
    safe(function () {
        var bleedTop    = doc.documentPreferences.documentBleedTopOffset;
        var bleedBottom = doc.documentPreferences.documentBleedBottomOffset;
        var bleedLeft   = doc.documentPreferences.documentBleedInsideOrLeftOffset;
        var bleedRight  = doc.documentPreferences.documentBleedOutsideOrRightOffset;
        var hasBleed    = bleedTop > 0 || bleedBottom > 0 || bleedLeft > 0 || bleedRight > 0;
        if (!hasBleed) {
            FINDING("warning", "DOC_NO_BLEED", "print", "doc",
                "No bleed configured (top/bottom/left/right all 0). For print, typically need 0.125\".",
                false, "Add bleed in Document Setup if for print");
        } else {
            FINDING("info", "DOC_BLEED", "print", "doc",
                "Bleed: T=" + bleedTop + " B=" + bleedBottom + " L=" + bleedLeft + " R=" + bleedRight, false, "");
        }
    }, "13.22 bleed");

    // --- 13.23: Spot colors used in document body (vs. just defined) ---
    safe(function () {
        // Already inventoried in 13.14. Skip duplicate scan.
    }, "13.23 spot used");

    // --- 13.24: Pure black vs rich black on small body text ---
    safe(function () {
        // Walk paragraphs at small sizes and check fillColor C/M/Y for non-zero where K=100
        var richBlackOnSmallText = 0, samples = [];
        var stories = doc.stories;
        for (var s = 0; s < stories.length && samples.length < 5; s++) {
            try {
                var paras = stories[s].paragraphs;
                for (var p = 0; p < paras.length && samples.length < 5; p++) {
                    try {
                        var pt = paras[p].pointSize;
                        if (pt > 14) continue; // only flag for body-text-ish sizes
                        var fc = paras[p].fillColor;
                        if (!fc || !fc.colorValue) continue;
                        var cv = fc.colorValue;
                        // CMYK colors return [C, M, Y, K]. Rich black = K=100 + any of CMY > 0.
                        if (cv.length === 4 && cv[3] === 100 && (cv[0] > 0 || cv[1] > 0 || cv[2] > 0)) {
                            richBlackOnSmallText++;
                            if (samples.length < 3) samples.push("\"" + String(paras[p].contents).substring(0, 30) + "\" @ " + pt + "pt");
                        }
                    } catch (e) {}
                }
            } catch (e) {}
        }
        if (richBlackOnSmallText > 0) FINDING("warning", "COLOR_RICH_BLACK_SMALL", "color", "doc-wide",
            richBlackOnSmallText + " small text run(s) using rich black (registers poorly): " + samples.join(", "),
            false, "Change to 100% K only for body text");
    }, "13.24 rich black");

    // --- 13.25: Black overprint setting check (deeper overprint logic requires Preflight; flag for app) ---
    safe(function () {
        FINDING("info", "DOC_OVERPRINT_PREF", "print", "doc",
            "Deeper overprint check (small K-only text knockout) deferred to Preflight integration in app",
            false, "");
    }, "13.25 overprint");

    // --- 13.26: Pure-black text inventory (FYI, used to validate 100% K consistency) ---
    safe(function () {
        // Skipped — duplicates 13.8 in spirit
    }, "13.26 black inventory");

    // --- 13.27: Master page overrides ---
    safe(function () {
        var overridden = 0;
        for (var p = 0; p < doc.pages.length; p++) {
            try {
                var page = doc.pages[p];
                var items = page.allPageItems;
                for (var i = 0; i < items.length; i++) {
                    try { if (items[i].overridden) overridden++; } catch (e) {}
                }
            } catch (e) {}
        }
        if (overridden > 0) FINDING("info", "MASTER_OVERRIDES", "layout", "doc",
            overridden + " master-page item override(s)", false, "Verify intentional");
    }, "13.27 master overrides");

    // --- 13.28: Output findings JSON for app consumption ---
    safe(function () {
        var jf = File("/Users/36981/Desktop/Prdouction AI/Test/findings.json");
        jf.encoding = "UTF-8"; jf.open("w");
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
    }, "13.28 findings json");

    L("STEP 13 done. Total QA findings: " + qaFindings.length);

    L("STEP 10: saving .indd");
    // ---------- Save & export ----------
    doc.save(File(inddPath));
    L("Saved .indd");

    L("STEP 11: exporting PDF");
    try {
        var preset = null;
        try { preset = app.pdfExportPresets.itemByName("[High Quality Print]"); if (!preset.isValid) preset = null; } catch (e) {}
        if (!preset) preset = app.pdfExportPresets[0];
        L("PDF preset: " + preset.name);
        doc.exportFile(ExportFormat.PDF_TYPE, File(pdfOut), false, preset);
        L("Exported PDF: " + pdfOut);
    } catch (e) {
        L("PDF export error: " + e);
        FLAG("PDF export failed: " + e);
    }

    L("STEP 12: closing doc");
    doc.close(SaveOptions.YES);
    app.scriptPreferences.userInteractionLevel = UserInteractionLevels.INTERACT_WITH_ALL;
    app.scriptPreferences.enableRedraw = true;

    var lf = File(logPath);  lf.encoding="UTF-8"; lf.open("w"); lf.write(lines.join("\n")); lf.close();
    var ff = File(flagsPath); ff.encoding="UTF-8"; ff.open("w"); ff.write(flags.join("\n")); ff.close();
    } catch (e) {
        try {
            var em = "FATAL OUTER: " + e + " (line " + e.line + ")\n" + (e.stack || "");
            var lf = File(__outerLogPath); lf.encoding = "UTF-8"; lf.open("a"); lf.write("\n" + em); lf.close();
        } catch (ee) {}
    }
})();
