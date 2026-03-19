/**
 * electron-builder afterPack hook
 *
 * Applies an ad-hoc code signature to the macOS .app bundle after packing
 * but before the DMG is created.  This prevents macOS Gatekeeper from
 * reporting "app is damaged and can't be opened" when the DMG is downloaded
 * and opened on a Mac without a paid Apple Developer certificate.
 */
const { execSync } = require('child_process');
const path = require('path');

exports.default = async (context) => {
  if (context.electronPlatformName !== 'darwin') {
    return;
  }

  const appName = context.packager.appInfo.productFilename;
  const appPath = path.join(context.appOutDir, `${appName}.app`);

  console.log(`[after-pack] Ad-hoc signing: ${appPath}`);
  try {
    execSync(`codesign --deep --force --sign - "${appPath}"`, { stdio: 'inherit' });
    console.log('[after-pack] Ad-hoc signing complete.');
  } catch (err) {
    // Non-fatal: warn but don't block the build
    console.warn('[after-pack] Ad-hoc signing failed (non-fatal):', err.message);
  }
};
