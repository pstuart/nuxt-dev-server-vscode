import * as vscode from 'vscode';
import { exec, spawn, ChildProcess } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';
import * as fs from 'fs';

const execAsync = promisify(exec);

// PID validation regex - only allow numeric PIDs
const PID_REGEX = /^\d+$/;

interface NuxtProcess {
    pid: string;
    command: string;
    workingDir: string;
    port?: string;
}

interface ServerTrackingInfo {
    startTime: number;
    lastActivity: number;
    outputChannel: vscode.OutputChannel | null;
}

// Global state
let statusBarItem: vscode.StatusBarItem;
let devServerProcess: ChildProcess | null = null;
let devServerWorkingDir: string | null = null;
let serverPort = 3000;
let serverUrl = `http://localhost:${serverPort}`;
let updateInterval: NodeJS.Timeout | null = null;
let autoKillCheckInterval: NodeJS.Timeout | null = null;
let fileWatcher: vscode.FileSystemWatcher | null = null;
let serverTracking: ServerTrackingInfo = {
    startTime: 0,
    lastActivity: 0,
    outputChannel: null
};

// Helper function to get configuration
function getConfig() {
    return vscode.workspace.getConfiguration('nuxt-dev-server');
}

// Helper function to validate PIDs
function isValidPID(pid: string | number | undefined): boolean {
    if (pid === undefined || pid === null) {
        return false;
    }
    return PID_REGEX.test(pid.toString());
}

// Helper function to safely parse JSON
function safeJSONParse<T>(content: string, fallback: T): T {
    try {
        return JSON.parse(content) as T;
    } catch (error) {
        console.error('JSON parse error:', error);
        return fallback;
    }
}

// Helper function to show notifications based on settings
function showNotification(type: 'info' | 'warning' | 'error', message: string) {
    if (!getConfig().get<boolean>('showNotifications', true)) {
        return;
    }

    switch (type) {
        case 'info':
            vscode.window.showInformationMessage(message);
            break;
        case 'warning':
            vscode.window.showWarningMessage(message);
            break;
        case 'error':
            vscode.window.showErrorMessage(message);
            break;
    }
}

// Get or create a single output channel for the dev server
function getOutputChannel(): vscode.OutputChannel {
    if (!serverTracking.outputChannel) {
        serverTracking.outputChannel = vscode.window.createOutputChannel('Nuxt Dev Server');
    }
    return serverTracking.outputChannel;
}

export function activate(context: vscode.ExtensionContext) {
    console.log('Nuxt Dev Server Manager activated');

    // Create status bar item
    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    statusBarItem.command = 'nuxt-dev-server.showMenu';
    context.subscriptions.push(statusBarItem);

    // Register commands
    context.subscriptions.push(
        vscode.commands.registerCommand('nuxt-dev-server.start', startDevServer),
        vscode.commands.registerCommand('nuxt-dev-server.stop', stopDevServer),
        vscode.commands.registerCommand('nuxt-dev-server.restart', restartDevServer),
        vscode.commands.registerCommand('nuxt-dev-server.showAll', showAllInstances),
        vscode.commands.registerCommand('nuxt-dev-server.killAll', killAllNuxtInstances),
        vscode.commands.registerCommand('nuxt-dev-server.listAndKill', listAndKillInstances),
        vscode.commands.registerCommand('nuxt-dev-server.openBrowser', openInBrowser),
        vscode.commands.registerCommand('nuxt-dev-server.showVersion', showNuxtVersion),
        vscode.commands.registerCommand('nuxt-dev-server.showMenu', showQuickPick)
    );

    // Setup file watcher for activity tracking
    setupFileWatcher(context);

    // Start monitoring
    updateStatusBar();
    const updateIntervalMs = getConfig().get<number>('statusBarUpdateInterval', 3000);
    updateInterval = setInterval(updateStatusBar, updateIntervalMs);

    // Start auto-kill check interval (check every 30 seconds)
    autoKillCheckInterval = setInterval(checkAutoKillConditions, 30000);

    // Register configuration change listener
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration((e) => {
            if (e.affectsConfiguration('nuxt-dev-server.statusBarUpdateInterval')) {
                // Restart update interval with new value
                if (updateInterval) {
                    clearInterval(updateInterval);
                }
                const newInterval = getConfig().get<number>('statusBarUpdateInterval', 3000);
                updateInterval = setInterval(updateStatusBar, newInterval);
            }
        })
    );
}

export function deactivate() {
    // Clear intervals
    if (updateInterval) {
        clearInterval(updateInterval);
        updateInterval = null;
    }
    if (autoKillCheckInterval) {
        clearInterval(autoKillCheckInterval);
        autoKillCheckInterval = null;
    }

    // Dispose file watcher
    if (fileWatcher) {
        fileWatcher.dispose();
        fileWatcher = null;
    }

    // Cleanup output channel
    if (serverTracking.outputChannel) {
        serverTracking.outputChannel.dispose();
        serverTracking.outputChannel = null;
    }

    // Graceful shutdown of dev server
    if (devServerProcess && devServerProcess.pid) {
        const pid = devServerProcess.pid;
        if (isValidPID(pid)) {
            try {
                // Try graceful shutdown first
                console.log(`Gracefully shutting down server with PID ${pid}`);
                process.kill(pid, 'SIGTERM');

                // Force kill after timeout
                setTimeout(() => {
                    try {
                        if (devServerProcess && !devServerProcess.killed) {
                            console.log(`Force killing server with PID ${pid}`);
                            execAsync(`pkill -9 -P ${pid}`).catch(() => {});
                            process.kill(pid, 'SIGKILL');
                        }
                    } catch (error) {
                        // Best effort cleanup
                    }
                }, 2000);
            } catch (error) {
                console.error('Error during deactivation cleanup:', error);
            }
        }
    }
    devServerProcess = null;
    devServerWorkingDir = null;
}

// Setup file watcher for activity tracking
function setupFileWatcher(context: vscode.ExtensionContext) {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) {
        return;
    }

    // Watch for file changes in the workspace (for idle detection)
    const pattern = new vscode.RelativePattern(workspaceFolders[0], '**/*');
    fileWatcher = vscode.workspace.createFileSystemWatcher(pattern);

    const updateActivity = () => {
        if (devServerProcess && !devServerProcess.killed) {
            serverTracking.lastActivity = Date.now();
        }
    };

    fileWatcher.onDidChange(updateActivity);
    fileWatcher.onDidCreate(updateActivity);
    fileWatcher.onDidDelete(updateActivity);

    context.subscriptions.push(fileWatcher);
}

// Check auto-kill conditions
async function checkAutoKillConditions() {
    if (!devServerProcess || devServerProcess.killed) {
        return;
    }

    const now = Date.now();
    const autoKillTimeout = getConfig().get<number>('autoKillTimeout', 0);
    const autoKillIdleTime = getConfig().get<number>('autoKillIdleTime', 0);

    // Check timeout (total runtime)
    if (autoKillTimeout > 0 && serverTracking.startTime > 0) {
        const runtimeMinutes = (now - serverTracking.startTime) / (1000 * 60);
        if (runtimeMinutes >= autoKillTimeout) {
            showNotification('warning', `Dev server auto-killed after ${autoKillTimeout} minutes`);
            await stopDevServer();
            return;
        }
    }

    // Check idle time
    if (autoKillIdleTime > 0 && serverTracking.lastActivity > 0) {
        const idleMinutes = (now - serverTracking.lastActivity) / (1000 * 60);
        if (idleMinutes >= autoKillIdleTime) {
            showNotification('warning', `Dev server auto-killed after ${autoKillIdleTime} minutes of inactivity`);
            await stopDevServer();
            return;
        }
    }

    // Check max extra servers
    const maxExtraServers = getConfig().get<number>('maxExtraServers', 0);
    const enableAutoCleanup = getConfig().get<boolean>('enableAutoCleanup', false);

    if (maxExtraServers > 0 || enableAutoCleanup) {
        const allProcesses = await getRunningNuxtProcesses();
        const managedPid = devServerProcess?.pid?.toString();

        // Filter out our managed process
        const extraProcesses = allProcesses.filter(p => p.pid !== managedPid);

        if (maxExtraServers > 0 && extraProcesses.length > maxExtraServers) {
            // Kill oldest extras (assuming lower PIDs are older)
            const toKill = extraProcesses
                .sort((a, b) => parseInt(a.pid) - parseInt(b.pid))
                .slice(0, extraProcesses.length - maxExtraServers);

            for (const proc of toKill) {
                if (isValidPID(proc.pid)) {
                    try {
                        await killProcessGracefully(proc.pid);
                        showNotification('info', `Auto-killed extra server (PID ${proc.pid}) due to maxExtraServers limit`);
                    } catch (error) {
                        console.error(`Failed to kill extra server ${proc.pid}:`, error);
                    }
                }
            }
        } else if (enableAutoCleanup && extraProcesses.length > 0) {
            showNotification('warning', `${extraProcesses.length} unmanaged Nuxt server(s) detected`);
        }
    }
}

async function showQuickPick() {
    const runningCount = await getRunningNuxtProcessCount();
    const isOwnServerRunning = devServerProcess !== null && !devServerProcess.killed;

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
            description: serverUrl,
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

    if (selected) {
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
                await killAllNuxtInstances();
                break;
            case '$(globe) Open in Browser':
                await openInBrowser();
                break;
            case '$(info) Show Nuxt Version':
                await showNuxtVersion();
                break;
        }
    }
}

async function updateStatusBar() {
    const runningCount = await getRunningNuxtProcessCount();
    const isOwnServerRunning = devServerProcess !== null && !devServerProcess.killed;

    if (isOwnServerRunning) {
        statusBarItem.text = `$(radio-tower) Nuxt Dev (${runningCount})`;
        statusBarItem.tooltip = `Nuxt server running on ${serverUrl}\nTotal instances: ${runningCount}\nClick for options`;
        statusBarItem.backgroundColor = undefined;
    } else if (runningCount > 0) {
        statusBarItem.text = `$(radio-tower) Nuxt (${runningCount})`;
        statusBarItem.tooltip = `${runningCount} Nuxt instance(s) detected\nNo managed server running\nClick for options`;
        statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    } else {
        statusBarItem.text = `$(circle-slash) Nuxt Dev`;
        statusBarItem.tooltip = 'No Nuxt server running\nClick to start';
        statusBarItem.backgroundColor = undefined;
    }

    statusBarItem.show();
}

async function getRunningNuxtProcessCount(): Promise<number> {
    const processes = await getRunningNuxtProcesses();
    return processes.length;
}

// Helper function to kill a process gracefully (SIGTERM then SIGKILL)
async function killProcessGracefully(pid: string): Promise<void> {
    if (!isValidPID(pid)) {
        throw new Error(`Invalid PID: ${pid}`);
    }

    const gracefulTimeout = getConfig().get<number>('gracefulShutdownTimeout', 5000);

    try {
        // Try graceful shutdown first
        process.kill(parseInt(pid), 'SIGTERM');
        console.log(`Sent SIGTERM to PID ${pid}`);

        // Wait for graceful shutdown
        await new Promise((resolve) => {
            const checkInterval = setInterval(() => {
                try {
                    // Check if process still exists (signal 0 doesn't kill, just checks)
                    process.kill(parseInt(pid), 0);
                } catch (error) {
                    // Process doesn't exist anymore
                    clearInterval(checkInterval);
                    resolve(true);
                }
            }, 100);

            // Timeout for graceful shutdown
            setTimeout(() => {
                clearInterval(checkInterval);
                resolve(false);
            }, gracefulTimeout);
        });

        // If process still exists, force kill
        try {
            process.kill(parseInt(pid), 0);
            // Still running, force kill
            console.log(`Process ${pid} still running after SIGTERM, sending SIGKILL`);
            await execAsync(`kill -9 ${pid}`);
            await execAsync(`pkill -9 -P ${pid}`).catch(() => {}); // Kill children
        } catch (error) {
            // Process already dead
            console.log(`Process ${pid} terminated gracefully`);
        }
    } catch (error: any) {
        if (error.code === 'ESRCH') {
            // Process doesn't exist, that's fine
            return;
        }
        throw error;
    }
}

async function getRunningNuxtProcesses(): Promise<NuxtProcess[]> {
    try {
        // First, find all node processes that contain "nuxt" and "dev" or "preview"
        const { stdout: psOut } = await execAsync('ps -eo pid,command | grep -iE "node.*nuxt.*(dev|preview)" | grep -v grep');

        if (!psOut.trim()) {
            return [];
        }

        const lines = psOut.trim().split('\n');
        const processMap = new Map<string, NuxtProcess>();

        for (const line of lines) {
            const match = line.trim().match(/^(\d+)\s+(.+)$/);
            if (!match) {
                continue;
            }

            const pid = match[1];
            const fullCommand = match[2];

            // Validate PID before using it
            if (!isValidPID(pid)) {
                console.warn(`Invalid PID detected: ${pid}`);
                continue;
            }

            // Skip if already processed
            if (processMap.has(pid)) {
                continue;
            }

            // Verify this process is actually listening on a port
            let port: string | undefined;
            try {
                const { stdout: lsofOut } = await execAsync(`lsof -Pan -p ${pid} -iTCP -sTCP:LISTEN 2>/dev/null`);
                const portMatch = lsofOut.match(/:(\d+)\s+\(LISTEN\)/);
                if (portMatch) {
                    port = portMatch[1];
                }
            } catch (error) {
                // Not listening on any port, skip this process
                continue;
            }

            // Only include if it has a listening port (actual server)
            if (!port) {
                continue;
            }

            // Get working directory
            let workingDir = 'Unknown';
            try {
                const { stdout: cwdOut } = await execAsync(`lsof -p ${pid} 2>/dev/null | grep cwd | awk '{print $NF}'`);
                workingDir = cwdOut.trim() || 'Unknown';
            } catch (error) {
                // Ignore if we can't get working dir
            }

            // Sanitize working directory path
            const homeDir = process.env.HOME;
            if (homeDir && workingDir.startsWith(homeDir)) {
                workingDir = workingDir.replace(homeDir, '~');
            }

            processMap.set(pid, {
                pid,
                command: fullCommand.length > 80 ? fullCommand.substring(0, 77) + '...' : fullCommand,
                workingDir,
                port
            });
        }

        return Array.from(processMap.values());
    } catch (error) {
        // If ps fails, return empty
        console.error('Error getting running Nuxt processes:', error);
        return [];
    }
}

async function startDevServer() {
    if (devServerProcess && !devServerProcess.killed) {
        showNotification('warning', 'Dev server is already running');
        return;
    }

    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) {
        showNotification('error', 'No workspace folder open');
        return;
    }

    const rootPath = workspaceFolders[0].uri.fsPath;

    // Check if it's a Nuxt project
    const nuxtConfigExists = fs.existsSync(path.join(rootPath, 'nuxt.config.ts')) ||
                            fs.existsSync(path.join(rootPath, 'nuxt.config.js')) ||
                            fs.existsSync(path.join(rootPath, 'nuxt.config.mjs')) ||
                            fs.existsSync(path.join(rootPath, 'nuxt.config.mts'));

    if (!nuxtConfigExists) {
        showNotification('error', 'No nuxt.config file found in workspace');
        return;
    }

    // Show progress notification
    await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: "Starting Nuxt dev server...",
        cancellable: false
    }, async (progress) => {
        progress.report({ increment: 0 });

        // Store the working directory for later cleanup
        devServerWorkingDir = rootPath;

        // Get custom command or auto-detect
        const customCommand = getConfig().get<string>('customDevCommand', '');
        let command: string;
        let args: string[];

        if (customCommand) {
            // Parse custom command
            const parts = customCommand.split(' ');
            command = parts[0];
            args = parts.slice(1);
        } else {
            // Determine package manager
            const packageManager = fs.existsSync(path.join(rootPath, 'yarn.lock')) ? 'yarn' :
                                  fs.existsSync(path.join(rootPath, 'pnpm-lock.yaml')) ? 'pnpm' :
                                  fs.existsSync(path.join(rootPath, 'bun.lockb')) ? 'bun' : 'npm';

            command = packageManager;
            args = packageManager === 'npm' ? ['run', 'dev'] : ['dev'];
        }

        progress.report({ increment: 20 });

        devServerProcess = spawn(command, args, {
            cwd: rootPath,
            shell: true,
            detached: false,
            env: { ...process.env }
        });

        // Initialize server tracking
        const now = Date.now();
        serverTracking.startTime = now;
        serverTracking.lastActivity = now;

        // Get default port from config
        serverPort = getConfig().get<number>('defaultPort', 3000);
        serverUrl = `http://localhost:${serverPort}`;

        // Get or create output channel for logs
        const outputChannel = getOutputChannel();
        outputChannel.clear();
        outputChannel.show(true);
        outputChannel.appendLine(`Starting Nuxt dev server with command: ${command} ${args.join(' ')}`);
        outputChannel.appendLine(`Working directory: ${rootPath}`);
        outputChannel.appendLine(`Timestamp: ${new Date().toISOString()}\n`);

        progress.report({ increment: 50 });

        devServerProcess.stdout?.on('data', (data) => {
            const output = data.toString();
            outputChannel.append(output);

            // Update activity timestamp
            serverTracking.lastActivity = Date.now();

            // Extract port from output
            const portMatch = output.match(/http:\/\/localhost:(\d+)/);
            if (portMatch) {
                serverPort = parseInt(portMatch[1]);
                serverUrl = `http://localhost:${serverPort}`;
                showNotification('info', `Nuxt server started on ${serverUrl}`);
            }
        });

        devServerProcess.stderr?.on('data', (data) => {
            const output = data.toString();
            outputChannel.append(output);
            serverTracking.lastActivity = Date.now();
        });

        devServerProcess.on('close', (code) => {
            outputChannel.appendLine(`\n[${new Date().toISOString()}] Server process closed with code ${code}`);
            devServerProcess = null;
            devServerWorkingDir = null;
            serverTracking.startTime = 0;
            serverTracking.lastActivity = 0;
            updateStatusBar();

            if (code !== 0 && code !== null) {
                showNotification('error', `Dev server exited with code ${code}`);
            }
        });

        devServerProcess.on('exit', (code, signal) => {
            outputChannel.appendLine(`[${new Date().toISOString()}] Server process exited with code ${code}, signal ${signal}`);
        });

        devServerProcess.on('error', (error) => {
            showNotification('error', `Failed to start server: ${error.message}`);
            outputChannel.appendLine(`\nError: ${error.message}`);
            devServerProcess = null;
            devServerWorkingDir = null;
            serverTracking.startTime = 0;
            serverTracking.lastActivity = 0;
            updateStatusBar();
        });

        progress.report({ increment: 100 });
        await new Promise(resolve => setTimeout(resolve, 1000)); // Show progress briefly
    });

    updateStatusBar();
}

async function stopDevServer() {
    if (!devServerProcess || devServerProcess.killed) {
        showNotification('warning', 'No managed dev server is running');
        return;
    }

    const pid = devServerProcess.pid;
    const workingDir = devServerWorkingDir;

    if (!pid || !isValidPID(pid)) {
        console.error('Invalid PID for dev server process');
        devServerProcess = null;
        devServerWorkingDir = null;
        serverTracking.startTime = 0;
        serverTracking.lastActivity = 0;
        updateStatusBar();
        return;
    }

    console.log(`Stopping dev server with PID ${pid}, working dir: ${workingDir}`);

    await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: "Stopping Nuxt dev server...",
        cancellable: false
    }, async (progress) => {
        progress.report({ increment: 0 });

        try {
            // Approach 1: Find and gracefully kill all nuxt processes in the working directory
            if (workingDir) {
                try {
                    console.log(`Finding nuxt processes in ${workingDir}`);
                    const processes = await getRunningNuxtProcesses();
                    const homeDir = process.env.HOME || '';
                    const matchingProcesses = processes.filter(proc => {
                        const procDir = proc.workingDir.replace('~', homeDir);
                        return procDir === workingDir;
                    });

                    console.log(`Found ${matchingProcesses.length} matching processes`);
                    progress.report({ increment: 30 });

                    for (const proc of matchingProcesses) {
                        console.log(`Gracefully killing process ${proc.pid} on port ${proc.port}`);
                        try {
                            await killProcessGracefully(proc.pid);
                        } catch (error) {
                            console.log(`Failed to kill ${proc.pid}:`, error);
                        }
                    }
                } catch (error) {
                    console.log(`Failed to find/kill nuxt processes:`, error);
                }
            }

            progress.report({ increment: 60 });

            // Approach 2: Kill the shell process tree gracefully
            try {
                // Try graceful shutdown first
                console.log(`Sending SIGTERM to process tree for PID ${pid}`);
                process.kill(pid, 'SIGTERM');

                // Wait for graceful shutdown
                const gracefulTimeout = getConfig().get<number>('gracefulShutdownTimeout', 5000);
                await new Promise(resolve => setTimeout(resolve, gracefulTimeout));

                progress.report({ increment: 80 });

                // Check if process still exists
                try {
                    process.kill(pid, 0); // Check if alive
                    // Still running, force kill
                    console.log(`Process ${pid} still running, forcing shutdown`);
                    await execAsync(`pkill -9 -P ${pid}`).catch(() => {});
                    process.kill(pid, 'SIGKILL');
                } catch (error) {
                    // Process already terminated
                    console.log(`Process ${pid} terminated gracefully`);
                }
            } catch (error) {
                console.log(`Error during shutdown:`, error);
            }

            // Wait a moment for complete cleanup
            await new Promise(resolve => setTimeout(resolve, 500));

            progress.report({ increment: 100 });

            devServerProcess = null;
            devServerWorkingDir = null;
            serverTracking.startTime = 0;
            serverTracking.lastActivity = 0;
            showNotification('info', 'Dev server stopped');
            updateStatusBar();
        } catch (error: any) {
            console.error(`Error stopping dev server:`, error);
            showNotification('error', `Failed to stop server: ${error.message}`);
            devServerProcess = null;
            devServerWorkingDir = null;
            serverTracking.startTime = 0;
            serverTracking.lastActivity = 0;
            updateStatusBar();
        }
    });
}

async function restartDevServer() {
    vscode.window.showInformationMessage('Restarting dev server...');
    await stopDevServer();
    // Give a moment for cleanup before restarting
    setTimeout(() => startDevServer(), 1500);
}

async function showAllInstances() {
    try {
        const processes = await getRunningNuxtProcesses();

        if (processes.length === 0) {
            vscode.window.showInformationMessage('No Nuxt instances found');
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
        const outputChannel = vscode.window.createOutputChannel('Nuxt Instances');
        outputChannel.clear();
        outputChannel.appendLine(message);
        outputChannel.show();

        vscode.window.showInformationMessage(`Found ${processes.length} Nuxt instance(s). See 'Nuxt Instances' output for details.`);
    } catch (error: any) {
        vscode.window.showErrorMessage(`Failed to get instances: ${error.message}`);
    }
}

async function listAndKillInstances() {
    try {
        const processes = await getRunningNuxtProcesses();

        if (processes.length === 0) {
            vscode.window.showInformationMessage('No Nuxt instances found');
            return;
        }

        interface ProcessQuickPickItem extends vscode.QuickPickItem {
            process: NuxtProcess;
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

        let killedCount = 0;
        for (const item of selected) {
            try {
                if (isValidPID(item.process.pid)) {
                    await killProcessGracefully(item.process.pid);
                    if (devServerProcess && devServerProcess.pid?.toString() === item.process.pid) {
                        devServerProcess = null;
                        devServerWorkingDir = null;
                        serverTracking.startTime = 0;
                        serverTracking.lastActivity = 0;
                    }
                    killedCount++;
                } else {
                    console.warn(`Skipping invalid PID: ${item.process.pid}`);
                }
            } catch (error: any) {
                showNotification('error', `Failed to kill PID ${item.process.pid}: ${error.message}`);
            }
        }

        showNotification('info', `Killed ${killedCount} of ${selected.length} instance(s)`);
        updateStatusBar();
    } catch (error: any) {
        vscode.window.showErrorMessage(`Failed to list instances: ${error.message}`);
    }
}

async function killAllNuxtInstances() {
    try {
        const processes = await getRunningNuxtProcesses();
        const count = processes.length;

        if (count === 0) {
            showNotification('info', 'No Nuxt instances found');
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

        // Kill each process gracefully
        let killedCount = 0;
        for (const proc of processes) {
            if (isValidPID(proc.pid)) {
                try {
                    await killProcessGracefully(proc.pid);
                    killedCount++;

                    // Check if it was our managed process
                    if (devServerProcess && devServerProcess.pid?.toString() === proc.pid) {
                        devServerProcess = null;
                        devServerWorkingDir = null;
                        serverTracking.startTime = 0;
                        serverTracking.lastActivity = 0;
                    }
                } catch (error) {
                    console.error(`Failed to kill process ${proc.pid}:`, error);
                }
            }
        }

        showNotification('info', `Killed ${killedCount} of ${count} Nuxt instance(s)`);
        updateStatusBar();
    } catch (error: any) {
        showNotification('error', `Failed to kill instances: ${error.message}`);
    }
}

async function openInBrowser() {
    const runningCount = await getRunningNuxtProcessCount();

    if (runningCount === 0) {
        vscode.window.showWarningMessage('No Nuxt server is running');
        return;
    }

    vscode.env.openExternal(vscode.Uri.parse(serverUrl));
}

async function showNuxtVersion() {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) {
        showNotification('error', 'No workspace folder open');
        return;
    }

    const rootPath = workspaceFolders[0].uri.fsPath;

    try {
        // Get declared version from package.json
        const packageJsonPath = path.join(rootPath, 'package.json');
        let declaredVersion = 'Not found';

        if (fs.existsSync(packageJsonPath)) {
            const packageJson = safeJSONParse<any>(
                fs.readFileSync(packageJsonPath, 'utf8'),
                {}
            );
            const nuxtVersion = packageJson.dependencies?.nuxt ||
                              packageJson.devDependencies?.nuxt;
            if (nuxtVersion) {
                declaredVersion = nuxtVersion;
            }
        }

        // Get actual installed version from node_modules
        let installedVersion = 'Not installed';
        const nuxtPackageJsonPath = path.join(rootPath, 'node_modules', 'nuxt', 'package.json');
        if (fs.existsSync(nuxtPackageJsonPath)) {
            const nuxtPackageJson = safeJSONParse<any>(
                fs.readFileSync(nuxtPackageJsonPath, 'utf8'),
                {}
            );
            installedVersion = nuxtPackageJson.version || 'Unknown';
        }

        // Check for running processes and get their versions
        const processes = await getRunningNuxtProcesses();
        const runningCount = processes.length;

        const lines: string[] = [
            'Nuxt Version Information:',
            '',
            `Declared (package.json): ${declaredVersion}`,
            `Installed (node_modules): ${installedVersion}`,
            '',
            `Running instances: ${runningCount}`
        ];

        if (runningCount > 0) {
            lines.push('');
            lines.push('Active Servers:');
            processes.forEach((proc, idx) => {
                lines.push(`  ${idx + 1}. Port ${proc.port || 'Unknown'} - PID ${proc.pid}`);
                lines.push(`     ${proc.workingDir}`);

                // Try to get version from the specific process's working directory
                try {
                    const homeDir = process.env.HOME || '';
                    const procNuxtPkg = path.join(
                        proc.workingDir.replace('~', homeDir),
                        'node_modules',
                        'nuxt',
                        'package.json'
                    );
                    if (fs.existsSync(procNuxtPkg)) {
                        const procPkgJson = safeJSONParse<any>(
                            fs.readFileSync(procNuxtPkg, 'utf8'),
                            {}
                        );
                        lines.push(`     Version: ${procPkgJson.version || 'Unknown'}`);
                    }
                } catch (error) {
                    // Couldn't read version for this process
                    console.error(`Error reading version for PID ${proc.pid}:`, error);
                }
            });
        }

        const message = lines.join('\n');

        // Show in output channel for better formatting
        const outputChannel = vscode.window.createOutputChannel('Nuxt Version');
        outputChannel.clear();
        outputChannel.appendLine(message);
        outputChannel.show();

        showNotification('info', `Nuxt ${installedVersion} installed. ${runningCount} instance(s) running.`);
    } catch (error: any) {
        showNotification('error', `Failed to get version: ${error.message}`);
    }
}