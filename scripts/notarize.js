/**
 * afterSign hook: submits the just-signed Production Buddy.app to Apple's
 * notary service. Runs AFTER electron-builder finishes codesigning, BEFORE
 * the DMG is assembled. Uses the same NOTARIZE_* env-var convention as
 * FillThatPDF (see comments below).
 *
 * Tries methods in priority order:
 *   1. Environment variables: NOTARIZE_APPLE_ID + NOTARIZE_APP_PASSWORD + NOTARIZE_TEAM_ID
 *      Uniquely named so electron-builder's auto-detection (which greps for
 *      APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD / APPLE_TEAM_ID) does NOT see them
 *      and activate its buggy built-in notarizer (crashes with "Cannot
 *      destructure property 'appBundleId'"). Set these in ~/.zshrc.
 *   2. Keychain profile "ProductionBuddy" — fallback. Requires the login
 *      keychain to be unlocked; auto-lock can break long builds mid-way.
 */
const { notarize } = require("@electron/notarize");
const path = require("path");

exports.default = async function (context) {
    const { electronPlatformName, appOutDir } = context;
    if (electronPlatformName !== "darwin") {
        console.log("[notarize] not macOS — skip");
        return;
    }

    const appName = context.packager.appInfo.productFilename;
    const appPath = path.join(appOutDir, `${appName}.app`);

    // --- Method 1: env vars (preferred — no keychain dependency) ---
    const envAppleId = process.env.NOTARIZE_APPLE_ID;
    const envPassword = process.env.NOTARIZE_APP_PASSWORD;
    const envTeamId = process.env.NOTARIZE_TEAM_ID;
    if (envAppleId && envPassword && envTeamId) {
        try {
            console.log(`🔐 Notarizing ${appName} via NOTARIZE_* env vars…`);
            console.log(`   App: ${appPath}`);
            await notarize({
                tool: "notarytool",
                appPath,
                appleId: envAppleId,
                appleIdPassword: envPassword,
                teamId: envTeamId,
            });
            console.log("✅ Notarization complete!");
            return;
        } catch (err) {
            console.warn(`⚠️  Env-var notarization failed: ${err.message}`);
            console.log("Falling back to keychain profile…");
        }
    }

    // --- Method 2: keychain profile (fallback) ---
    const KEYCHAIN_PROFILE = "ProductionBuddy";
    try {
        console.log(`🔐 Notarizing ${appName} via keychain profile "${KEYCHAIN_PROFILE}"…`);
        await notarize({
            tool: "notarytool",
            appPath,
            keychainProfile: KEYCHAIN_PROFILE,
        });
        console.log("✅ Notarization complete!");
        return;
    } catch (err) {
        console.error(`⚠️  Keychain-profile notarization failed: ${err.message}`);
    }

    console.log("⚠️  Notarization skipped — no valid credentials.");
    console.log("   The app is code-signed but not notarized. Set NOTARIZE_* env vars.");
};
