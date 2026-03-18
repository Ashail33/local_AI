#!/bin/bash

# Build script for React Example App
# Determines the platform and builds accordingly

set -e

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
cd "$SCRIPT_DIR"

echo "================================"
echo "React Example App Build Script"
echo "================================"
echo ""

# Detect platform
if [[ "$OSTYPE" == "darwin"* ]]; then
    PLATFORM="macOS"
elif [[ "$OSTYPE" == "linux-gnu"* ]]; then
    PLATFORM="Linux"
elif [[ "$OSTYPE" == "msys" || "$OSTYPE" == "cygwin" ]]; then
    PLATFORM="Windows"
else
    PLATFORM="Unknown"
fi

echo "Detected Platform: $PLATFORM"
echo ""

# Check if npm is installed
if ! command -v npm &> /dev/null; then
    echo "ERROR: npm is not installed"
    exit 1
fi

# Function to print commands
run_command() {
    echo "Running: $@"
    "$@"
}

case "$PLATFORM" in
    macOS)
        echo "Building for macOS (DMG)..."
        echo "This will create a .dmg installer and .zip archive"
        echo ""
        run_command npm run build-electron-mac
        echo ""
        echo "✓ macOS build complete!"
        echo "Outputs are in: dist-electron/"
        ls -lh dist-electron/ | grep -E "\.(dmg|zip)$"
        ;;
    Linux)
        echo "Building for Linux (DEB)..."
        echo "This will create .deb and .AppImage artifacts"
        echo ""
        run_command npm run build-electron-linux
        echo ""
        echo "✓ Linux build complete!"
        echo "Outputs are in: dist-electron/"
        ls -lh dist-electron/ | grep -E "\.(deb|AppImage)$"
        ;;
    Windows)
        echo "Building for Windows (EXE)..."
        echo "This will create .exe installer and portable executable"
        echo ""
        run_command npm run build-electron-win
        echo ""
        echo "✓ Windows build complete!"
        echo "Outputs are in: dist-electron/"
        ls -lh dist-electron/ | grep -E "\.exe$"
        ;;
    *)
        echo "ERROR: Unable to determine platform"
        echo "Please run the appropriate build command manually:"
        echo "  macOS:  npm run build-electron-mac"
        echo "  Windows: npm run build-electron-win"
        echo "  Linux:  npm run build-electron-linux"
        exit 1
        ;;
esac

echo ""
echo "Build artifacts saved to: $SCRIPT_DIR/dist-electron/"
echo ""
