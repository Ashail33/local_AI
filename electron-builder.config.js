/**
 * Electron Builder configuration.
 * This file takes precedence over the "build" key in package.json.
 * @type {import('electron-builder').Configuration}
 */
export default {
  appId: 'com.example.reactapp',
  productName: 'React Example App',
  directories: {
    output: 'dist-electron',
  },
  files: [
    'dist/**/*',
    'package.json',
  ],

  // macOS DMG configuration
  mac: {
    target: [{ target: 'dmg', arch: ['x64', 'arm64'] }],
    category: 'public.app-category.productivity',
  },
  dmg: {
    contents: [
      { x: 130, y: 220 },
      { x: 410, y: 220, type: 'link', path: '/Applications' },
    ],
    window: { width: 540, height: 380 },
  },

  // Windows NSIS installer configuration
  win: {
    target: [{ target: 'nsis', arch: ['x64'] }],
  },
  nsis: {
    oneClick: false,
    allowToChangeInstallationDirectory: true,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
  },

  // Linux DEB package configuration
  linux: {
    target: [{ target: 'deb', arch: ['x64'] }],
    category: 'Utility',
  },
};
