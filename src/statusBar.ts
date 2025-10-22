import * as vscode from 'vscode';
import { STATUS_BAR, COMMANDS } from './constants';
import { getRunningNuxtProcessCount } from './processManager';
import { getManagedServer, isManagedServerRunning } from './devServer';
import { debugLog, getConfig } from './utils';

/**
 * Status bar item instance
 */
let statusBarItem: vscode.StatusBarItem | null = null;

/**
 * Update interval handle
 */
let updateInterval: NodeJS.Timeout | null = null;

/**
 * Initialize the status bar
 */
export function initializeStatusBar(context: vscode.ExtensionContext): vscode.StatusBarItem {
    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    statusBarItem.command = COMMANDS.SHOW_MENU;
    context.subscriptions.push(statusBarItem);

    // Initial update
    updateStatusBar();

    // Start periodic updates
    startStatusBarUpdates();

    // Listen for workspace folder changes
    context.subscriptions.push(
        vscode.workspace.onDidChangeWorkspaceFolders(() => {
            debugLog('Workspace folders changed');
            if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
                startStatusBarUpdates();
            } else {
                stopStatusBarUpdates();
            }
        })
    );

    return statusBarItem;
}

/**
 * Start periodic status bar updates
 */
function startStatusBarUpdates(): void {
    if (updateInterval) {
        return; // Already running
    }

    const config = getConfig();
    const interval = config.updateInterval;

    debugLog(`Starting status bar updates with interval ${interval}ms`);

    updateInterval = setInterval(() => {
        updateStatusBar();
    }, interval);
}

/**
 * Stop periodic status bar updates
 */
function stopStatusBarUpdates(): void {
    if (updateInterval) {
        debugLog('Stopping status bar updates');
        clearInterval(updateInterval);
        updateInterval = null;
    }
}

/**
 * Update the status bar display
 */
export async function updateStatusBar(): Promise<void> {
    if (!statusBarItem) {
        return;
    }

    try {
        const runningCount = await getRunningNuxtProcessCount();
        const isOwnServerRunning = isManagedServerRunning();
        const managedServer = getManagedServer();

        if (isOwnServerRunning && managedServer) {
            // Managed server is running - show with port
            statusBarItem.text = `${STATUS_BAR.ICON_RUNNING} ${STATUS_BAR.TEXT_DEV} :${managedServer.port} (${runningCount})`;
            statusBarItem.tooltip = `Nuxt server running on ${managedServer.url}\nTotal instances: ${runningCount}\nClick for options`;
            statusBarItem.backgroundColor = undefined;
        } else if (runningCount > 0) {
            // Other instances detected
            statusBarItem.text = `${STATUS_BAR.ICON_RUNNING} ${STATUS_BAR.TEXT_NUXT} (${runningCount})`;
            statusBarItem.tooltip = `${runningCount} Nuxt instance(s) detected\nNo managed server running\nClick for options`;
            statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
        } else {
            // No servers running
            statusBarItem.text = `${STATUS_BAR.ICON_STOPPED} ${STATUS_BAR.TEXT_DEV}`;
            statusBarItem.tooltip = 'No Nuxt server running\nClick to start';
            statusBarItem.backgroundColor = undefined;
        }

        statusBarItem.show();
    } catch (error) {
        debugLog('Error updating status bar:', error);
    }
}

/**
 * Cleanup status bar resources
 */
export function cleanupStatusBar(): void {
    stopStatusBarUpdates();

    if (statusBarItem) {
        statusBarItem.dispose();
        statusBarItem = null;
    }
}

/**
 * Force an immediate status bar update
 */
export function forceStatusBarUpdate(): void {
    updateStatusBar();
}
