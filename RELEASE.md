# Release and Distribution Guide

This guide explains how to build, test, and release the React Example App across macOS, Windows, and Linux platforms.

## Quick Start

### Local Development Build

```bash
# Start development server
npm run dev

# Build for production
npm run build
```

### Local Platform-Specific Builds

#### macOS (DMG)
```bash
./build.sh
# or
npm run build-electron-mac
```

#### Windows (EXE)
```bash
# PowerShell
./build.bat
# or
npm run build-electron-win
```

#### Linux (DEB)
```bash
./build.sh
# or
npm run build-electron-linux
```

## Release Process

### 1. Prepare Release

1. Update version in `package.json`:
   ```json
   {
     "version": "1.0.0"
   }
   ```

2. Update `CHANGELOG.md` with release notes

3. Commit changes:
   ```bash
   git add .
   git commit -m "Release: v1.0.0"
   ```

### 2. Create Release Tag

```bash
git tag v1.0.0
git push origin v1.0.0
```

This triggers the GitHub Actions workflow which will:
- Build for macOS on `macos-latest`
- Build for Windows on `windows-latest`
- Build for Linux on `ubuntu-latest`
- Automatically create a GitHub Release with all artifacts

### 3. Verify Builds

Visit the [Actions](../../actions) tab to monitor build progress:

- Green checkmark ✓ = Build successful
- Red X ✗ = Build failed (check logs)

### 4. Verify Release

Check the GitHub [Releases](../../releases) page:

- Should have DMG + ZIP for macOS
- Should have EXE installers for Windows
- Should have DEB + AppImage for Linux

## Build Artifacts Explained

### macOS
- **React Example App-X.X.X.dmg** - Standard macOS installer
- **React Example App-X.X.X-mac.zip** - Portable ZIP archive

### Windows
- **React Example App X.X.X.exe** - NSIS installer (recommended)
- **React Example App X.X.X.exe** - Portable executable (in portable/ folder)

### Linux
- **react-example_X.X.X_amd64.deb** - Debian package (Ubuntu, Linux Mint, etc.)
- **React Example App-X.X.X.AppImage** - Universal Linux binary

## Installation Instructions for Users

### macOS
1. Download `React Example App-X.X.X.dmg`
2. Open the DMG file
3. Drag app to Applications folder
4. Launch from Applications

### Windows
1. Download `React Example App X.X.X.exe`
2. Run the installer
3. Follow installation wizard
4. Launch from Start Menu

### Linux

#### Ubuntu/Debian
```bash
sudo apt install ./react-example_X.X.X_amd64.deb
react-example-app
```

#### Any Linux Distribution
1. Download `React Example App-X.X.X.AppImage`
2. Make executable: `chmod +x React\ Example\ App-X.X.X.AppImage`
3. Run: `./React\ Example\ App-X.X.X.AppImage`

## Troubleshooting Release Builds

### Build Fails on macOS

**Issue**: Code signing error

**Solution**: The workflow uses `CSC_IDENTITY_AUTO_DISCOVERY=false` to skip code signing. If you need to sign:

1. Get a Developer ID certificate
2. Export to `.p12` file
3. Add to GitHub Secrets:
   - `CSC_LINK` (path to certificate)
   - `CSC_KEY_PASSWORD` (certificate password)
4. Remove the env var from workflow

### Build Fails on Windows

**Issue**: NSIS installer build error

**Solution**: Ensure `nsis` is listed in devDependencies and electron-builder is v24+

### Build Fails on Linux

**Issue**: Missing dependencies

**Solution**: The workflow installs required tools. If running locally, install:
```bash
sudo apt-get install build-essential libssl-dev libffi-dev python3-dev
```

## Automated Release Notes

GitHub Actions automatically adds this to releases:

```markdown
## Cross-Platform Build Artifacts

This release includes builds for:
- **macOS**: DMG installer and ZIP archive
- **Windows**: EXE installer and portable executable
- **Linux**: DEB package and AppImage

See [BUILD.md](BUILD.md) for installation instructions.
```

Customize release notes by editing `.github/workflows/build.yml`

## Manual Release (If CI/CD Fails)

If GitHub Actions fails, you can manually build on each platform:

### On macOS
```bash
CSC_IDENTITY_AUTO_DISCOVERY=false npm run build-electron-mac
# Creates: dist-electron/*.dmg
```

### On Windows
```bash
npm run build-electron-win
# Creates: dist-electron/*.exe
```

### On Linux
```bash
npm run build-electron-linux
# Creates: dist-electron/*.deb and *.AppImage
```

Then manually upload to GitHub Releases:
```bash
gh release create v1.0.0 dist-electron/*
```

## Auto-Update (Optional)

To enable in-app updates, configure electron-updater:

1. Install: `npm install electron-updater`

2. Update main.ts:
```typescript
import { autoUpdater } from 'electron-updater';

app.on('ready', () => {
  autoUpdater.checkForUpdatesAndNotify();
  createWindow();
});
```

3. Ensure releases are uploaded to GitHub

## Distribution Channels

### Option 1: GitHub Releases (Recommended)
- Free
- Direct download links
- Auto-update support
- Public visibility

### Option 2: Package Managers

#### macOS (Homebrew)
```bash
brew install --cask react-example-app
```
Requires Brew formula submission

#### Windows (Chocolatey)
Requires Chocolatey package submission

#### Linux (Official Repos)
Varies by distribution

## Version Management

Follow [Semantic Versioning](https://semver.org/):
- `v1.0.0` - Major.Minor.Patch
- `v1.0.0-alpha.1` - Pre-release
- `v1.0.0+build.123` - Build metadata

## Monthly Build Verification

To keep CI/CD working, manually trigger builds monthly:

1. Go to [Actions](../../actions)
2. Select "Build and Release Desktop App"
3. Click "Run workflow"
4. Select branch: "main"
5. Verify all builds complete successfully

## Monitoring and Alerts

### Check Status
```bash
# View latest workflow runs
gh run list --workflow=build.yml --limit=5

# View specific run details
gh run view <run-id>
```

### Enable Notifications
GitHub notifies you of:
- Workflow failures
- Release creation
- Security alerts

Configure in Settings → Notifications

## References

- [electron-builder docs](https://www.electron.build/)
- [GitHub Actions docs](https://docs.github.com/en/actions)
- [Semantic Versioning](https://semver.org/)
- [Keep a Changelog](https://keepachangelog.com/)
