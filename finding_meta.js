// Per-finding metadata: clear explanation + recommended fix path.
// Drives the inline "More info" disclosure on each finding card.
const FINDING_META = {
  // ---- Auto-fixed silently (info-only, just FYI) ----
  TEXT_WHITESPACE: {
    title: "Whitespace cleanup",
    plain: "Multiple consecutive spaces or trailing spaces at line ends were removed.",
    fix: "Already auto-fixed. Nothing to do.",
    canAutoFix: true,
  },
  TEXT_SMART_QUOTES: {
    title: "Smart quotes applied",
    plain: "Straight quotes (\" ' ) were converted to typographic ones (“ ” ’).",
    fix: "Already auto-fixed.",
    canAutoFix: true,
  },
  TEXT_DOUBLE_PUNCT: {
    title: "Doubled punctuation cleaned up",
    plain: "Triple-period sequences became ellipsis (…); doubled commas collapsed.",
    fix: "Already auto-fixed.",
    canAutoFix: true,
  },
  TEXT_TM_SUPERSCRIPT: {
    title: "Trademark/registered marks superscripted",
    plain: "®, ™, and © characters now display as superscript per typesetting convention.",
    fix: "Already auto-fixed.",
    canAutoFix: true,
  },

  // ---- True errors (block-publish; must address) ----
  IMG_LOW_RES: {
    title: "Images below print resolution",
    plain: "One or more placed images have an effective resolution below 300dpi. Print output will look pixelated/soft.",
    fix: "Replace each listed asset with a higher-resolution version, then re-import. The 'effective dpi' is the source ppi divided by the placement scale, so don't enlarge a 72dpi image to fix it — get a real high-res file.",
    severity: "error",
    canAutoFix: false,
  },
  LINK_MISSING: {
    title: "Missing linked assets",
    plain: "InDesign expects to find linked image/asset files at specific paths but they're missing.",
    fix: "Open Window → Links in InDesign. For each missing item, click the broken-link icon and re-link to the correct file. Without these, the print/export will use placeholder previews.",
    severity: "error",
    canAutoFix: false,
  },
  FONT_UNAVAILABLE: {
    title: "Fonts not properly installed",
    plain: "Fonts used in the document aren't activated on this machine. InDesign substitutes which changes line breaks and styling.",
    fix: "Activate via Adobe Fonts (Creative Cloud → Fonts) or install the system font. If you don't have a license, replace with an equivalent font and update paragraph styles.",
    severity: "error",
    canAutoFix: false,
  },
  TEXT_OVERSET: {
    title: "Text overflowing its frame",
    plain: "Some text frames have content that doesn't fit. Hidden text won't print — it's a real production blocker.",
    fix: "Open the .indd, find the red '+' on the bottom-right of the offending frame, then either resize the frame, reduce content, or thread to an additional frame.",
    severity: "error",
    canAutoFix: false,
  },

  // ---- Warnings (review and decide) ----
  HYPERLINK_TEXT_MISMATCH: {
    title: "Hyperlink text doesn't match destination",
    plain: "Cells display one URL/email but actually link somewhere else. Common cause: copied a row and forgot to update the link target. Anyone clicking goes to the wrong place.",
    fix: "Open Window → Hyperlinks in InDesign. For each listed mismatch, either update the URL field to match the displayed text, or update the displayed text to match the URL — whichever is correct.",
    severity: "warning",
    canAutoFix: false,
  },
  HYPERLINK_BROKEN: {
    title: "Hyperlink returns an error",
    plain: "The destination URL responded with a 4xx/5xx HTTP status — it's broken or moved.",
    fix: "Verify the URL in a browser. Update or remove the hyperlink in InDesign (Window → Hyperlinks).",
    severity: "warning",
    canAutoFix: false,
  },
  HYPERLINK_UNREACHABLE: {
    title: "Hyperlink couldn't be reached",
    plain: "The destination didn't respond. Could be a network issue, or the site is down/blocking probes.",
    fix: "Re-test in a browser. If it's reachable manually, this is a false positive (some sites block HEAD requests). If not, update or remove.",
    severity: "warning",
    canAutoFix: false,
  },
  URL_NOT_HYPERLINKED: {
    title: "URL-like text without an active hyperlink",
    plain: "Found text that looks like a URL but isn't clickable. Readers can't click through.",
    fix: "In InDesign, select the URL text → Window → Hyperlinks → New Hyperlink From URL.",
    severity: "warning",
    canAutoFix: false,
  },
  STYLE_PARA_OVERRIDES: {
    title: "Paragraphs overriding their style",
    plain: "Paragraphs have direct formatting (font, size) that diverges from their applied paragraph style. This causes visual inconsistency.",
    fix: "In InDesign, select the paragraph → check the Paragraph Styles panel for a '+' next to the style name → click 'Clear Overrides' if the override was unintentional.",
    severity: "warning",
    canAutoFix: false,
  },
  STYLE_COLOR_MISMATCH: {
    title: "Paragraph color overrides",
    plain: "Some paragraphs are using a fill color that differs from their applied style's color.",
    fix: "Verify the override is intentional (e.g., a deliberately colored heading). If not, clear the local override.",
    severity: "warning",
    canAutoFix: false,
  },
  FONT_TOO_MANY: {
    title: "Many distinct fonts in document",
    plain: "Documents with more than 4 fonts feel inconsistent. Consider consolidating.",
    fix: "Review which fonts are used where; reduce to a primary + secondary pair.",
    severity: "warning",
    canAutoFix: false,
  },
  COLOR_RGB_SWATCH: {
    title: "RGB swatches in a print document",
    plain: "RGB colors will be converted at output and may shift visually. CMYK is the right space for print.",
    fix: "InDesign → Window → Color → Swatches. Double-click each RGB swatch and switch its color mode to CMYK. Or convert globally via Edit → Convert to Profile.",
    severity: "warning",
    canAutoFix: false,
  },
  COLOR_RICH_BLACK_SMALL: {
    title: "Rich black on small text",
    plain: "Body text under 14pt using rich black (any CMY value combined with K=100) registers poorly on press — small letters look soft or fuzzy.",
    fix: "Change those text runs to 100% K only (C=0 M=0 Y=0 K=100). Black headlines/large display text are fine to leave rich.",
    severity: "warning",
    canAutoFix: false,
  },
  TEXT_HYPHEN_VS_DASH: {
    title: "Hyphen possibly should be en-dash",
    plain: "Found patterns like 'word - word' (hyphen with spaces). This is typically incorrect — should usually be an en-dash (–) for ranges/parenthetical breaks.",
    fix: "Find/Change in InDesign: ' - ' → ' – ' where appropriate.",
    severity: "warning",
    canAutoFix: false,
  },
  TEXT_EMPTY_PARAS: {
    title: "Empty paragraphs",
    plain: "Multiple consecutive return characters with no content. Sometimes intentional (spacing), sometimes leftover from cleanup.",
    fix: "Review each location. If used for spacing, prefer 'space after paragraph' setting on the paragraph style instead.",
    severity: "warning",
    canAutoFix: false,
  },
  DOC_NO_BLEED: {
    title: "No bleed configured",
    plain: "Document has 0 bleed on all sides. Print jobs that go to the edge need a bleed (typically 0.125\") to allow for trim variation.",
    fix: "File → Document Setup → set Bleed to 0.125\" all around. Then extend bleeding artwork past the trim.",
    severity: "warning",
    canAutoFix: false,
  },
  LINK_OUT_OF_DATE: {
    title: "Linked assets out of date",
    plain: "A linked file on disk has been modified since InDesign last imported it. The current view may not reflect what's on disk.",
    fix: "Window → Links → click the yellow triangle on each item to update.",
    severity: "warning",
    canAutoFix: false,
  },
  SPELLCHECK_SUSPICIOUS: {
    title: "Possible spelling issues",
    plain: "Words not found in the dictionary. Many will be proper nouns, company names, or domain terms — those are false positives.",
    fix: "Review the list. For any genuine typos, fix in InDesign. For correct-but-flagged words, you can ignore or add to a personal dictionary.",
    severity: "warning",
    canAutoFix: false,
  },

  // ---- Info (just inventory) ----
  HYPERLINK_INVENTORY: {
    title: "Hyperlinks count",
    plain: "Total hyperlinks in the document. FYI only.",
    fix: "—",
    canAutoFix: false,
  },
  IMG_COUNT: {
    title: "Image count",
    plain: "Total placed graphics in the document. FYI only.",
    fix: "—",
    canAutoFix: false,
  },
  FONT_INVENTORY: {
    title: "Fonts in use",
    plain: "List of all fonts referenced by the document.",
    fix: "—",
    canAutoFix: false,
  },
  COLOR_SPOT_COLORS: {
    title: "Spot colors present",
    plain: "Spot/Pantone colors are defined in the document.",
    fix: "Confirm intentional. If the job is process-only (CMYK), convert spots to process via Window → Color → Swatches.",
    canAutoFix: false,
  },
  DOC_COLOR_PROFILE: {
    title: "Document color profile",
    plain: "The CMYK and RGB profiles configured for the doc.",
    fix: "—",
    canAutoFix: false,
  },
  DOC_DIMENSIONS: {
    title: "Document dimensions",
    plain: "Page count and page size.",
    fix: "—",
    canAutoFix: false,
  },
  DOC_BLEED: {
    title: "Bleed settings",
    plain: "Configured bleed on each side.",
    fix: "—",
    canAutoFix: false,
  },
  LAYER_HIDDEN_WITH_CONTENT: {
    title: "Hidden layers with content",
    plain: "Layers are turned off but contain page items. Content won't print/export. Sometimes intentional (alt-version layers), sometimes forgotten.",
    fix: "Window → Layers. Verify each hidden layer is intentionally off.",
    canAutoFix: false,
  },
  ITEM_LOCKED: {
    title: "Locked items",
    plain: "Some page items have the lock icon — can't be edited until unlocked.",
    fix: "Object → Unlock All on Spread, or click the padlock in the Layers panel.",
    canAutoFix: false,
  },
  MASTER_OVERRIDES: {
    title: "Master-page overrides",
    plain: "Items inherited from master pages have been individually overridden on document pages.",
    fix: "Verify each is intentional. To revert, right-click the item → Object → 'Remove All Local Overrides' (on master items).",
    canAutoFix: false,
  },
  DOC_OVERPRINT_PREF: {
    title: "Overprint preferences",
    plain: "Overprint configuration metadata.",
    fix: "—",
    canAutoFix: false,
  },
};

// Expose to renderer (Electron with Node integration scopes top-level const per-script)
if (typeof window !== "undefined") window.FINDING_META = FINDING_META;
if (typeof module !== "undefined") module.exports = FINDING_META;
