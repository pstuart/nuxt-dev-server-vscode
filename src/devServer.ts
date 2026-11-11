import * as vscode from 'vscode';
import { ChildProcess, spawn } from 'child_process';
import * as path from 'path';
import { ManagedServer, PackageManager } from './types';
import { LOCK_FILES, NUXT_CONFIG_FILES, OUTPUT_CHANNELS, DEFAULT_CONFIG } from './constants';
import {
    getOrCreateOutputChannel,
    showError,
    showInfo,
    showWarning,
    debugLog,
    getErrorMessage,
    getConfig,
    sleep,
    fileExists,
    openServerUrl
} from './utils';
import {
    killProcessTree,
    killProcessesByWorkingDir,
    waitForProcessTreePort,
    verifyProcessTerminated
} from './processManager';
import { onServerStart, onServerStop } from './autoKill';
import { forceStatusBarUpdate } from './statusBar';
import { isBinaryAvailable } from './platform';
import { createOutputPortProbe, isValidDevCommand } from './processLogic';
import { refuseIfUntrusted } from './workspaceTrust';
import { fallbackServerUrl, parsePrintedServerUrl, serverCommandArgs, validateServerOptions } from './serverUrl';

/**
 * Whitelist of allowed package managers
 */
const ALLOWED_PACKAGE_MANAGERS: readonly PackageManager[] = ['npm', 'yarn', 'pnpm', 'bun'];

/**
 * Check if a package manager's binary is available (implies allowlist membership,
 * since only allowlisted names can be configured or detected).
 */
async function isPackageManagerAvailable(manager: string): Promise<boolean> {
    return (ALLOWED_PACKAGE_MANAGERS as readonly string[]).includes(manager) && isBinaryAvailable(manager);
}

/**
 * The currently managed dev server instance
 */
let managedServer: ManagedServer | null = null;

function childHandleExited(child: ChildProcess): boolean {
    return child.exitCode !== null || child.signalCode !== null;
}

/**
 * Re-entrancy guard for startDevServer. `managedServer` is only assigned after the
 * async pre-flight + spawn, so without this two rapid start invocations could both
 * pass the running-check and spawn a server — orphaning the first.
 */
let startingServer = false;

/**
 * Per-child bookkeeping for the unexpected-exit warning. `close` and `exit` both
 * fire for one child, so `warned` keeps the announcement to exactly one warning,
 * and `planned` marks exits driven by our own stop/restart/auto-kill paths so the
 * warning is suppressed there.
 */
interface ChildExitState {
    warned: boolean;
    planned: boolean;
}
const childExitState = new WeakMap<ChildProcess, ChildExitState>();

const RESTART_ACTION = 'Restart';
const SHOW_OUTPUT_ACTION = 'Show Output';

/**
 * Announce an unexpected child exit exactly once (both 'close' and 'exit' fire for
 * one child). Suppressed for planned exits (stop/restart/auto-kill) and, via
 * showWarning, when showNotifications is false. 'Restart' starts a fresh managed
 * server; 'Show Output' reveals the "Nuxt Dev Server" output channel.
 */
function announceUnexpectedExit(
    child: ChildProcess,
    code: number | null,
    outputChannel: vscode.OutputChannel
): void {
    // The first close/exit event for a freshly spawned child is the unexpected one;
    // `clearManagedServerIfCurrent` runs after it and marks the sibling event planned
    // so the pair produces exactly one warning. stopDevServer/restart/auto-kill mark
    // their teardown planned up front, so those exits stay silent.
    let state = childExitState.get(child);
    if (!state) {
        state = { warned: false, planned: false };
        childExitState.set(child, state);
    }
    if (state.warned || state.planned) {
        return;
    }
    state.warned = true;
    void Promise.resolve(
        showWarning(`Nuxt dev server exited unexpectedly (code ${code})`, RESTART_ACTION, SHOW_OUTPUT_ACTION)
    ).then((choice) => {
        if (choice === RESTART_ACTION) {
            void startDevServer();
        } else if (choice === SHOW_OUTPUT_ACTION) {
            outputChannel.show(true);
        }
    }).catch(() => {});
}

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
    if (!managedServer) {
        return false;
    }
    return !childHandleExited(managedServer.process) && !managedServer.process.killed;
}

/**
 * Clear the managed server reference
 * Used when the server is killed externally (e.g., via list-and-kill)
 */
export function clearManagedServer(): void {
    managedServer = null;
    onServerStop();
    forceStatusBarUpdate();
}

/**
 * Shared teardown for the child close/exit/error handlers: only the child that
 * still owns `managedServer` clears state and updates the UI, so a stale
 * process's late event never clobbers a newer server.
 */
function clearManagedServerIfCurrent(child: ChildProcess): void {
    if (managedServer?.process === child) {
        managedServer = null;
        forceStatusBarUpdate();
        // Clear auto-kill state when the managed server goes away
        onServerStop();
        // This exit came from one of our own stop/restart/auto-kill paths, so the
        // close/exit handlers must not announce it as unexpected.
        const state = childExitState.get(child);
        if (state) {
            state.planned = true;
        }
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

        if (await isPackageManagerAvailable(preferredManager)) {
            debugLog(`Using preferred package manager: ${preferredManager}`);
            return preferredManager;
        }

        await showWarning(`Preferred package manager '${preferredManager}' not found. Falling back to auto-detection.`);
        debugLog(`Preferred package manager ${preferredManager} not found, falling back to auto-detection`);
    }

    // Auto-detect from lock files with binary verification
    const detectionOrder: Array<{ lockFile: string; manager: PackageManager }> = [
        { lockFile: LOCK_FILES.YARN, manager: 'yarn' },
        { lockFile: LOCK_FILES.PNPM, manager: 'pnpm' },
        { lockFile: LOCK_FILES.BUN, manager: 'bun' },
        { lockFile: LOCK_FILES.BUN_TEXT, manager: 'bun' },
    ];

    for (const { lockFile, manager } of detectionOrder) {
        const lockPath = path.join(rootPath, lockFile);
        const hasLockFile = await fileExists(lockPath);

        if (hasLockFile) {
            debugLog(`Found ${lockFile}`);
            if (await isPackageManagerAvailable(manager)) {
                debugLog(`Using ${manager} (lock file found and binary available)`);
                return manager;
            }

            await showWarning(`Found ${lockFile} but '${manager}' is not installed. Continuing detection...`);
            debugLog(`Found ${lockFile} but ${manager} is not installed, continuing...`);
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
 * Relative (from the workspace root) path of a discovered nuxt.config.
 * `workspace.findFiles` yields relative paths for a single-root workspace and
 * absolute ones for a multi-root workspace, so strip the root prefix either way.
 */
function relativeConfigPath(rootPath: string, uri: vscode.Uri): string {
    const raw = uri.fsPath;
    const prefix = rootPath.endsWith('/') ? rootPath : `${rootPath}/`;
    return raw.startsWith(prefix) ? raw.slice(prefix.length) : raw;
}

/**
 * Resolve the directory that holds the Nuxt project for the given workspace root.
 *
 * A monorepo keeps its config below the folder VS Code opens (root without
 * nuxt.config plus a nested `apps/web/nuxt.config.ts`), so the root itself is not
 * the project directory. Order: explicit `nuxt-dev-server.projectDirectory`, else a
 * single discovered nuxt.config, else the root when it carries a config itself.
 */
async function resolveProjectDirectory(rootPath: string): Promise<string | null> {
    const configured = vscode.workspace.getConfiguration('nuxt-dev-server').get<string>('projectDirectory', '');
    if (configured) {
        const resolved = path.isAbsolute(configured) ? configured : path.join(rootPath, configured);
        if (await hasNuxtConfig(resolved)) {
            debugLog(`Project directory from setting: ${resolved}`);
            return resolved;
        }
        await showWarning(`nuxt-dev-server.projectDirectory "${configured}" has no nuxt.config file. Falling back to discovery.`);
    }

    let uris: readonly vscode.Uri[];
    try {
        uris = await vscode.workspace.findFiles(
            new vscode.RelativePattern(
                rootPath,
                `**/{${NUXT_CONFIG_FILES.join(',')}}`,
            ),
            '**/node_modules/**',
        );
    } catch (error) {
        debugLog('findFiles failed:', getErrorMessage(error));
        uris = [];
    }

    const candidates = uris
        .map((uri) => relativeConfigPath(rootPath, uri))
        .filter((rel) => rel.length > 0 && rel !== '.')
        .sort();

    if (candidates.length === 0) {
        return (await hasNuxtConfig(rootPath)) ? rootPath : null;
    }

    const resolved = path.dirname(path.join(rootPath, candidates[0]));
    debugLog(`Discovered Nuxt project directory: ${resolved}`);
    return resolved;
}

/**
 * Start the dev server
 */
export async function startDevServer(): Promise<boolean> {
    if (isManagedServerRunning() || startingServer) {
        await showWarning('Dev server is already running');
        return false;
    }

    // Hold the guard across the async pre-flight + spawn (managedServer isn't set
    // until the end). `finally` clears it even if pre-flight throws, so a transient
    // failure can't permanently block future starts.
    startingServer = true;
    try {
        return await startDevServerInternal();
    } finally {
        startingServer = false;
    }
}

async function startDevServerInternal(): Promise<boolean> {
    // Workspace Trust: spawning package-manager scripts executes local package.json.
    if (await refuseIfUntrusted('start')) {
        return false;
    }

    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) {
        await showError('No workspace folder open');
        return false;
    }

    const rootPath = workspaceFolders[0].uri.fsPath;

    // Resolve the Nuxt project directory: the workspace root itself, or the nested
    // folder holding nuxt.config (e.g. a monorepo `apps/web`).
    const projectPath = await resolveProjectDirectory(rootPath);
    if (!projectPath) {
        await showError('No nuxt.config file found in workspace');
        return false;
    }

    await showInfo('Starting Nuxt dev server...');
    debugLog(`Starting dev server in ${projectPath}`);

    const config = getConfig();
    try {
        validateServerOptions(config);
    } catch (error) {
        await showError(getErrorMessage(error));
        return false;
    }
    const packageManager = await detectPackageManager(projectPath);
    const devCommand = config.devCommand;

    // Validate dev command to prevent injection
    if (!isValidDevCommand(devCommand)) {
        await showError(`Invalid dev command: "${devCommand}". Only alphanumeric characters, dashes, underscores, and colons are allowed.`);
        debugLog(`Invalid dev command rejected: ${devCommand}`);
        return false;
    }

    debugLog(`Using package manager: ${packageManager}, command: ${devCommand}`);

    // Build args array - this is safe as we've validated inputs
    const args = serverCommandArgs(packageManager, devCommand, config);

    // Spawn WITHOUT shell: true for security
    // This prevents command injection attacks
    const childProcess = spawn(packageManager, args, {
        cwd: projectPath,
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
    let detectedPort = config.port ?? config.defaultPort;
    let detectedUrl = fallbackServerUrl(detectedPort, config);
    let printedUrl: ReturnType<typeof parsePrintedServerUrl> = null;
    let outputBuffer = '';
    const outputPort = createOutputPortProbe();

    // Both streams can carry Nuxt's banner. Keep a bounded tail for split chunks.
    const handleOutput = (data: Buffer): void => {
        const output = data.toString();
        outputChannel.append(output);

        outputBuffer = (outputBuffer + output).slice(-16384);
        const parsed = parsePrintedServerUrl(outputBuffer);
        if (parsed && (!printedUrl || (!printedUrl.local && parsed.local) ||
            (parsed.local === printedUrl.local && parsed.url.startsWith(printedUrl.url) && parsed.url !== printedUrl.url))) {
            printedUrl = parsed;
            detectedPort = parsed.port;
            detectedUrl = parsed.url;
            outputPort.resolve(detectedPort);
            if (managedServer?.process === childProcess) {
                managedServer.port = detectedPort;
                managedServer.url = detectedUrl;
                forceStatusBarUpdate();
            }
            debugLog(`Detected server port: ${detectedPort}`);
        }
    };
    childProcess.stdout?.on('data', handleOutput);
    childProcess.stderr?.on('data', handleOutput);

    // Handle process close
    childProcess.on('close', (code) => {
        debugLog(`Server process closed with code ${code}`);
        outputChannel.appendLine(`\nServer process closed with code ${code}`);

        announceUnexpectedExit(childProcess, code, outputChannel);
        clearManagedServerIfCurrent(childProcess);
        outputPort.rejectIfPending(`server process closed with code ${code}`);
    });

    // Handle process exit
    childProcess.on('exit', (code, signal) => {
        debugLog(`Server process exited with code ${code}, signal ${signal}`);
        outputChannel.appendLine(`\nServer process exited with code ${code}, signal ${signal}`);

        announceUnexpectedExit(childProcess, code, outputChannel);
        clearManagedServerIfCurrent(childProcess);
        outputPort.rejectIfPending(`server process exited with code ${code}, signal ${signal}`);
    });

    // Handle errors
    childProcess.on('error', (error) => {
        debugLog('Server process error:', getErrorMessage(error));
        void Promise.resolve(showError(`Failed to start server: ${getErrorMessage(error)}`)).catch(() => {});
        outputChannel.appendLine(`Error: ${getErrorMessage(error)}`);

        clearManagedServerIfCurrent(childProcess);
        outputPort.rejectIfPending(`server process error: ${getErrorMessage(error)}`);
    });

    // Create managed server instance
    managedServer = {
        process: childProcess,
        workingDir: projectPath,
        port: detectedPort,
        url: detectedUrl
    };

    // Wait for server to start listening (with timeout).
    // outputPort is rejected when the child process exits before printing a port,
    // so the race resolves immediately instead of waiting for the polling loop.
    const discoveryController = new AbortController();
    let actualPort: number | null;
    try {
        actualPort = await Promise.race([
            outputPort.promise,
            waitForProcessTreePort(
                childProcess.pid,
                projectPath,
                detectedPort,
                DEFAULT_CONFIG.SERVER_START_TIMEOUT_MS,
                discoveryController.signal
            ),
        ]);
    } catch {
        // Child process exited before printing a port — treat as null.
        actualPort = null;
    }
    discoveryController.abort();

    if (actualPort !== null) {
        // Update with actual detected port
        if (managedServer?.process !== childProcess) {
            return false;
        }
        // A printed URL wins even when polling settles in the same turn.
        managedServer.port = printedUrl ? detectedPort : actualPort;
        managedServer.url = printedUrl ? detectedUrl : fallbackServerUrl(actualPort, config);
        debugLog(`Server verified listening on port ${managedServer.port}`);

        // The toast resolves on dismissal; startup must not wait for that UI action.
        void Promise.resolve(showInfo(`Nuxt dev server started on port ${managedServer.port}`)).catch(() => {});

        if (config.openBrowserOnStart) {
            void openServerUrl(managedServer.url);
        }

        // Notify auto-kill module that server has started
        onServerStart();

        return true;
    } else if (childProcess.exitCode !== null || childProcess.signalCode !== null) {
        // The process exited before it ever listened (e.g. no `dev` script, a
        // bad nuxt.config, an immediate crash). waitForProcessTreePort collapses
        // "died" and "slow start" into null; only the dead case is a failure —
        // surface it instead of silently reporting success.
        debugLog('Server process exited before listening');
        await showError(
            'Nuxt dev server exited before it started listening — see the "Nuxt Dev Server" output for details.'
        );
        // Clear auto-kill state when server exits before starting
        onServerStop();
        return false;
    } else {
        debugLog('Server did not start listening within timeout period');
        // Process is still alive — it may just be a slow start. Notify auto-kill
        // (the process was started) and leave it running.
        onServerStart();
        return true;
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

    // Our own teardown owns this child's exit: mark it planned before killing so the
    // close/exit handlers (stop, restart and auto-kill all funnel through here)
    // skip the unexpected-exit warning.
    const stoppingHandle = managedServer.process;
    let stoppingState = childExitState.get(stoppingHandle);
    if (!stoppingState) {
        stoppingState = { warned: false, planned: true };
        childExitState.set(stoppingHandle, stoppingState);
    } else {
        stoppingState.planned = true;
    }

    const pid = stoppingHandle.pid;
    const workingDir = managedServer.workingDir;

    if (!pid) {
        managedServer = null;
        onServerStop();
        forceStatusBarUpdate();
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

        const handleDead = childHandleExited(managedServer.process);
        const terminated = handleDead
            || await verifyProcessTerminated(String(pid), DEFAULT_CONFIG.STOP_CLEANUP_WAIT_MS);

        if (!terminated) {
            debugLog(`Process ${pid} did not terminate`);
            await showError('Dev server did not terminate; not reporting a successful stop');
            return false;
        }

        managedServer = null;
        forceStatusBarUpdate();
        onServerStop();

        await showInfo('Dev server stopped');
        debugLog('Dev server stopped successfully');

        return true;
    } catch (error) {
        debugLog('Error stopping dev server:', getErrorMessage(error));
        await showError(`Failed to stop server: ${getErrorMessage(error)}`);
        managedServer = null;
        forceStatusBarUpdate();
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

    if (isManagedServerRunning()) {
        const stopped = await stopDevServer();
        if (!stopped || isManagedServerRunning()) {
            await showError('Could not stop the running server; restart aborted to avoid a second instance');
            return false;
        }
        await sleep(DEFAULT_CONFIG.RESTART_DELAY_MS);
    }

    return await startDevServer();
}

/**
 * Cleanup on extension deactivation
 */
export async function cleanupManagedServer(): Promise<void> {
    if (!managedServer) {
        return;
    }

    const pid = managedServer.process.pid;
    const workingDir = managedServer.workingDir;
    debugLog('Cleaning up managed server on deactivation');
    try {
        if (workingDir) {
            await killProcessesByWorkingDir(workingDir);
        }
        if (pid) {
            await killProcessTree(String(pid));
        }
    } catch (error) {
        debugLog('Error during cleanup:', getErrorMessage(error));
    }
    managedServer = null;
}
