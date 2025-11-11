import { ChildProcess } from 'child_process';

/**
 * Represents a detected Nuxt process running on the system
 */
export interface NuxtProcess {
    /** Process ID */
    pid: string;
    /** Full command line (may be truncated) */
    command: string;
    /** Working directory of the process */
    workingDir: string;
    /** Port the server is listening on */
    port?: string;
}

/**
 * Information about the managed dev server
 */
export interface ManagedServer {
    /** Child process handle */
    process: ChildProcess;
    /** Working directory where server was started */
    workingDir: string;
    /** Port the server is running on (detected from output) */
    port: number;
    /** Full URL of the server */
    url: string;
}

/**
 * Supported package managers
 */
export type PackageManager = 'npm' | 'yarn' | 'pnpm' | 'bun';

/**
 * Configuration options for the extension
 */
export interface ExtensionConfig {
    /** Default port for dev server */
    defaultPort: number;
    /** Preferred package manager (auto-detect if not set) */
    preferredPackageManager: 'auto' | PackageManager;
    /** Auto-start server when workspace opens */
    autoStartOnOpen: boolean;
    /** Show notification messages */
    showNotifications: boolean;
    /** Status bar update interval in milliseconds */
    updateInterval: number;
    /** Custom dev command (defaults to 'dev') */
    devCommand: string;
    /** Open browser automatically when server starts */
    openBrowserOnStart: boolean;
    /** Enable debug logging */
    debug: boolean;
    /** Auto-kill server after X minutes (0 = disabled) */
    autoKillTimeout: number;
    /** Auto-kill server when idle for X minutes (0 = disabled) */
    autoKillIdleTime: number;
    /** Enable automatic cleanup warnings for extra servers */
    enableAutoCleanup: boolean;
    /** Maximum number of extra servers allowed (0 = unlimited) */
    maxExtraServers: number;
    /** Graceful shutdown timeout in milliseconds */
    gracefulShutdownTimeout: number;
}

/**
 * Version information for Nuxt
 */
export interface NuxtVersionInfo {
    /** Version from package.json */
    declared: string;
    /** Version from node_modules */
    installed: string;
    /** Running server instances and their versions */
    running: Array<{
        pid: string;
        port?: string;
        workingDir: string;
        version: string;
    }>;
}

/**
 * Quick pick item for process selection
 */
export interface ProcessQuickPickItem {
    label: string;
    description?: string;
    detail: string;
    process: NuxtProcess;
}
