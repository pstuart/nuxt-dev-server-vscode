import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';
import { OUTPUT_CHANNELS, CONFIG_SECTION, NUXT_CONFIG_FILES } from './constants';
import { clampNumber } from './validation';
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
    const homeDir = process.env.HOME ?? process.env.USERPROFILE ?? '';
    if (homeDir && (filePath === homeDir || filePath.startsWith(homeDir + '/'))) {
        return filePath.replace(homeDir, '~');
    }
    return filePath;
}

/**
 * Expand a path by replacing ~ with the home directory.
 * Only expands a leading `~` or `~/` — `~user` forms are left untouched.
 */
export function expandPath(filePath: string): string {
    const homeDir = process.env.HOME ?? process.env.USERPROFILE ?? '';
    if (!homeDir) {
        return filePath;
    }
    if (filePath === '~') {
        return homeDir;
    }
    if (filePath.startsWith('~/')) {
        return homeDir + filePath.slice(1);
    }
    return filePath;
}

/**
 * Sleep for a specified duration
 */
export function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function clampConfigNumber(value: number, min: number, max: number, fallback: number): number {
    return clampNumber(value, min, max) ?? fallback;
}

/**
 * Get extension configuration with defaults
 */
export function getConfig(): ExtensionConfig {
    const config = vscode.workspace.getConfiguration(CONFIG_SECTION);

    return {
        defaultPort: clampConfigNumber(config.get('defaultPort', 3000), 1, 65535, 3000),
        preferredPackageManager: config.get('preferredPackageManager', 'auto'),
        autoStartOnOpen: config.get('autoStartOnOpen', false),
        showNotifications: config.get('showNotifications', true),
        updateInterval: clampConfigNumber(config.get('updateInterval', 5000), 1000, 60000, 5000),
        devCommand: config.get('devCommand', 'dev'),
        projectDirectory: config.get('projectDirectory', ''),
        openBrowserOnStart: config.get('openBrowserOnStart', false),
        debug: config.get('debug', false),
        autoKillTimeout: clampConfigNumber(config.get('autoKillTimeout', 0), 0, Number.POSITIVE_INFINITY, 0),
        autoKillIdleTime: clampConfigNumber(config.get('autoKillIdleTime', 0), 0, Number.POSITIVE_INFINITY, 0),
        enableAutoCleanup: config.get('enableAutoCleanup', false),
        maxExtraServers: clampConfigNumber(config.get('maxExtraServers', 0), 0, Number.POSITIVE_INFINITY, 0),
        gracefulShutdownTimeout: clampConfigNumber(config.get('gracefulShutdownTimeout', 5000), 1000, 30000, 5000),
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
 * Check if a file exists (async)
 */
export async function fileExists(filePath: string): Promise<boolean> {
    try {
        await fs.access(filePath);
        return true;
    } catch {
        return false;
    }
}

/**
 * Check if a directory has one of the Nuxt configuration files.
 */
export async function hasNuxtConfig(dirPath: string): Promise<boolean> {
    for (const configFile of NUXT_CONFIG_FILES) {
        if (await fileExists(path.join(dirPath, configFile))) {
            return true;
        }
    }
    return false;
}

/**
 * Nuxt configuration file names; a directory containing one is a Nuxt project.
 */
export const PROJECT_CONFIG_GLOB = `**/{${NUXT_CONFIG_FILES.join(',')}}`;
const PROJECT_CONFIG_EXCLUDE_GLOB = '**/node_modules/**';

export interface ResolvedProject {
    /** Directory the dev server is spawned in */
    dir: string;
}

/**
 * Resolve the Nuxt project directory for the current workspace.
 *
 * Order: the `projectDirectory` setting, then the managed server's directory,
 * then a nuxt.config found in a workspace folder, then a single nuxt.config
 * below the workspace root (monorepo layouts such as apps/web). When several
 * projects exist a quick pick asks the user which one to start.
 * Returns null when no Nuxt project exists or the picker was dismissed.
 *
 * Security: the directory is only ever used as a spawn cwd, never interpolated
 * into a shell command.
 */
export async function resolveProjectDirectory(
    managedWorkingDir?: string,
): Promise<ResolvedProject | null> {
    const configured = getConfig().projectDirectory.trim();
    if (configured) {
        const dir = path.resolve(expandPath(configured));
        debugLog(`Using configured projectDirectory: ${dir}`);
        return { dir };
    }

    if (managedWorkingDir && await hasNuxtConfig(managedWorkingDir)) {
        debugLog(`Reusing managed server directory: ${managedWorkingDir}`);
        return { dir: managedWorkingDir };
    }

    const folderDirs = (vscode.workspace.workspaceFolders ?? []).map(folder => folder.uri.fsPath);
    for (const dir of folderDirs) {
        if (await hasNuxtConfig(dir)) {
            debugLog(`Found Nuxt project in workspace folder: ${dir}`);
            return { dir };
        }
    }

    // Monorepo: the nuxt.config can live below the workspace root instead of at it.
    let found: vscode.Uri[] = [];
    try {
        found = await vscode.workspace.findFiles(PROJECT_CONFIG_GLOB, PROJECT_CONFIG_EXCLUDE_GLOB);
    } catch (error) {
        debugLog('Error searching for nuxt.config files:', getErrorMessage(error));
    }
    // Skip the workspace roots themselves; those were already checked above.
    const nested = [...new Set(found.map(file => path.dirname(file.fsPath)))]
        .filter(dir => !folderDirs.includes(dir))
        .sort();

    if (nested.length === 1) {
        debugLog(`Found single Nuxt project: ${nested[0]}`);
        return { dir: nested[0] };
    }
    if (nested.length === 0) {
        return null;
    }

    const picked = await vscode.window.showQuickPick(
        nested.map(dir => ({ label: formatPathForDisplay(dir), dir })),
        { placeHolder: 'Select the Nuxt project directory to start' },
    );
    return picked ? { dir: picked.dir } : null;
}

/**
 * Directory whose package.json/node_modules describe the Nuxt version: the
 * explicit `projectDirectory` setting when it is a real directory, otherwise
 * the resolved project directory, falling back to the first workspace folder.
 */
export async function getProjectDirectory(): Promise<string> {
    const configured = getConfig().projectDirectory.trim();
    if (configured) {
        const dir = path.resolve(expandPath(configured));
        try {
            if ((await fs.stat(dir)).isDirectory()) {
                return dir;
            }
        } catch {
            debugLog(`Configured projectDirectory is not a directory: ${dir}`);
        }
    }
    const resolved = await resolveProjectDirectory();
    if (resolved) {
        return resolved.dir;
    }
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
}

/**
 * Directory the idle watcher monitors: the managed server's directory when one
 * is running, otherwise the first workspace folder.
 */
export function getIdleWatchDirectory(managedWorkingDir?: string): string | undefined {
    return managedWorkingDir ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}
