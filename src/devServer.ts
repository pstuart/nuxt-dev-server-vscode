import * as vscode from 'vscode';
import { spawn, ChildProcess, exec } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';
import * as fs from 'fs/promises';
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
import { onServerStart, onServerStop } from './autoKill';

const execAsync = promisify(exec);

/**
 * Whitelist of allowed package managers
 */
const ALLOWED_PACKAGE_MANAGERS: PackageManager[] = ['npm', 'yarn', 'pnpm', 'bun'];

/**
 * Validate devCommand to prevent command injection
 * Only allows alphanumeric, dash, underscore, colon, and forward slash
 */
function isValidDevCommand(command: string): boolean {
    if (!command || typeof command !== 'string') {
        return false;
    }
    // Allow npm script names: alphanumeric, dash, underscore, colon
    // This prevents injection like "dev; rm -rf /" or "dev && malicious"
    const validPattern = /^[a-zA-Z0-9_:-]+$/;
    return validPattern.test(command) && command.length < 100;
}

/**
 * Validate package manager is in whitelist
 */
function isValidPackageManager(manager: string): manager is PackageManager {
    return ALLOWED_PACKAGE_MANAGERS.includes(manager as PackageManager);
}

/**
 * Check if a package manager binary is available
 */
async function isPackageManagerAvailable(manager: PackageManager): Promise<boolean> {
    try {
        // Use which command to check if binary exists
        // Sanitize input even though it's from whitelist
        if (!isValidPackageManager(manager)) {
            return false;
        }

        const { stdout } = await execAsync(`which ${manager} 2>/dev/null || echo ''`);
        const binaryPath = stdout.trim();

        if (binaryPath) {
            debugLog(`Package manager '${manager}' found at: ${binaryPath}`);
            return true;
        }

        debugLog(`Package manager '${manager}' not found in PATH`);
        return false;
    } catch (error) {
        debugLog(`Error checking for ${manager}:`, getErrorMessage(error));
        return false;
    }
}

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
 * Check if a file exists (async replacement for fs.existsSync)
 */
async function fileExists(filePath: string): Promise<boolean> {
    try {
        await fs.access(filePath);
        return true;
    } catch {
        return false;
    }
}

/**
 * Detect package manager from lock files with binary verification
 */
async function detectPackageManager(rootPath: string): Promise<PackageManager> {
    const config = getConfig();

    // Use preferred if set and not auto
    if (config.preferredPackageManager !== 'auto') {
        const preferredManager = config.preferredPackageManager;

        if (!isValidPackageManager(preferredManager)) {
            debugLog(`Invalid preferred package manager: ${preferredManager}`);
        } else {
            const isAvailable = await isPackageManagerAvailable(preferredManager);

            if (isAvailable) {
                debugLog(`Using preferred package manager: ${preferredManager}`);
                return preferredManager;
            } else {
                await showWarning(`Preferred package manager '${preferredManager}' not found. Falling back to auto-detection.`);
                debugLog(`Preferred package manager ${preferredManager} not found, falling back to auto-detection`);
            }
        }
    }

    // Auto-detect from lock files with binary verification
    const detectionOrder: Array<{ lockFile: string; manager: PackageManager }> = [
        { lockFile: LOCK_FILES.YARN, manager: 'yarn' },
        { lockFile: LOCK_FILES.PNPM, manager: 'pnpm' },
        { lockFile: LOCK_FILES.BUN, manager: 'bun' },
    ];

    for (const { lockFile, manager } of detectionOrder) {
        const lockPath = path.join(rootPath, lockFile);
        const hasLockFile = await fileExists(lockPath);

        if (hasLockFile) {
            debugLog(`Found ${lockFile}`);
            const isAvailable = await isPackageManagerAvailable(manager);

            if (isAvailable) {
                debugLog(`Using ${manager} (lock file found and binary available)`);
                return manager;
            } else {
                await showWarning(`Found ${lockFile} but '${manager}' is not installed. Continuing detection...`);
                debugLog(`Found ${lockFile} but ${manager} is not installed, continuing...`);
            }
        }
    }

    // Default to npm (should always be available with Node.js)
    debugLog('Defaulting to npm');
    return 'npm';
}

/**
 * Check if workspace has a Nuxt configuration file
 */
async function hasNuxtConfig(rootPath: string): Promise<boolean> {
    for (const configFile of NUXT_CONFIG_FILES) {
        const configPath = path.join(rootPath, configFile);
        if (await fileExists(configPath)) {
            debugLog(`Found Nuxt config: ${configFile}`);
            return true;
        }
    }
    return false;
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

    // Check if it's a Nuxt project (async)
    if (!(await hasNuxtConfig(rootPath))) {
        await showError('No nuxt.config file found in workspace');
        return false;
    }

    await showInfo('Starting Nuxt dev server...');
    debugLog(`Starting dev server in ${rootPath}`);

    const config = getConfig();
    const packageManager = await detectPackageManager(rootPath);
    const devCommand = config.devCommand;

    // Validate dev command to prevent injection
    if (!isValidDevCommand(devCommand)) {
        await showError(`Invalid dev command: "${devCommand}". Only alphanumeric characters, dashes, underscores, and colons are allowed.`);
        debugLog(`Invalid dev command rejected: ${devCommand}`);
        return false;
    }

    debugLog(`Using package manager: ${packageManager}, command: ${devCommand}`);

    // Build args array - this is safe as we've validated inputs
    const args = packageManager === 'npm' ? ['run', devCommand] : [devCommand];

    // Spawn WITHOUT shell: true for security
    // This prevents command injection attacks
    const childProcess = spawn(packageManager, args, {
        cwd: rootPath,
        shell: false,  // SECURITY: Don't use shell to prevent injection
        detached: false,
        env: { ...process.env },
        stdio: ['ignore', 'pipe', 'pipe']  // Explicitly configure stdio
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
            detectedPort = parseInt(portMatch[1], 10);
            detectedUrl = `http://localhost:${detectedPort}`;
            debugLog(`Detected server port: ${detectedPort}`);

            if (!serverStarted) {
                serverStarted = true;
                void showInfo(`Nuxt dev server started on port ${detectedPort}`);

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
        void showError(`Failed to start server: ${getErrorMessage(error)}`);
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

        // Notify auto-kill module that server has started
        onServerStart();

        return true;
    } else {
        debugLog('Server did not start listening within timeout period');
        // Notify auto-kill module anyway (process was started)
        onServerStart();
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

        // Notify auto-kill module that server has stopped
        onServerStop();

        await showInfo('Dev server stopped');
        debugLog('Dev server stopped successfully');

        return true;
    } catch (error) {
        debugLog('Error stopping dev server:', getErrorMessage(error));
        await showError(`Failed to stop server: ${getErrorMessage(error)}`);
        managedServer = null;
        onServerStop(); // Clear tracking even on error
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
