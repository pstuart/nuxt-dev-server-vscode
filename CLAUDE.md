# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a VS Code extension that manages Nuxt development servers with status bar integration. It provides start/stop/restart functionality, multi-instance tracking, and process management for Nuxt dev servers.

**Platform**: Currently macOS-only (uses `ps`, `lsof`, `pkill` commands)

## Development Commands

### Building and Compilation
```bash
# Compile TypeScript to JavaScript
npm run compile

# Watch mode for development (auto-recompile on changes)
npm run watch

# Lint the codebase
npm run lint
```

### Packaging and Versioning
```bash
# Compile and package to .vsix (without version bump)
npm run package:do

# Bump patch version and package
npm run package

# Manual version bumping
npm run version:patch  # 0.0.2 -> 0.0.3
npm run version:minor  # 0.0.2 -> 0.1.0
npm run version:major  # 0.0.2 -> 1.0.0
```

### Testing the Extension
To test during development:
1. Press F5 in VS Code to launch Extension Development Host
2. Open a Nuxt project in the new window
3. The extension auto-activates when it detects `nuxt.config.{js,ts,mjs,mts}`

## Architecture

### Single-File Structure
The entire extension logic is contained in `src/extension.ts` (~630 lines). This is a simple extension without complex abstractions.

### Core State Management
The extension maintains three critical pieces of global state:
- `devServerProcess`: The managed ChildProcess for the user's dev server
- `devServerWorkingDir`: Working directory of the managed server (used for cleanup)
- `statusBarItem`: The VS Code status bar item showing server status

### Process Detection Strategy
The extension uses a **port-based detection** approach to accurately count running Nuxt instances:

1. **Discovery**: Find node processes with "nuxt" and "dev" or "preview" via `ps`
2. **Verification**: For each process, check if it's listening on a port using `lsof -iTCP -sTCP:LISTEN`
3. **Filtering**: Only count processes with listening ports (actual servers, not build scripts)
4. **Deduplication**: Use a Map keyed by PID to avoid counting duplicate/child processes

This approach prevents false positives from counting build processes or child processes.

### Process Lifecycle Management

**Starting a server** (src/extension.ts:240-324):
- Detects package manager (npm/yarn/pnpm/bun) by checking for lock files
- Spawns dev server using detected package manager
- Captures stdout/stderr to output channel
- Extracts port from server output (searches for `http://localhost:XXXX`)

**Stopping a server** (src/extension.ts:326-395):
Uses a two-pronged approach to ensure complete cleanup:
1. **Working directory matching**: Find all Nuxt processes in the same working directory and kill them
2. **Process tree cleanup**: Kill all child processes (`pkill -9 -P $pid`) then the parent shell

This dual approach handles cases where the spawned shell has child processes.

### Status Bar Updates
The status bar updates every 3 seconds (src/extension.ts:46) and shows:
- `⚡ Nuxt Dev (n)` - Your managed server is running (n = total instances)
- `⚡ Nuxt (n)` - Other instances detected, no managed server
- `⊘ Nuxt Dev` - No servers running

### Version Detection
The extension provides three version views:
- **Declared**: From workspace's `package.json` dependencies
- **Installed**: From workspace's `node_modules/nuxt/package.json`
- **Running**: Per-instance version by reading `node_modules/nuxt/package.json` in each process's working directory

### Package Manager Detection
Auto-detects package manager by checking for lock files in this order:
1. `yarn.lock` → use `yarn`
2. `pnpm-lock.yaml` → use `pnpm`
3. `bun.lockb` → use `bun`
4. Default → use `npm`

## Key Implementation Details

### Port Extraction
The extension extracts the server port from stdout by matching:
```typescript
const portMatch = output.match(/http:\/\/localhost:(\d+)/);
```

### Process Cleanup on Deactivation
When the extension deactivates (src/extension.ts:49-65), it attempts to clean up by:
1. Killing all child processes of the managed server
2. Sending SIGKILL to the main process
3. Using best-effort error handling (catches and ignores errors)

### Multi-Instance Commands
- **Show All**: Displays all running Nuxt instances with PID, port, directory, and command
- **List and Kill**: Interactive multi-select to kill specific instances
- **Kill All**: Uses `pkill -f "node.*nuxt.*(dev|preview)"` to kill all Nuxt processes

## Extension Configuration

### Activation
Automatically activates when workspace contains: `nuxt.config.{js,ts,mjs,mts}`

### Commands Registered
All commands are prefixed with `nuxt-dev-server.`:
- `start`, `stop`, `restart` - Basic server control
- `showAll`, `listAndKill`, `killAll` - Process management
- `openBrowser` - Opens `serverUrl` in browser
- `showVersion` - Version information
- `showMenu` - Quick pick menu (triggered by status bar click)

## Common Patterns

### Working Directory Handling
Throughout the code, home directory is replaced with `~` for display:
```typescript
workingDir.replace(process.env.HOME || '', '~')
```

When resolving paths, expand back:
```typescript
proc.workingDir.replace('~', process.env.HOME || '')
```

### Error Handling for Process Commands
macOS commands may fail with permission issues or missing processes. Code uses try-catch with graceful degradation:
```typescript
try {
    const { stdout } = await execAsync(command);
    // use stdout
} catch (error) {
    // return default or continue
}
```

## Development Notes

- TypeScript is compiled to `out/` directory
- The extension entry point is `out/extension.js` (specified in package.json `main` field)
- Output channels are created dynamically for logs: "Nuxt Dev Server", "Nuxt Instances", "Nuxt Version"
- Process cleanup is critical - failed cleanup can leave orphaned Node processes
- The managed server's PID tracking can be unreliable if the shell spawns multiple children, hence the working directory matching approach
