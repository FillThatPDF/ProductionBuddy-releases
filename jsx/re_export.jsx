// Re-open the saved .indd and re-export the PDF.
// Used after auto-activating fonts so the export picks up the now-installed fonts.
#target indesign

(function () {
    var inddPath = "__INDD_PATH__";
    var pdfOut   = "__PDF_OUT_PATH__";
    var logPath  = "__LOG_PATH__";
    try {
        app.scriptPreferences.userInteractionLevel = UserInteractionLevels.NEVER_INTERACT;
        app.scriptPreferences.enableRedraw = false;
        var doc = app.open(File(inddPath), false);

        var preset = null;
        try { preset = app.pdfExportPresets.itemByName("[High Quality Print]"); if (!preset.isValid) preset = null; } catch (e) {}
        if (!preset) preset = app.pdfExportPresets[0];
        doc.exportFile(ExportFormat.PDF_TYPE, File(pdfOut), false, preset);

        doc.close(SaveOptions.NO);
        app.scriptPreferences.userInteractionLevel = UserInteractionLevels.INTERACT_WITH_ALL;
        app.scriptPreferences.enableRedraw = true;

        try {
            var lf = File(logPath); lf.encoding = "UTF-8"; lf.open("a");
            lf.write("\nRE-EXPORT done after font activation: " + pdfOut);
            lf.close();
        } catch (e) {}
    } catch (e) {
        try {
            var lf = File(logPath); lf.encoding = "UTF-8"; lf.open("a");
            lf.write("\nRE-EXPORT FATAL: " + e + " (line " + e.line + ")");
            lf.close();
        } catch (ee) {}
    }
})();
