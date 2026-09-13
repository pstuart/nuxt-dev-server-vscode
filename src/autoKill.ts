import * as vscode from 'vscode';
import { getManagedServer, stopDevServer, isManagedServerRunning } from './devServer';
import { getRunningNuxtProcesses, killProcess } from './processManager';
import { debugLog, getConfig, showWarning, showInfo, expandPath } from './utils';
import { selectExtraNuxtProcesses } from './processLogic';
import { isDestructiveAutoKillAllowed, refuseIfUntrusted } from './workspaceTrust';

/**
 * Auto-kill state tracking
 */
interface AutoKillState {
    startTime: number;
    lastActivity: number;
    fileWatcher: vscode.FileSystemWatcher | null;
    checkInterval: NodeJS.Timeout | null;
}

const autoKillState: AutoKillState = {
    startTime: 0,
    lastActivity: 0,
    fileWatcher: null,
    checkInterval: null
};

/** Rate-limit enableAutoCleanup user warnings (check interval is 30s). */
const AUTO_CLEANUP_WARN_INTERVAL_MS = 5 * 60 * 1000;
let lastAutoCleanupWarnAt = 0;
let warnedUntrustedAutoKill = false;

/**
 * Update activity timestamp when files change
 */
function updateActivity(): void {
    if (isManagedServerRunning()) {
        autoKillState.lastActivity = Date.now();
        debugLog('Activity detected, updated timestamp');
    }
}

/**
 * Initialize file watcher for idle detection
 */
function setupFileWatcher(context: vscode.ExtensionContext): void {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
        debugLog('No workspace folders, skipping file watcher setup');
        return;
    }

    // Clean up existing watcher
    if (autoKillState.fileWatcher) {
        autoKillState.fileWatcher.dispose();
    }

    // Watch for file changes in the workspace (for idle detection)
    const pattern = new vscode.RelativePattern(workspaceFolders[0], '**/*');
    autoKillState.fileWatcher = vscode.workspace.createFileSystemWatcher(pattern);

    // Update activity on any file change
    autoKillState.fileWatcher.onDidChange(updateActivity);
    autoKillState.fileWatcher.onDidCreate(updateActivity);
    autoKillState.fileWatcher.onDidDelete(updateActivity);

    context.subscriptions.push(autoKillState.fileWatcher);
    debugLog('File watcher initialized for idle detection');
}

/**
 * Reset activity tracking when server starts
 */
export function onServerStart(): void {
    const now = Date.now();
    autoKillState.startTime = now;
    autoKillState.lastActivity = now;
    debugLog(`Auto-kill tracking started at ${new Date(now).toISOString()}`);
}

/**
 * Clear activity tracking when server stops
 */
export function onServerStop(): void {
    autoKillState.startTime = 0;
    autoKillState.lastActivity = 0;
    debugLog('Auto-kill tracking cleared');
}

/**
 * Check auto-kill conditions and kill servers if needed
 */
async function checkAutoKillConditions(): Promise<void> {
    const config = getConfig();
    const autoKillTimeout = config.autoKillTimeout;
    const autoKillIdleTime = config.autoKillIdleTime;
    const enableAutoCleanup = config.enableAutoCleanup;
    const maxExtraServers = config.maxExtraServers;

    // Check for extra servers and cleanup if needed
    if (maxExtraServers > 0 || enableAutoCleanup) {
        const allProcesses = await getRunningNuxtProcesses();
        const managedServer = getManagedServer();
        const managedPid = managedServer?.process.pid?.toString();
        const managedWorkingDir = managedServer?.workingDir;
        const workspaceDir = managedWorkingDir ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        const expandedProcesses = allProcesses.map(proc => ({
            ...proc,
            workingDir: expandPath(proc.workingDir),
        }));
        const extraProcesses = workspaceDir
            ? selectExtraNuxtProcesses(expandedProcesses, workspaceDir, managedPid)
            : [];

        if (extraProcesses.length > 0) {
            debugLog(`Found ${extraProcesses.length} extra Nuxt server(s)`);

            // Auto-cleanup: user-visible warning (rate-limited) when extras exist.
            // Does not kill unless maxExtraServers is set.
            if (enableAutoCleanup) {
                const nowMs = Date.now();
                if (nowMs - lastAutoCleanupWarnAt >= AUTO_CLEANUP_WARN_INTERVAL_MS) {
                    lastAutoCleanupWarnAt = nowMs;
                    await showWarning(
                        `Found ${extraProcesses.length} extra Nuxt server(s) not managed by this extension. ` +
                        `Use "List and Kill" or set maxExtraServers to auto-limit.`
                    );
                    debugLog('Auto-cleanup warning shown to user');
                }
            }

            // Max extra servers: kill oldest servers within the current workspace
            if (maxExtraServers > 0) {
                debugLog(`Found ${extraProcesses.length} extra server(s) in workspace`);

                // Only act if we have more workspace processes than the limit
                if (extraProcesses.length > maxExtraServers) {
                    if (!isDestructiveAutoKillAllowed()) {
                        debugLog('maxExtraServers kill skipped: workspace is not trusted');
                        if (!warnedUntrustedAutoKill) {
                            warnedUntrustedAutoKill = true;
                            await refuseIfUntrusted('autoKillExtras');
                        }
                    } else {
                        const toKill = extraProcesses
                            .filter(p => !isNaN(parseInt(p.pid, 10)) && parseInt(p.pid, 10) > 0)
                            .sort((a, b) => parseInt(a.pid, 10) - parseInt(b.pid, 10))
                            .slice(0, extraProcesses.length - maxExtraServers);

                        debugLog(`Killing ${toKill.length} extra servers due to maxExtraServers limit`);

                        await Promise.all(toKill.map(async proc => {
                            try {
                                await killProcess(proc.pid);
                                await showInfo(`Auto-killed extra server (PID ${proc.pid}) due to maxExtraServers limit`);
                                debugLog(`Auto-killed extra server PID ${proc.pid}`);
                            } catch (error) {
                                debugLog(`Failed to kill extra server ${proc.pid}:`, error);
                            }
                        }));
                    }
                }
            }
        }
    }

    // Runtime and idle policies only apply to a server started by this extension.
    if (!isManagedServerRunning()) {
        return;
    }

    const now = Date.now();
    if (autoKillTimeout > 0 && autoKillState.startTime > 0) {
        const runtimeMinutes = (now - autoKillState.startTime) / (1000 * 60);
        if (runtimeMinutes >= autoKillTimeout) {
            debugLog(`Auto-kill timeout reached: ${runtimeMinutes.toFixed(1)} minutes`);
            await showWarning(`Dev server auto-killed after ${autoKillTimeout} minutes of runtime`);
            await stopDevServer();
            return;
        }
    }

    if (autoKillIdleTime > 0 && autoKillState.lastActivity > 0) {
        const idleMinutes = (now - autoKillState.lastActivity) / (1000 * 60);
        if (idleMinutes >= autoKillIdleTime) {
            debugLog(`Auto-kill idle timeout reached: ${idleMinutes.toFixed(1)} minutes`);
            await showWarning(`Dev server auto-killed after ${autoKillIdleTime} minutes of inactivity`);
            await stopDevServer();
        }
    }
}

/**
 * Initialize auto-kill functionality
 */
export function initializeAutoKill(context: vscode.ExtensionContext): void {
    debugLog('Initializing auto-kill module');

    // Setup file watcher for idle detection
    setupFileWatcher(context);

    // Start auto-kill check interval (check every 30 seconds)
    autoKillState.checkInterval = setInterval(() => {
        void checkAutoKillConditions().catch((error: unknown) => {
            debugLog('Error in auto-kill check:', error);
        });
    }, 30000);

    // Register cleanup
    context.subscriptions.push({
        dispose: () => {
            if (autoKillState.checkInterval) {
                clearInterval(autoKillState.checkInterval);
                autoKillState.checkInterval = null;
            }
        }
    });

    debugLog('Auto-kill module initialized');
}

/**
 * Cleanup auto-kill resources
 */
export function cleanupAutoKill(): void {
    debugLog('Cleaning up auto-kill module');

    // Dispose file watcher
    if (autoKillState.fileWatcher) {
        autoKillState.fileWatcher.dispose();
        autoKillState.fileWatcher = null;
    }

    // Clear interval
    if (autoKillState.checkInterval) {
        clearInterval(autoKillState.checkInterval);
        autoKillState.checkInterval = null;
    }

    // Reset state
    autoKillState.startTime = 0;
    autoKillState.lastActivity = 0;

    debugLog('Auto-kill module cleaned up');
}
