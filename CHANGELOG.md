# Changelog

All notable changes to the "Nuxt Dev Server Manager" extension will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed
- Stop dev server now uses dual-approach killing strategy:
  - First finds and kills all Nuxt processes in the working directory by matching paths
  - Then kills the shell process tree as backup
  - Uses SIGKILL (-9) for immediate termination to prevent zombie processes
- Tracks working directory of managed server for accurate process identification
- Improved cleanup on extension deactivation
- Added proper async handling and timeout for graceful shutdown
- Improved logging for process lifecycle events (exit, close, errors)

## [0.0.3] - 2025-09-30

### Changed
- Updated publisher ID to `pstuart`
- Adjusted npm scripts for better version management

## [0.0.2] - 2025-09-30

### Added
- Show All Running Instances command with detailed output panel
- Improved version detection showing declared, installed, and running versions per server
- Version bump npm scripts for easier release management
- GitHub Actions for CI and automated marketplace publishing
- Comprehensive publishing documentation

### Changed
- Improved process detection to only count processes listening on ports
- Fixed duplicate process counting issue
- Better icon with PS initials on green gradient background
- More accurate "running version" detection reading from node_modules

### Fixed
- Process counting now correctly identifies unique Nuxt servers
- Version detection now shows actual installed version instead of CLI version

## [0.0.1] - 2025-09-30

### Added
- Initial release
- Status bar integration showing running Nuxt instance count
- Start/Stop/Restart dev server commands
- List and Kill specific instances with multi-select
- Kill all instances command
- Port and URL detection with browser integration
- Working directory detection for each process
- Nuxt version display
- Support for npm, yarn, pnpm, and bun package managers
- Auto-detection of Nuxt projects via nuxt.config files
- Process monitoring every 3 seconds
- Output channel for dev server logs

[0.0.2]: https://github.com/pstuart/nuxt-dev-server-vscode/compare/v0.0.1...v0.0.2
[0.0.1]: https://github.com/pstuart/nuxt-dev-server-vscode/releases/tag/v0.0.1