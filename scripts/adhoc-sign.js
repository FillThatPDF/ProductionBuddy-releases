// Re-sign the packaged .app with an ad-hoc signature ("-" identity) AFTER
// electron-builder finishes. Without this, Squirrel.Mac's update validation
// fails with:
//   "Code signature at URL ... did not pass validation:
//    code has no resources but signature indicates they must be present"
// because electron-builder leaves a stale signature pointing at resources
// that get reorganized during packaging. Ad-hoc signing fresh ("--force
// --deep --sign -") writes a complete, internally consistent signature
// that Squirrel can validate.
//
// We do NOT need a Developer ID — Apple allows ad-hoc signatures, and
// Squirrel.Mac is happy as long as the signature is internally valid.
// Gatekeeper still asks the user to right-click → Open on first launch
// (because the signature isn't from a registered developer), but that's
// a one-time cost.
const { execSync } = require("child_process");
const path = require("path");

exports.default = async function (context) {
  if (context.electronPlatformName !== "darwin") return;
  const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  console.log(`[adhoc-sign] re-signing ${appPath} with ad-hoc identity`);
  try {
    execSync(
      `codesign --force --deep --sign - "${appPath}"`,
      { stdio: "inherit" }
    );
    // Verify the signature is internally consistent (catches stale-resource issues)
    execSync(
      `codesign --verify --deep --strict "${appPath}"`,
      { stdio: "inherit" }
    );
    console.log("[adhoc-sign] ✓ signature valid");
  } catch (err) {
    console.error("[adhoc-sign] FAILED:", err.message);
    throw err;
  }
};
