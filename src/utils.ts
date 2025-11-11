import * as vscode from 'vscode';
import { OUTPUT_CHANNELS, CONFIG_SECTION } from './constants';
import { ExtensionConfig } from './types';

/**
 * Cache for output channels to prevent creating duplicates
 */
const outputChannelCache = new Map<string, vscode.OutputChannel>();

/**
 * Get or create an output channel
 * Reuses existing channels to prevent memory leaks
 */
export function getOrCreateOutputChannel(name: string): vscode.OutputChannel {
    if (!outputChannelCache.has(name)) {
        outputChannelCache.set(name, vscode.window.createOutputChannel(name));
    }
    return outputChannelCache.get(name)!;
}

/**
 * Dispose all cached output channels
 */
export function disposeAllOutputChannels(): void {
    for (const channel of outputChannelCache.values()) {
        channel.dispose();
    }
    outputChannelCache.clear();
}

/**
 * Format a file path for display by replacing home directory with ~
 */
export function formatPathForDisplay(filePath: string): string {
    const homeDir = process.env.HOME || process.env.USERPROFILE || '';
    if (homeDir && filePath.startsWith(homeDir)) {
        return filePath.replace(homeDir, '~');
    }
    return filePath;
}

/**
 * Expand a path by replacing ~ with the home directory
 */
export function expandPath(filePath: string): string {
    const homeDir = process.env.HOME || process.env.USERPROFILE || '';
    if (filePath.startsWith('~') && homeDir) {
        return filePath.replace('~', homeDir);
    }
    return filePath;
}

/**
 * Validate and sanitize a PID to prevent command injection
 */
export function sanitizePid(pid: string): number {
    const numPid = parseInt(pid, 10);
    if (isNaN(numPid) || numPid <= 0) {
        throw new Error(`Invalid PID: ${pid}`);
    }
    return numPid;
}

/**
 * Sleep for a specified duration
 */
export function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Get extension configuration with defaults
 */
export function getConfig(): ExtensionConfig {
    const config = vscode.workspace.getConfiguration(CONFIG_SECTION);

    return {
        defaultPort: config.get('defaultPort', 3000),
        preferredPackageManager: config.get('preferredPackageManager', 'auto'),
        autoStartOnOpen: config.get('autoStartOnOpen', false),
        showNotifications: config.get('showNotifications', true),
        updateInterval: config.get('updateInterval', 5000),
        devCommand: config.get('devCommand', 'dev'),
        openBrowserOnStart: config.get('openBrowserOnStart', false),
        debug: config.get('debug', false),
        autoKillTimeout: config.get('autoKillTimeout', 0),
        autoKillIdleTime: config.get('autoKillIdleTime', 0),
        enableAutoCleanup: config.get('enableAutoCleanup', false),
        maxExtraServers: config.get('maxExtraServers', 0),
        gracefulShutdownTimeout: config.get('gracefulShutdownTimeout', 5000),
    };
}

/**
 * Debug logging utility
 */
export function debugLog(...args: unknown[]): void {
    const config = getConfig();
    if (config.debug) {
        const channel = getOrCreateOutputChannel(OUTPUT_CHANNELS.DEBUG);
        const timestamp = new Date().toISOString();
        channel.appendLine(`[${timestamp}] ${args.map(a => String(a)).join(' ')}`);
    }
}

/**
 * Show an error message with optional actions
 */
export function showError(message: string, ...actions: string[]): Thenable<string | undefined> {
    const config = getConfig();
    if (config.showNotifications) {
        return vscode.window.showErrorMessage(message, ...actions);
    }
    debugLog('Error:', message);
    return Promise.resolve(undefined);
}

/**
 * Show a warning message with optional actions
 */
export function showWarning(message: string, ...actions: string[]): Thenable<string | undefined> {
    const config = getConfig();
    if (config.showNotifications) {
        return vscode.window.showWarningMessage(message, ...actions);
    }
    debugLog('Warning:', message);
    return Promise.resolve(undefined);
}

/**
 * Show an info message with optional actions
 */
export function showInfo(message: string, ...actions: string[]): Thenable<string | undefined> {
    const config = getConfig();
    if (config.showNotifications) {
        return vscode.window.showInformationMessage(message, ...actions);
    }
    debugLog('Info:', message);
    return Promise.resolve(undefined);
}

/**
 * Handle errors with proper typing
 */
export function getErrorMessage(error: unknown): string {
    if (error instanceof Error) {
        return error.message;
    }
    if (typeof error === 'string') {
        return error;
    }
    return String(error);
}

/**
 * Check if an error indicates no processes were found
 */
export function isNoProcessError(error: unknown): boolean {
    if (error && typeof error === 'object' && 'code' in error) {
        return (error as { code: number }).code === 1;
    }
    return false;
}

/**
 * Truncate a string with ellipsis
 */
export function truncate(str: string, maxLength: number): string {
    if (str.length <= maxLength) {
        return str;
    }
    return str.substring(0, maxLength - 3) + '...';
}
