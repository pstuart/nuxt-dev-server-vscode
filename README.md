# Nuxt Dev Server Manager

[![CI](https://github.com/pstuart/nuxt-dev-server-vscode/actions/workflows/ci.yml/badge.svg)](https://github.com/pstuart/nuxt-dev-server-vscode/actions/workflows/ci.yml)
[![Version](https://img.shields.io/visual-studio-marketplace/v/pstuart.nuxt-dev-server)](https://marketplace.visualstudio.com/items?itemName=pstuart.nuxt-dev-server)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A Visual Studio Code extension to manage Nuxt development servers directly from the status bar.

## Features

- **Status Bar Integration** - Shows the number of running Nuxt instances at a glance
- **Start/Stop/Restart** - Control your dev server with simple commands
- **Process Management** - View and manage all running Nuxt instances
- **Multi-Instance Support** - List all Nuxt servers and selectively kill specific ones
- **Auto-Detection** - Automatically detects your package manager (npm, yarn, pnpm, bun)
- **Port Detection** - Extracts and displays the running server port
- **Version Info** - View installed and running Nuxt versions
- **Quick Browser Access** - Open your dev server in the browser with one click

## Usage

### Status Bar

Click the Nuxt status bar item (lower left) to access all commands via quick pick menu.

The status bar shows:
- `⚡ Nuxt Dev (n)` - When your managed server is running (n = total instances)
- `⚡ Nuxt (n)` - When other Nuxt instances are detected
- `⊘ Nuxt Dev` - When no server is running

### Commands

All commands are available via the Command Palette (`Cmd+Shift+P` / `Ctrl+Shift+P`):

- **Nuxt: Start Dev Server** - Start the dev server in current workspace
- **Nuxt: Stop Dev Server** - Stop the managed dev server
- **Nuxt: Restart Dev Server** - Restart the managed dev server
- **Nuxt: Show All Running Instances** - Display detailed information about all running Nuxt servers
- **Nuxt: List and Kill Instances** - View all running Nuxt processes and select which to kill
- **Nuxt: Kill All Running Instances** - Kill all Nuxt processes on the system
- **Nuxt: Open in Browser** - Open the dev server URL in your browser
- **Nuxt: Show Version** - Display detailed Nuxt version information (declared, installed, and running)

### Show All Running Instances

View detailed information about all running Nuxt servers:
- PID (Process ID)
- Port and URL (e.g., http://localhost:3000)
- Working directory
- Full command
- Opens in a dedicated output panel for easy viewing

### List and Kill Instances

The extension can detect all running Nuxt dev and preview servers on your Mac:
- Shows PID, port, and working directory for each instance
- Multi-select to kill specific instances
- Useful when you have multiple projects running

### Accurate Process Counting

The extension now uses port-based detection to accurately count running instances:
- Only counts processes actually listening on ports
- Avoids counting duplicate/child processes
- Each port can only have one listening process

### Version Detection

The extension shows comprehensive version information:
- **Declared**: Version range from package.json (e.g., `^3.10.0`)
- **Installed**: Actual version in node_modules (e.g., `3.10.3`)
- **Running**: Version for each active server (handles multiple projects)

This helps identify version mismatches and ensures you know exactly which Nuxt version is running.

## Requirements

- macOS (currently Mac-only)
- Nuxt project with `nuxt.config.{js,ts,mjs,mts}`
- Node.js and npm/yarn/pnpm/bun

## Extension Settings

This extension does not currently add any VS Code settings.

## Known Issues

- Currently only supports macOS (uses `ps`, `lsof`, `pkill`)
- Port detection may not work for all configurations
- Working directory detection requires `lsof` permission

## Installation

### From VS Code Marketplace

1. Open VS Code
2. Go to Extensions (Cmd+Shift+X / Ctrl+Shift+X)
3. Search for "Nuxt Dev Server Manager"
4. Click Install

### From VSIX File

```bash
code --install-extension nuxt-dev-server-0.0.2.vsix
```

## Development

### Building and Packaging

```bash
# Install dependencies
npm install

# Compile TypeScript
npm run compile

# Watch for changes (development)
npm run watch

# Package the extension (compiles first)
npm run package:do

# Bump version (patch) and package
npm run package

# Bump version manually
npm run version:patch  # 0.0.2 -> 0.0.3
npm run version:minor  # 0.0.2 -> 0.1.0
npm run version:major  # 0.0.2 -> 1.0.0
```

### Publishing to Marketplace

See [PUBLISHING.md](PUBLISHING.md) for detailed instructions on:
- Setting up your publisher account
- Creating and configuring PAT tokens
- Publishing via GitHub Actions
- Manual publishing with vsce

## Release Notes

### 0.0.1

Initial release with core features:
- Status bar integration
- Start/stop/restart commands
- Multi-instance tracking and selective killing
- Version detection
- Browser integration
- Accurate port-based process detection

## License

MIT License - See LICENSE file for details

## Author

Patrick Stuart

---

**Enjoy managing your Nuxt dev servers!**