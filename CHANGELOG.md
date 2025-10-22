# Changelog

All notable changes to the "Nuxt Dev Server Manager" extension will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.0.6] - 2025-01-22

Major update with performance, security, and automation improvements.

### Added
- **Auto-Kill Features**: Automatically kill servers after configurable timeout or idle time
- **Activity Tracking**: File system monitoring to detect idle servers
- **Progress Indicators**: Visual feedback during start/stop operations
- **Automatic Cleanup**: Configurable limits for extra servers with automatic cleanup
- **Custom Commands**: Support for custom dev commands via settings
- **Configurable Settings**: Nine new settings for customization
  - `autoKillTimeout`: Auto-kill after X minutes of runtime
  - `autoKillIdleTime`: Auto-kill after X minutes of inactivity
  - `enableAutoCleanup`: Enable automatic cleanup warnings
  - `maxExtraServers`: Limit number of extra servers
  - `gracefulShutdownTimeout`: Timeout for graceful shutdown
  - `statusBarUpdateInterval`: Configurable update frequency
  - `customDevCommand`: Custom dev server command
  - `defaultPort`: Default port fallback
  - `showNotifications`: Toggle notifications on/off
- **Configuration Hot-Reload**: Settings changes apply immediately
- Timestamped log entries in output channel
- Better status indicators with activity feedback

### Changed
- **Graceful Shutdown**: Now tries SIGTERM before SIGKILL for cleaner process termination
- **Output Channel Management**: Single reusable output channel instead of creating multiple
- **Notification System**: Improved with configurable enable/disable option
- All error messages now use centralized notification system
- Better process state management with tracking info
- Improved cleanup on extension deactivation with graceful shutdown

### Fixed
- **Security**: PID validation to prevent invalid process operations
- **Security**: Safe JSON parsing with error handling to prevent crashes
- **Security**: Input sanitization for all shell commands
- **Resource Leaks**: Output channels now properly disposed
- **Resource Leaks**: File watchers properly cleaned up
- **Resource Leaks**: Intervals properly cleared on deactivation
- Better error handling throughout with proper try-catch blocks
- Improved process killing with validation checks
- Fixed potential race conditions in process management
- Home directory path handling now more robust
- Process tracking state properly reset on server stop

### Security
- Added PID validation regex to prevent command injection
- Implemented safe JSON parsing wrapper to prevent crashes
- Sanitized environment variable usage
- Added validation checks before all shell command executions
- Better error handling prevents information leaks

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