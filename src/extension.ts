import * as vscode from 'vscode';
import { startDevServer, stopDevServer, restartDevServer, cleanupManagedServer, clearManagedServer, getManagedServer } from './devServer';
import { initializeStatusBar, cleanupStatusBar, updateStatusBar } from './statusBar';
import { showNuxtVersion } from './versionDetector';
import {
    getRunningNuxtProcesses,
    getRunningNuxtProcessCount,
    killAllNuxtProcesses,
    killProcess
} from './processManager';
import { COMMANDS, OUTPUT_CHANNELS } from './constants';
import { getOrCreateOutputChannel, showInfo, showWarning, showError, debugLog, disposeAllOutputChannels } from './utils';
import { ProcessQuickPickItem } from './types';

/**
 * Extension activation
 */
export function activate(context: vscode.ExtensionContext) {
    debugLog('Nuxt Dev Server Manager activated');

    // Check platform compatibility
    const platform = process.platform;
    if (platform !== 'darwin' && platform !== 'linux') {
        vscode.window.showWarningMessage(
            `Nuxt Dev Server Manager: Limited support on ${platform}. This extension is optimized for macOS and Linux. Windows support is experimental.`
        );
    }

    // Initialize status bar
    const statusBar = initializeStatusBar(context);
    context.subscriptions.push(statusBar);

    // Register all commands
    context.subscriptions.push(
        vscode.commands.registerCommand(COMMANDS.START, handleCommand(startDevServer)),
        vscode.commands.registerCommand(COMMANDS.STOP, handleCommand(stopDevServer)),
        vscode.commands.registerCommand(COMMANDS.RESTART, handleCommand(restartDevServer)),
        vscode.commands.registerCommand(COMMANDS.SHOW_ALL, handleCommand(showAllInstances)),
        vscode.commands.registerCommand(COMMANDS.KILL_ALL, handleCommand(killAllNuxtInstancesWithConfirmation)),
        vscode.commands.registerCommand(COMMANDS.LIST_AND_KILL, handleCommand(listAndKillInstances)),
        vscode.commands.registerCommand(COMMANDS.OPEN_BROWSER, handleCommand(openInBrowser)),
        vscode.commands.registerCommand(COMMANDS.SHOW_VERSION, handleCommand(showNuxtVersion)),
        vscode.commands.registerCommand(COMMANDS.SHOW_MENU, handleCommand(showQuickPick))
    );

    debugLog('Extension activation complete');
}

/**
 * Extension deactivation
 */
export async function deactivate() {
    debugLog('Deactivating Nuxt Dev Server Manager');

    // Cleanup managed server
    await cleanupManagedServer();

    // Cleanup status bar
    cleanupStatusBar();

    // Dispose output channels
    disposeAllOutputChannels();

    debugLog('Extension deactivated');
}

/**
 * Wrapper to handle command errors gracefully
 */
function handleCommand<T>(fn: (...args: any[]) => Promise<T>) {
    return async (...args: any[]) => {
        try {
            return await fn(...args);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            debugLog('Command error:', message);
            await showError(`Command failed: ${message}`);
        }
    };
}

/**
 * Show quick pick menu with all commands
 */
async function showQuickPick(): Promise<void> {
    const runningCount = await getRunningNuxtProcessCount();
    const managedServer = getManagedServer();
    const isOwnServerRunning = managedServer !== null && !managedServer.process.killed;

    const items: vscode.QuickPickItem[] = [
        {
            label: '$(play) Start Dev Server',
            description: isOwnServerRunning ? 'Already running' : undefined,
            detail: 'Start Nuxt development server'
        },
        {
            label: '$(debug-stop) Stop Dev Server',
            description: !isOwnServerRunning ? 'Not running' : undefined,
            detail: 'Stop the managed dev server'
        },
        {
            label: '$(debug-restart) Restart Dev Server',
            detail: 'Restart the managed dev server'
        },
        {
            label: '$(list-unordered) Show All Running Instances',
            description: runningCount > 0 ? `${runningCount} running` : 'None running',
            detail: 'View all running Nuxt instances with details'
        },
        {
            label: '$(list-selection) List and Kill Instances',
            description: runningCount > 0 ? `${runningCount} running` : 'None running',
            detail: 'View and select specific instances to kill'
        },
        {
            label: '$(trash) Kill All Nuxt Instances',
            description: runningCount > 0 ? `${runningCount} running` : 'None running',
            detail: 'Kill all Nuxt processes on the system'
        },
        {
            label: '$(globe) Open in Browser',
            description: managedServer ? managedServer.url : 'No server running',
            detail: 'Open the dev server in browser'
        },
        {
            label: '$(info) Show Nuxt Version',
            detail: 'Display installed and running Nuxt version'
        }
    ];

    const selected = await vscode.window.showQuickPick(items, {
        placeHolder: 'Select a Nuxt action'
    });

    if (!selected) {
        return;
    }

    // Execute selected action
    switch (selected.label) {
        case '$(play) Start Dev Server':
            await startDevServer();
            break;
        case '$(debug-stop) Stop Dev Server':
            await stopDevServer();
            break;
        case '$(debug-restart) Restart Dev Server':
            await restartDevServer();
            break;
        case '$(list-unordered) Show All Running Instances':
            await showAllInstances();
            break;
        case '$(list-selection) List and Kill Instances':
            await listAndKillInstances();
            break;
        case '$(trash) Kill All Nuxt Instances':
            await killAllNuxtInstancesWithConfirmation();
            break;
        case '$(globe) Open in Browser':
            await openInBrowser();
            break;
        case '$(info) Show Nuxt Version':
            await showNuxtVersion();
            break;
    }
}

/**
 * Show all running Nuxt instances
 */
async function showAllInstances(): Promise<void> {
    try {
        const processes = await getRunningNuxtProcesses();

        if (processes.length === 0) {
            await showInfo('No Nuxt instances found');
            return;
        }

        // Build a detailed message
        const lines: string[] = [
            `Found ${processes.length} running Nuxt instance(s):\n`
        ];

        processes.forEach((proc, index) => {
            lines.push(`${index + 1}. PID ${proc.pid}`);
            if (proc.port) {
                lines.push(`   Port: ${proc.port} (http://localhost:${proc.port})`);
            }
            lines.push(`   Directory: ${proc.workingDir}`);
            lines.push(`   Command: ${proc.command}`);
            lines.push('');
        });

        const message = lines.join('\n');

        // Show in output channel for better formatting
        const outputChannel = getOrCreateOutputChannel(OUTPUT_CHANNELS.INSTANCES);
        outputChannel.clear();
        outputChannel.appendLine(message);
        outputChannel.show();

        await showInfo(`Found ${processes.length} Nuxt instance(s). See 'Nuxt Instances' output for details.`);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await showError(`Failed to get instances: ${message}`);
    }
}

/**
 * List and kill specific instances
 */
async function listAndKillInstances(): Promise<void> {
    try {
        const processes = await getRunningNuxtProcesses();

        if (processes.length === 0) {
            await showInfo('No Nuxt instances found');
            return;
        }

        const items: ProcessQuickPickItem[] = processes.map(proc => ({
            label: `$(process) PID ${proc.pid}`,
            description: proc.port ? `Port ${proc.port}` : undefined,
            detail: `${proc.workingDir}`,
            process: proc
        }));

        const selected = await vscode.window.showQuickPick(items, {
            canPickMany: true,
            placeHolder: `Select Nuxt instances to kill (${processes.length} running)`
        });

        if (!selected || selected.length === 0) {
            return;
        }

        const confirm = await vscode.window.showWarningMessage(
            `Kill ${selected.length} selected instance(s)?`,
            { modal: true },
            'Yes',
            'No'
        );

        if (confirm !== 'Yes') {
            return;
        }

        const managedServer = getManagedServer();

        let killedCount = 0;
        for (const item of selected) {
            try {
                await killProcess(item.process.pid);

                // If this was our managed server, clear the reference
                if (managedServer && managedServer.process.pid?.toString() === item.process.pid) {
                    clearManagedServer();
                }

                killedCount++;
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                await showError(`Failed to kill PID ${item.process.pid}: ${message}`);
            }
        }

        await showInfo(`Killed ${killedCount} of ${selected.length} instance(s)`);

        // Update status bar
        await updateStatusBar();
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await showError(`Failed to list instances: ${message}`);
    }
}

/**
 * Kill all Nuxt instances with confirmation
 */
async function killAllNuxtInstancesWithConfirmation(): Promise<void> {
    try {
        const processes = await getRunningNuxtProcesses();
        const count = processes.length;

        if (count === 0) {
            await showInfo('No Nuxt instances found');
            return;
        }

        const confirm = await vscode.window.showWarningMessage(
            `Kill all ${count} Nuxt instance(s)?`,
            { modal: true },
            'Yes',
            'No'
        );

        if (confirm !== 'Yes') {
            return;
        }

        const killedCount = await killAllNuxtProcesses();

        // Clear managed server reference
        clearManagedServer();

        await showInfo(`Killed ${killedCount} of ${count} Nuxt instance(s)`);

        // Update status bar
        await updateStatusBar();
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await showError(`Failed to kill instances: ${message}`);
    }
}

/**
 * Open dev server in browser
 */
async function openInBrowser(): Promise<void> {
    const managedServer = getManagedServer();

    if (!managedServer) {
        // Check if any servers are running
        const runningCount = await getRunningNuxtProcessCount();
        if (runningCount === 0) {
            await showWarning('No Nuxt server is running');
            return;
        }

        // If other servers running, try to open the first one
        const processes = await getRunningNuxtProcesses();
        if (processes.length > 0 && processes[0].port) {
            const url = `http://localhost:${processes[0].port}`;
            vscode.env.openExternal(vscode.Uri.parse(url));
            return;
        }

        await showWarning('No server URL available');
        return;
    }

    vscode.env.openExternal(vscode.Uri.parse(managedServer.url));
}
