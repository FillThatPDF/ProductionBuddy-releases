// Illustrator inspector — gathers a JSON snapshot of the open document so the
// orchestrator's classifier has enough context to map PDF annotations onto
// concrete edits. Mirrors the InDesign inspector's output shape where it
// makes sense, omitting concepts AI doesn't have (tables, TOC, master pages).
#target illustrator

(function () {
    var inddPath        = "__INDD_PATH__";
    var inspectOutPath  = "__INSPECT_OUT_PATH__";

    function jsonStr(s) {
        if (s === undefined || s === null) return "null";
        s = String(s); var out = "\"";
        for (var i = 0; i < s.length; i++) {
            var ch = s.charAt(i), c = s.charCodeAt(i);
            if (ch === "\"") out += "\\\""; else if (ch === "\\") out += "\\\\";
            else if (ch === "\n") out += "\\n"; else if (ch === "\r") out += "\\r"; else if (ch === "\t") out += "\\t";
            else if (c < 32 || c === 127) out += "\\u" + ("0000" + c.toString(16)).slice(-4);
            else out += ch;
        }
        return out + "\"";
    }
    function jsonNum(n) { return (n === undefined || n === null || isNaN(n)) ? "null" : String(n); }

    var doc;
    try {
        doc = app.open(File(inddPath));
    } catch (e) {
        var ef = File(inspectOutPath); ef.encoding = "UTF-8"; ef.open("w");
        ef.write("{\"error\":" + jsonStr("open failed: " + e) + "}"); ef.close();
        return;
    }

    var fields = [];
    fields.push("\"engine\":\"illustrator\"");
    fields.push("\"name\":" + jsonStr(doc.name));

    // Document color space + dimensions (artboard 1)
    try {
        var cs = (doc.documentColorSpace === DocumentColorSpace.CMYK) ? "CMYK"
               : (doc.documentColorSpace === DocumentColorSpace.RGB)  ? "RGB" : "OTHER";
        fields.push("\"color_space\":" + jsonStr(cs));
    } catch (e) {}
    try {
        var ab0 = doc.artboards[0].artboardRect; // [left, top, right, bottom]
        fields.push("\"artboard_count\":" + jsonNum(doc.artboards.length));
        fields.push("\"artboard1_w_pt\":" + jsonNum(ab0[2] - ab0[0]));
        fields.push("\"artboard1_h_pt\":" + jsonNum(ab0[1] - ab0[3]));
    } catch (e) {}

    // Text frames preview (first ~50 chars of each)
    try {
        var tfs = [];
        for (var i = 0; i < doc.textFrames.length && i < 200; i++) {
            var tf = doc.textFrames[i];
            var content = "";
            try { content = String(tf.contents || ""); } catch (e) {}
            var preview = content.length > 80 ? content.substring(0, 80) + "..." : content;
            tfs.push("{\"index\":" + i + ",\"preview\":" + jsonStr(preview) + "}");
        }
        fields.push("\"text_frames\":[" + tfs.join(",") + "]");
    } catch (e) { fields.push("\"text_frames_err\":" + jsonStr(String(e))); }

    // Placed items (linked images / files)
    try {
        var placed = [];
        for (var p = 0; p < doc.placedItems.length; p++) {
            var pi = doc.placedItems[p];
            var path = "";
            try { path = String(pi.file && pi.file.fsName); } catch (e) {}
            placed.push("{\"index\":" + p + ",\"path\":" + jsonStr(path) + "}");
        }
        fields.push("\"placed_items\":[" + placed.join(",") + "]");
    } catch (e) {}

    // Raster items (embedded raster images)
    try {
        fields.push("\"raster_count\":" + jsonNum(doc.rasterItems.length));
    } catch (e) {}

    // Layers
    try {
        var layers = [];
        for (var li = 0; li < doc.layers.length; li++) {
            var lyr = doc.layers[li];
            var hidden = false, locked = false;
            try { hidden = !lyr.visible; } catch (e) {}
            try { locked = lyr.locked; } catch (e) {}
            layers.push("{\"name\":" + jsonStr(String(lyr.name)) + ",\"hidden\":" + (hidden?"true":"false") + ",\"locked\":" + (locked?"true":"false") + "}");
        }
        fields.push("\"layers\":[" + layers.join(",") + "]");
    } catch (e) {}

    // Doc metadata for 508 and general info
    try {
        var md = doc.XMPString;  // raw XMP packet
        // Best-effort title/author extraction from the XMP string
        function _xmpExtract(field) {
            var rx = new RegExp("<dc:" + field + "[\\s\\S]*?<rdf:li[^>]*>([\\s\\S]*?)</rdf:li>");
            var m = String(md).match(rx);
            return m ? m[1].replace(/^\s+|\s+$/g, "") : "";
        }
        fields.push("\"meta_title\":"   + jsonStr(_xmpExtract("title")));
        fields.push("\"meta_creator\":" + jsonStr(_xmpExtract("creator")));
        fields.push("\"meta_description\":" + jsonStr(_xmpExtract("description")));
    } catch (e) {}

    var f = File(inspectOutPath);
    f.encoding = "UTF-8";
    f.open("w");
    f.write("{" + fields.join(",") + "}");
    f.close();

    try { doc.close(SaveOptions.DONOTSAVECHANGES); } catch (e) {}
})();
