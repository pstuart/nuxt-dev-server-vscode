# Nuxt Dev Server Manager

[![Version](https://img.shields.io/visual-studio-marketplace/v/pstuart.nuxt-dev-server)](https://marketplace.visualstudio.com/items?itemName=pstuart.nuxt-dev-server)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A Visual Studio Code extension to manage Nuxt development servers directly from the status bar.

## Features

- **Status Bar Integration** - Shows the number of running Nuxt instances at a glance
- **Start/Stop/Restart** - Control your dev server with simple commands
- **Graceful Shutdown** - Tries SIGTERM before SIGKILL for cleaner process termination
- **Process Management** - View and manage all running Nuxt instances
- **Multi-Instance Support** - List all Nuxt servers and selectively kill specific ones
- **Auto-Detection** - Automatically detects your package manager (npm, yarn, pnpm, bun)
- **Port Detection** - Extracts and displays the running server port
- **Version Info** - View installed and running Nuxt versions
- **Quick Browser Access** - Open your dev server in the browser with one click
- **Auto-Kill Features** - Automatically kill servers after timeout or idle time
- **Activity Tracking** - Monitors file changes to detect idle servers
- **Configurable Settings** - Customize timeout, intervals, and behavior
- **Security Hardened** - PID validation, safe JSON parsing, input sanitization, Workspace Trust gates on start and process kills

## Usage

### Status Bar

Click the Nuxt status bar item (lower left) to access all commands via quick pick menu.

The status bar shows:
- `$(radio-tower) Nuxt Dev :port (n)` - When your managed server is running (port is the listening port, n is the total instance count)
- `⚡ Nuxt (n)` - When other Nuxt instances are detected
- `⊘ Nuxt Dev` - When no server is running

### Commands

All commands are available via the Command Palette (`Cmd+Shift+P` / `Ctrl+Shift+P`):

- **Nuxt: Build** - Run the build script, streaming output to Nuxt Build with exit-code notification
- **Nuxt: Generate** - Run the generate script with the same output and notifications
- **Nuxt: Preview Production Build** - Run the preview script as the managed server; Stop, Restart and Open in Browser also work on preview
- **Nuxt: Start Dev Server** - Start the dev server in current workspace
- **Nuxt: Start Dev Server (Debug)** - Start the dev script under the VS Code JavaScript debugger so server-side breakpoints bind
- **Nuxt: Stop Dev Server** - Stop the managed dev server
- **Nuxt: Restart Dev Server** - Restart the managed dev server
- **Nuxt: Show All Running Instances** - Display detailed information about all running Nuxt servers
- **Nuxt: List and Kill Instances** - View all running Nuxt processes and select which to kill
- **Nuxt: Kill All Running Instances** - Kill all Nuxt processes on the system
- **Nuxt: Open in Browser** - Open the dev server URL in your browser
- **Nuxt: Open Preview in Editor** - Open the dev server URL in a VS Code Simple Browser tab, regardless of `nuxt-dev-server.browserType`
- **Nuxt: Show Version** - Display detailed Nuxt version information (declared, installed, and running)
- **Nuxt: Show Quick Menu** - Quick pick menu with all commands (also triggered by clicking the status bar item)

### Keyboard Shortcuts

- `Cmd+Alt+N S` (`Ctrl+Alt+N S` on Windows/Linux) - Start Dev Server
- `Cmd+Alt+N X` - Stop Dev Server
- `Cmd+Alt+N R` - Restart Dev Server
- `Cmd+Alt+N O` - Open in Browser

### Show All Running Instances

View detailed information about all running Nuxt servers:
- PID (Process ID)
- Port and URL (e.g., http://localhost:3000)
- Working directory
- Full command
- Opens in a dedicated output panel for easy viewing

### List and Kill Instances

The extension can detect all running Nuxt dev and preview servers:

- Shows PID, port, and working directory for each instance
- Multi-select to kill specific instances
- Useful when you have multiple projects running

Stopping now terminates the full process tree (wrapper and listening
descendants) rather than only direct children, missing PIDs are treated as
already gone, and a failed stop aborts a follow-up restart instead of spawning
a duplicate server.

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

## Restricted Mode / Workspace Trust

This extension has **limited** support in VS Code Restricted Mode (`capabilities.untrustedWorkspaces`).

Until you trust the folder:

- **Build**, **Generate**, **Preview Production Build** and **Start Dev Server** are refused (it would run `npm`/`yarn`/`pnpm`/`bun` from the workspace)
- **Kill All** and **List and Kill** are refused (they send SIGTERM/SIGKILL to Nuxt PIDs)
- **`maxExtraServers` auto-kill** does not terminate extra processes
- Workspace overrides for `autoStartOnOpen`, `devCommand`, `maxExtraServers`, and the auto-kill timeouts are ignored

Read-only actions (show instances, version, status bar) still work. Trust the folder to enable start and kill commands.

## Requirements

- macOS, Linux, or Windows
- Nuxt project with `nuxt.config.{js,ts,mjs,mts}`
- Node.js and npm/yarn/pnpm/bun

## Extension Settings

This extension contributes the following settings (access via `Preferences: Open Settings` or `Cmd/Ctrl + ,`):

### Auto-Kill and Cleanup

- **`nuxt-dev-server.autoKillTimeout`** (default: `0`)
  - Automatically kill servers after X minutes (0 = disabled)
  - Useful for preventing runaway servers that consume resources
  - Example: Set to `120` to kill servers after 2 hours

- **`nuxt-dev-server.autoKillIdleTime`** (default: `0`)
  - Automatically kill servers idle for X minutes (0 = disabled)
  - Idle = no file changes detected in the workspace
  - Example: Set to `30` to kill servers after 30 minutes of inactivity

- **`nuxt-dev-server.enableAutoCleanup`** (default: `false`)
  - Enable automatic cleanup warnings for extra Nuxt servers not managed by this extension
  - Shows notifications when unmanaged servers are detected

- **`nuxt-dev-server.maxExtraServers`** (default: `0`)
  - Maximum number of extra Nuxt servers allowed (0 = unlimited)
  - Automatically kills oldest servers when this limit is exceeded
  - Example: Set to `2` to allow only 2 extra servers beyond your managed one

### Process Management

- **`nuxt-dev-server.gracefulShutdownTimeout`** (default: `5000`)
  - Time to wait (in milliseconds) for graceful shutdown before force killing
  - Min: 1000ms, Max: 30000ms
  - The extension tries SIGTERM first, then SIGKILL after this timeout

### UI and Display

- **`nuxt-dev-server.updateInterval`** (default: `5000`)
  - Status bar update interval in milliseconds
  - Min: 1000ms, Max: 60000ms
  - Lower values = more frequent updates but slightly higher CPU usage

- **`nuxt-dev-server.showNotifications`** (default: `true`)
  - Show notifications for server start/stop events
  - Disable if you prefer a quieter experience

### Advanced

- **`nuxt-dev-server.preferredPackageManager`** (default: `"auto"`)
  - Package manager to use: `auto`, `npm`, `yarn`, `pnpm`, or `bun`
  - `auto` detects from lock files (yarn.lock, pnpm-lock.yaml, bun.lockb/bun.lock)

- **`nuxt-dev-server.devCommand`** (default: `"dev"`)
  - Package.json script name to run (e.g., `"dev"` or `"dev:custom"`)
  - Only alphanumeric characters, dashes, underscores, and colons are allowed
  - Must be shorter than 100 characters

- **`nuxt-dev-server.autoStartOnOpen`** (default: `false`)
  - Automatically start the dev server when the workspace opens

- **`nuxt-dev-server.openBrowserOnStart`** (default: `false`)
  - Open the browser automatically when the server starts
  - The destination follows `nuxt-dev-server.browserType`

- **`nuxt-dev-server.browserType`** (default: `"external"`)
  - Where `Nuxt: Open in Browser` and `openBrowserOnStart` open the dev server URL
  - `"external"` (the default, unchanged behaviour) opens the system browser via `vscode.env.openExternal`
  - `"embedded"` opens a VS Code Simple Browser tab via the built-in `simpleBrowser.show` command (requires a VS Code build that provides it)
  - Any value other than `"embedded"` falls back to the external browser
  - `Nuxt: Open Preview in Editor` ignores this setting and always opens the Simple Browser tab

- **`nuxt-dev-server.debug`** (default: `false`)
  - Enable debug logging to the output channel

- **`nuxt-dev-server.defaultPort`** (default: `3000`)
  - Default port to use if port cannot be detected from output
  - Min: 1, Max: 65535

- **`nuxt-dev-server.port`** (default: `null`)
  - Optional CLI port override; must be an integer. Min: 1, Max: 65535
  - `null` leaves the project's port unchanged; `defaultPort` remains a discovery hint, not a CLI override

- **`nuxt-dev-server.host`** (default: `""`)
  - Optional CLI host override: hostname, IPv4 or IPv6 literal (e.g. `dev.local`, `127.0.0.1`, `::1` or `[::1]`)
  - Empty leaves the project's host unchanged; URLs, whitespace, flags and shell metacharacters are rejected before spawning

- **`nuxt-dev-server.https`** (default: `false`)
  - When true, pass `--https` to Nuxt; false does not force HTTP or override project HTTPS configuration
  - Port-only polling and unmanaged Open in Browser use this scheme and `host` (localhost when empty)

Nuxt's printed `Local:` HTTP/HTTPS URL takes precedence over these fallback settings, including custom hosts and IPv6. A trailing root slash is omitted; paths are retained. Both stdout and stderr are inspected. CLI overrides are passed after `--` for npm and directly for yarn/pnpm/bun. Invalid overrides abort startup rather than being clamped. Changes apply on the next start/restart. HTTPS certificate setup and browser trust remain the project's responsibility; the extension does not generate certificates or disable TLS verification. Unmanaged processes do not expose their printed URL, so their scheme/host require the fallback settings.

## Configuration Examples

### Example 1: Auto-kill idle development servers

Perfect for developers who often forget to stop servers:

```json
{
  "nuxt-dev-server.autoKillIdleTime": 30,
  "nuxt-dev-server.enableAutoCleanup": true
}
```

### Example 2: Limit total servers and set hard timeout

Great for CI/CD environments or shared development machines:

```json
{
  "nuxt-dev-server.maxExtraServers": 1,
  "nuxt-dev-server.autoKillTimeout": 120,
  "nuxt-dev-server.showNotifications": false
}
```

### Example 3: Custom command with fast updates

For specialized setups:

```json
{
  "nuxt-dev-server.devCommand": "dev:custom",
  "nuxt-dev-server.updateInterval": 2000,
  "nuxt-dev-server.gracefulShutdownTimeout": 10000
}
```

### Example 4: HTTPS on a custom host and port

```json
{
  "nuxt-dev-server.port": 4443,
  "nuxt-dev-server.host": "localhost",
  "nuxt-dev-server.https": true
}
```

## Known Issues

- Port detection may not work for all configurations
- Working directory detection may require additional permissions on some platforms
- On Windows, cwd is inferred from the Nuxt CLI path in the command line when Win32 does not expose WorkingDirectory
- Process detection relies on system tools (ps/lsof on macOS/Linux, PowerShell on Windows)

## Installation

### From VS Code Marketplace

1. Open VS Code
2. Go to Extensions (Cmd+Shift+X / Ctrl+Shift+X)
3. Search for "Nuxt Dev Server Manager"
4. Click Install

### From VSIX File

```bash
# The VSIX name embeds the extension version (currently 0.0.8; see package.json).
code --install-extension nuxt-dev-server-0.0.8.vsix
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

# Lint the source
npm run lint

# Run the test suite
npm test

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
- Building and publishing locally with vsce

## Release Notes

### Unreleased (next release)

Reliability fixes to process handling, matching the Unreleased entries in
CHANGELOG.md:

- Stopping a server now walks the entire pid/ppid tree and terminates listening
  descendants of the package-manager wrapper, so no orphaned children survive
  a stop or extension deactivate
- A missing PID (`ESRCH`) is treated as already stopped, and stop refuses to
  report success while the wrapper is still alive
- Restart aborts instead of spawning a second instance when the stop phase fails
- Process matching accepts `nuxi dev` / `nuxi preview` and Windows `.cmd`
  binaries, and the working directory is inferred from the Nuxt CLI path on
  Windows

### 0.0.8

Restricted Mode / Workspace Trust gates start, kill-all, list-and-kill, and extra-server auto-kill. See CHANGELOG.md for full history.

### 0.0.6

Major update with performance, security, and automation improvements:

**New Features:**
- Auto-kill servers after configurable timeout or idle time
- Activity tracking with file system monitoring for idle detection
- Graceful shutdown (SIGTERM before SIGKILL) for cleaner process termination
- Automatic cleanup of extra servers with configurable limits
- Support for custom dev commands
- Configurable status bar update interval
- Optional notifications that can be disabled

**Security Improvements:**
- PID validation to prevent invalid process operations
- Safe JSON parsing with error handling
- Input sanitization for all shell commands
- Better error handling throughout

**Performance & Reliability:**
- Fixed resource leaks (output channels now properly managed)
- Single reusable output channel instead of creating multiple
- Better process state management
- Improved cleanup on extension deactivation
- Configuration hot-reload support

**UI Enhancements:**
- Better status indicators and activity feedback
- Improved notification system
- Timestamped log entries in output channel
- More informative error messages

### 0.0.5

- Improved process killing
- Bug fixes

### 0.0.3

- Updated publisher ID to `pstuart`
- Adjusted npm scripts for better version management

### 0.0.2

- Added the Show All Running Instances command with a detailed output panel
- Version detection now reports declared, installed, and running versions per server
- Added version bump npm scripts, GitHub Actions for CI and automated marketplace publishing, and publishing documentation
- Process detection now counts only processes listening on ports, fixing duplicate counting
- More accurate running-version detection read from `node_modules`

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
