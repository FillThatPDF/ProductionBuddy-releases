// Read-only inspection of the .indd file. Writes report to inspect_report.txt.
#target indesign

(function () {
    var lines = [];
    function L(s) { lines.push(String(s)); }

    var inddPath = "/Users/36981/Desktop/Prdouction AI/Test/58168_CE_DTE_NHC_HERS_Rater_Directory_v03.indd";
    var reportPath = "/Users/36981/Desktop/Prdouction AI/Test/inspect_report.txt";

    app.scriptPreferences.userInteractionLevel = UserInteractionLevels.NEVER_INTERACT;

    var doc = app.open(File(inddPath), false); // open without showing window

    L("=== DOCUMENT ===");
    L("Name: " + doc.name);
    L("Pages: " + doc.pages.length);
    L("Spreads: " + doc.spreads.length);
    L("Page size: " + doc.documentPreferences.pageWidth + " x " + doc.documentPreferences.pageHeight);

    // --- Styles inventory ---
    L("\n=== PARAGRAPH STYLES ===");
    for (var i = 0; i < doc.paragraphStyles.length; i++) {
        L("  - " + doc.paragraphStyles[i].name);
    }
    L("\n=== CHARACTER STYLES ===");
    for (var i = 0; i < doc.characterStyles.length; i++) {
        L("  - " + doc.characterStyles[i].name);
    }
    L("\n=== TABLE STYLES ===");
    for (var i = 0; i < doc.tableStyles.length; i++) {
        L("  - " + doc.tableStyles[i].name);
    }
    L("\n=== CELL STYLES ===");
    for (var i = 0; i < doc.cellStyles.length; i++) {
        L("  - " + doc.cellStyles[i].name);
    }

    // --- Walk pages and find tables / text frames ---
    L("\n=== PAGE / FRAME STRUCTURE ===");
    for (var p = 0; p < doc.pages.length; p++) {
        var page = doc.pages[p];
        L("\n-- Page " + (p+1) + " --");
        L("  Text frames: " + page.textFrames.length);
        for (var f = 0; f < page.textFrames.length; f++) {
            var tf = page.textFrames[f];
            var preview = "";
            try { preview = tf.contents.substring(0, 80).replace(/[\r\n]+/g, " / "); } catch (e) {}
            L("    [TF " + f + "] bounds=" + tf.geometricBounds + " preview=\"" + preview + "\"");
            // Tables inside this frame
            try {
                if (tf.tables.length > 0) {
                    for (var t = 0; t < tf.tables.length; t++) {
                        var tbl = tf.tables[t];
                        L("      >> TABLE " + t + ": rows=" + tbl.rows.length + " cols=" + tbl.columns.length);
                        try { L("         tableStyle=" + tbl.appliedTableStyle.name); } catch (e) {}
                        try { L("         headerRows=" + tbl.headerRowCount + " bodyRows=" + tbl.bodyRowCount); } catch (e) {}
                        // First data row preview
                        var startRow = Math.min(tbl.headerRowCount, tbl.rows.length-1);
                        if (tbl.rows.length > startRow) {
                            var row0 = tbl.rows[startRow];
                            var cellsPreview = [];
                            for (var c = 0; c < Math.min(tbl.columns.length, 8); c++) {
                                try {
                                    var cellText = row0.cells[c].contents;
                                    if (typeof cellText !== "string") cellText = "";
                                    cellsPreview.push("[" + c + "]\"" + cellText.substring(0,40).replace(/[\r\n]+/g," ") + "\"");
                                } catch (e) { cellsPreview.push("[" + c + "]?"); }
                            }
                            L("         row " + startRow + " cells: " + cellsPreview.join(" | "));
                            try { L("         row " + startRow + " cellStyle=" + row0.cells[0].appliedCellStyle.name); } catch (e) {}
                            try { L("         row " + startRow + " paraStyle=" + row0.cells[0].paragraphs[0].appliedParagraphStyle.name); } catch (e) {}
                        }
                        // Try to detect alternating fills
                        try {
                            L("         alternatingFills=" + tbl.alternatingFills);
                            L("         startRowFillColor=" + (tbl.startRowFillColor ? tbl.startRowFillColor.name : "none"));
                            L("         endRowFillColor=" + (tbl.endRowFillColor ? tbl.endRowFillColor.name : "none"));
                            L("         startRowFillCount=" + tbl.startRowFillCount);
                            L("         endRowFillCount=" + tbl.endRowFillCount);
                        } catch (e) { L("         alt fill read error: " + e); }

                        // Inspect a few rows for check-mark column
                        L("         -- scanning all rows for check-mark glyphs --");
                        var lastCol = tbl.columns.length - 1;
                        for (var r = startRow; r < Math.min(tbl.rows.length, startRow + 30); r++) {
                            try {
                                var nameCell = tbl.rows[r].cells[0].contents;
                                var checkCell = tbl.rows[r].cells[lastCol].contents;
                                if (typeof nameCell !== "string") nameCell = "";
                                if (typeof checkCell !== "string") checkCell = "";
                                // print char codes for the check-mark cell to see the glyph
                                var codes = [];
                                for (var k = 0; k < Math.min(checkCell.length, 8); k++) codes.push(checkCell.charCodeAt(k));
                                L("           row " + r + ": name=\"" + nameCell.substring(0,30).replace(/[\r\n]+/g," ") + "\" lastCell=\"" + checkCell.substring(0,10).replace(/[\r\n]+/g," ") + "\" codes=[" + codes.join(",") + "]");
                            } catch (e) {}
                        }
                    }
                }
            } catch (e) { L("      (table read err: " + e + ")"); }
        }
        L("  Rectangles (image frames etc.): " + page.rectangles.length);
        L("  Groups: " + page.groups.length);
    }

    // --- Swatches (for shading) ---
    L("\n=== SWATCHES ===");
    for (var s = 0; s < doc.swatches.length; s++) {
        try { L("  - " + doc.swatches[s].name); } catch (e) {}
    }

    // Write report
    var f = File(reportPath);
    f.encoding = "UTF-8";
    f.open("w");
    f.write(lines.join("\n"));
    f.close();

    doc.close(SaveOptions.NO);
    app.scriptPreferences.userInteractionLevel = UserInteractionLevels.INTERACT_WITH_ALL;
})();
