# Build Guide for React Example App

This guide explains how to build and package the React Example App for macOS (DMG), Windows (EXE), and Linux (DEB/AppImage).

## Prerequisites

- Node.js 18+ (already installed)
- npm or yarn
- For macOS: macOS 10.13+
- For Windows: Windows 7+
- For Linux: Ubuntu 18.04+ or equivalent

## Build Commands

### Development Build (Vite)

```bash
npm run build
```

This builds the React application using Vite, outputting to the `dist/` directory.

### Production Build - All Platforms

To build for all platforms (requires the appropriate OS):

```bash
npm run build-electron-all
```

Note: Cross-platform builds work only on their native OS:
- macOS can build DMG and other Apple formats
- Windows can build EXE and other Windows formats
- Linux can build DEB and AppImage

### Platform-Specific Builds

#### macOS (DMG)

```bash
npm run build-electron-mac
```

Generates:
- `dist-electron/React Example App-0.0.0.dmg` - macOS installer
- `dist-electron/React Example App-0.0.0-mac.zip` - Portable archive

**Requirements**: Must run on macOS

#### Windows (EXE)

```bash
npm run build-electron-win
```

Generates:
- `dist-electron/React Example App 0.0.0.exe` - NSIS installer
- `dist-electron/React Example App 0.0.0.exe` - Portable executable

**Requirements**: Must run on Windows

#### Linux (DEB/AppImage)

```bash
npm run build-electron-linux
```

Generates:
- `dist-electron/react-example_0.0.0_amd64.deb` - Debian package
- `dist-electron/React Example App-0.0.0.AppImage` - AppImage

**Requirements**: Must run on Linux (tested on Ubuntu 18.04+)

## Build Directory Structure

After running a build, the `dist-electron/` directory contains:

```
dist-electron/
├── builder-debug.yml          # Build configuration debug info
├── latest-[platform].yml      # Auto-update metadata
├── [packaged-files]           # Platform-specific installers
└── [platform]-unpacked/       # Unpacked application files
```

## Configuration

The build configuration is defined in `package.json` under the `build` field:

### Key Settings

- **appId**: `com.example.reactapp` - Unique application identifier
- **productName**: `React Example App` - Display name
- **Author**: Set in package.json (required for Linux builds)

### Platform-Specific Configuration

#### macOS (DMG)
- **Target**: DMG (installer) + ZIP (archive)
- **Category**: `public.app-category.utilities`
- **DMG Layout**: Includes Applications folder link

#### Windows (EXE)
- **Target**: NSIS (installer) + Portable EXE
- **NSIS Options**:
  - One-click installation disabled (allows custom install path)
  - Desktop shortcut creation
  - Start menu shortcut creation

#### Linux (DEB/AppImage)
- **Target**: DEB package + AppImage
- **Category**: `Utility`
- **Maintainer**: Taken from author field in package.json

## Troubleshooting

### "Please specify author 'email' in the application package.json"

**Solution**: Ensure `package.json` has an author field:
```json
"author": "Your Name <your.email@example.com>"
```

### Build fails on macOS with code signing issues

**Solution**: Either:
1. Disable code signing by setting environment variable:
   ```bash
   export CSC_IDENTITY_AUTO_DISCOVERY=false
   npm run build-electron-mac
   ```
2. Provide a valid signing certificate

### Build fails on Windows

**Solution**: Ensure you're running Command Prompt or PowerShell as Administrator.

### Large file warnings during build

The build may show warnings about chunk sizes over 500kB. This is normal but consider optimizing with:

```javascript
// In vite.config.ts
build: {
  rollupOptions: {
    output: {
      manualChunks: {
        // Define chunk strategy
      }
    }
  }
}
```

## File Outputs

| Platform | Format | Location | Typical Size |
|----------|--------|----------|--------------|
| macOS | DMG | `dist-electron/*.dmg` | ~150-200 MB |
| macOS | ZIP | `dist-electron/*.zip` | ~150-200 MB |
| Windows | EXE (NSIS) | `dist-electron/*.exe` | ~120-150 MB |
| Windows | Portable EXE | `dist-electron/*.exe` | ~120 MB |
| Linux | DEB | `dist-electron/*.deb` | ~120-150 MB |
| Linux | AppImage | `dist-electron/*.AppImage` | ~120-150 MB |

## Continuous Integration (CI/CD)

For automated builds on CI/CD servers, set the environment variable:

```bash
export CSC_IDENTITY_AUTO_DISCOVERY=false
npm run build-electron-all
```

This disables code signing requirements, allowing builds on any platform.

## Next Steps

1. Add application icons (place in `assets/` directory)
2. Configure auto-updates (see electron-updater documentation)
3. Add digital certificates for production releases
4. Set up CI/CD pipeline for automated builds

## Resources

- [electron-builder Documentation](https://www.electron.build/)
- [Electron Security Recommendations](https://www.electronjs.org/docs/tutorial/security)
- [Signing macOS Applications](https://www.electron.build/code-signing)
