import * as vscode from 'vscode';
import { spawn, ChildProcess, exec } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';
import * as fs from 'fs';
import { ManagedServer, PackageManager } from './types';
import { LOCK_FILES, NUXT_CONFIG_FILES, OUTPUT_CHANNELS, DEFAULT_CONFIG, PROCESS_PATTERNS } from './constants';
import {
    getOrCreateOutputChannel,
    showError,
    showInfo,
    showWarning,
    debugLog,
    getErrorMessage,
    getConfig,
    sleep
} from './utils';
import {
    killProcessTree,
    killProcessesByWorkingDir,
    waitForProcessPort,
    verifyProcessTerminated
} from './processManager';

const execAsync = promisify(exec);

/**
 * The currently managed dev server instance
 */
let managedServer: ManagedServer | null = null;

/**
 * Get the currently managed server
 */
export function getManagedServer(): ManagedServer | null {
    return managedServer;
}

/**
 * Check if a managed server is running
 */
export function isManagedServerRunning(): boolean {
    return managedServer !== null && !managedServer.process.killed;
}

/**
 * Clear the managed server reference
 * Used when the server is killed externally (e.g., via list-and-kill)
 */
export function clearManagedServer(): void {
    managedServer = null;
}

/**
 * Detect package manager from lock files
 */
async function detectPackageManager(rootPath: string): Promise<PackageManager> {
    const config = getConfig();

    // Use preferred if set and not auto
    if (config.preferredPackageManager !== 'auto') {
        const preferredManager = config.preferredPackageManager;
        try {
            const { stdout } = await execAsync(`which ${preferredManager} 2>/dev/null || echo ''`);
            const managerPath = stdout.trim();

            if (managerPath) {
                debugLog(`Using preferred package manager: ${preferredManager}`);
                return preferredManager;
            } else {
                debugLog(`Preferred package manager ${preferredManager} not found, falling back to auto-detection`);
            }
        } catch (error) {
            debugLog(`Error checking for ${preferredManager}:`, getErrorMessage(error));
        }
    }

    // Auto-detect from lock files
    if (fs.existsSync(path.join(rootPath, LOCK_FILES.YARN))) {
        return 'yarn';
    }
    if (fs.existsSync(path.join(rootPath, LOCK_FILES.PNPM))) {
        return 'pnpm';
    }
    if (fs.existsSync(path.join(rootPath, LOCK_FILES.BUN))) {
        return 'bun';
    }

    return 'npm';
}

/**
 * Check if workspace has a Nuxt configuration file
 */
function hasNuxtConfig(rootPath: string): boolean {
    return NUXT_CONFIG_FILES.some(configFile =>
        fs.existsSync(path.join(rootPath, configFile))
    );
}

/**
 * Start the dev server
 */
export async function startDevServer(): Promise<boolean> {
    if (isManagedServerRunning()) {
        await showWarning('Dev server is already running');
        return false;
    }

    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) {
        await showError('No workspace folder open');
        return false;
    }

    const rootPath = workspaceFolders[0].uri.fsPath;

    // Check if it's a Nuxt project
    if (!hasNuxtConfig(rootPath)) {
        await showError('No nuxt.config file found in workspace');
        return false;
    }

    await showInfo('Starting Nuxt dev server...');
    debugLog(`Starting dev server in ${rootPath}`);

    const config = getConfig();
    const packageManager = await detectPackageManager(rootPath);
    const devCommand = config.devCommand;

    debugLog(`Using package manager: ${packageManager}, command: ${devCommand}`);

    const args = packageManager === 'npm' ? ['run', devCommand] : [devCommand];

    const childProcess = spawn(packageManager, args, {
        cwd: rootPath,
        shell: true,
        detached: false,
        env: { ...process.env }
    });

    if (!childProcess.pid) {
        await showError('Failed to start dev server: could not get process ID');
        return false;
    }

    debugLog(`Dev server process started with PID ${childProcess.pid}`);

    // Create output channel for logs
    const outputChannel = getOrCreateOutputChannel(OUTPUT_CHANNELS.DEV_SERVER);
    outputChannel.clear();
    outputChannel.show(true);

    // Track server state
    let detectedPort = config.defaultPort;
    let detectedUrl = `http://localhost:${detectedPort}`;
    let serverStarted = false;

    // Handle stdout
    childProcess.stdout?.on('data', (data) => {
        const output = data.toString();
        outputChannel.append(output);

        // Extract port from output
        const portMatch = output.match(PROCESS_PATTERNS.PORT_REGEX);
        if (portMatch) {
            detectedPort = parseInt(portMatch[1]);
            detectedUrl = `http://localhost:${detectedPort}`;
            debugLog(`Detected server port: ${detectedPort}`);

            if (!serverStarted) {
                serverStarted = true;
                showInfo(`Nuxt dev server started on port ${detectedPort}`);

                // Open browser if configured
                if (config.openBrowserOnStart) {
                    vscode.env.openExternal(vscode.Uri.parse(detectedUrl));
                }
            }
        }
    });

    // Handle stderr
    childProcess.stderr?.on('data', (data) => {
        outputChannel.append(data.toString());
    });

    // Handle process close
    childProcess.on('close', (code) => {
        debugLog(`Server process closed with code ${code}`);
        outputChannel.appendLine(`\nServer process closed with code ${code}`);

        if (managedServer?.process === childProcess) {
            managedServer = null;
        }
    });

    // Handle process exit
    childProcess.on('exit', (code, signal) => {
        debugLog(`Server process exited with code ${code}, signal ${signal}`);
        outputChannel.appendLine(`\nServer process exited with code ${code}, signal ${signal}`);
    });

    // Handle errors
    childProcess.on('error', (error) => {
        debugLog('Server process error:', getErrorMessage(error));
        showError(`Failed to start server: ${getErrorMessage(error)}`);
        outputChannel.appendLine(`Error: ${getErrorMessage(error)}`);

        if (managedServer?.process === childProcess) {
            managedServer = null;
        }
    });

    // Create managed server instance
    managedServer = {
        process: childProcess,
        workingDir: rootPath,
        port: detectedPort,
        url: detectedUrl
    };

    // Wait for server to start listening (with timeout)
    const actualPort = await waitForProcessPort(childProcess.pid, DEFAULT_CONFIG.SERVER_START_TIMEOUT_MS);

    if (actualPort !== null) {
        // Update with actual detected port
        managedServer.port = actualPort;
        managedServer.url = `http://localhost:${actualPort}`;
        debugLog(`Server verified listening on port ${actualPort}`);

        if (!serverStarted) {
            await showInfo(`Nuxt dev server started on port ${actualPort}`);

            if (config.openBrowserOnStart) {
                vscode.env.openExternal(vscode.Uri.parse(managedServer.url));
            }
        }

        return true;
    } else {
        debugLog('Server did not start listening within timeout period');
        // Don't show error - it might still be starting, just slower
        return true; // Still return true as process was started
    }
}

/**
 * Stop the dev server
 */
export async function stopDevServer(): Promise<boolean> {
    if (!isManagedServerRunning() || !managedServer) {
        await showWarning('No managed dev server is running');
        return false;
    }

    const pid = managedServer.process.pid;
    const workingDir = managedServer.workingDir;

    if (!pid) {
        managedServer = null;
        return false;
    }

    debugLog(`Stopping dev server with PID ${pid}, working dir: ${workingDir}`);

    try {
        // Approach 1: Find and kill all nuxt processes in the working directory
        if (workingDir) {
            const killed = await killProcessesByWorkingDir(workingDir);
            debugLog(`Killed ${killed} processes in working directory`);
        }

        // Approach 2: Kill the process tree
        await killProcessTree(String(pid));

        // Wait for process to actually die
        const terminated = await verifyProcessTerminated(String(pid), DEFAULT_CONFIG.STOP_CLEANUP_WAIT_MS);

        if (!terminated) {
            debugLog(`Warning: Process ${pid} may not have terminated cleanly`);
        }

        managedServer = null;
        await showInfo('Dev server stopped');
        debugLog('Dev server stopped successfully');

        return true;
    } catch (error) {
        debugLog('Error stopping dev server:', getErrorMessage(error));
        await showError(`Failed to stop server: ${getErrorMessage(error)}`);
        managedServer = null;
        return false;
    }
}

/**
 * Restart the dev server
 * Fixes the race condition by properly awaiting all operations
 */
export async function restartDevServer(): Promise<boolean> {
    await showInfo('Restarting dev server...');
    debugLog('Restarting dev server');

    // Stop the server and wait
    await stopDevServer();

    // Wait for cleanup
    await sleep(DEFAULT_CONFIG.RESTART_DELAY_MS);

    // Start the server
    return await startDevServer();
}

/**
 * Cleanup on extension deactivation
 */
export async function cleanupManagedServer(): Promise<void> {
    if (managedServer && managedServer.process.pid) {
        debugLog('Cleaning up managed server on deactivation');
        try {
            await killProcessTree(String(managedServer.process.pid));
        } catch (error) {
            // Best effort cleanup
            debugLog('Error during cleanup:', getErrorMessage(error));
        }
    }
    managedServer = null;
}
