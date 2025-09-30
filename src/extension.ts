import * as vscode from 'vscode';
import { exec, spawn, ChildProcess } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';
import * as fs from 'fs';

const execAsync = promisify(exec);

interface NuxtProcess {
    pid: string;
    command: string;
    workingDir: string;
    port?: string;
}

let statusBarItem: vscode.StatusBarItem;
let devServerProcess: ChildProcess | null = null;
let devServerWorkingDir: string | null = null;
let serverPort = 3000;
let serverUrl = `http://localhost:${serverPort}`;
let updateInterval: NodeJS.Timeout | null = null;

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

    // Start monitoring
    updateStatusBar();
    updateInterval = setInterval(updateStatusBar, 3000);
}

export function deactivate() {
    if (updateInterval) {
        clearInterval(updateInterval);
    }
    if (devServerProcess && devServerProcess.pid) {
        try {
            // Kill all child processes
            execAsync(`pkill -9 -P ${devServerProcess.pid}`).catch(() => {});
            // Kill the main process
            devServerProcess.kill('SIGKILL');
        } catch (error) {
            // Best effort cleanup
        }
    }
    devServerProcess = null;
    devServerWorkingDir = null;
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

            processMap.set(pid, {
                pid,
                command: fullCommand.length > 80 ? fullCommand.substring(0, 77) + '...' : fullCommand,
                workingDir: workingDir.replace(process.env.HOME || '', '~'),
                port
            });
        }

        return Array.from(processMap.values());
    } catch (error) {
        // If ps fails, return empty
        return [];
    }
}

async function startDevServer() {
    if (devServerProcess && !devServerProcess.killed) {
        vscode.window.showWarningMessage('Dev server is already running');
        return;
    }

    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) {
        vscode.window.showErrorMessage('No workspace folder open');
        return;
    }

    const rootPath = workspaceFolders[0].uri.fsPath;

    // Check if it's a Nuxt project
    const nuxtConfigExists = fs.existsSync(path.join(rootPath, 'nuxt.config.ts')) ||
                            fs.existsSync(path.join(rootPath, 'nuxt.config.js')) ||
                            fs.existsSync(path.join(rootPath, 'nuxt.config.mjs')) ||
                            fs.existsSync(path.join(rootPath, 'nuxt.config.mts'));

    if (!nuxtConfigExists) {
        vscode.window.showErrorMessage('No nuxt.config file found in workspace');
        return;
    }

    vscode.window.showInformationMessage('Starting Nuxt dev server...');

    // Store the working directory for later cleanup
    devServerWorkingDir = rootPath;

    // Determine package manager
    const packageManager = fs.existsSync(path.join(rootPath, 'yarn.lock')) ? 'yarn' :
                          fs.existsSync(path.join(rootPath, 'pnpm-lock.yaml')) ? 'pnpm' :
                          fs.existsSync(path.join(rootPath, 'bun.lockb')) ? 'bun' : 'npm';

    const args = packageManager === 'npm' ? ['run', 'dev'] : ['dev'];

    devServerProcess = spawn(packageManager, args, {
        cwd: rootPath,
        shell: true,
        detached: false,
        env: { ...process.env }
    });

    // Create output channel for logs
    const outputChannel = vscode.window.createOutputChannel('Nuxt Dev Server');
    outputChannel.show(true);

    devServerProcess.stdout?.on('data', (data) => {
        const output = data.toString();
        outputChannel.append(output);

        // Extract port from output
        const portMatch = output.match(/http:\/\/localhost:(\d+)/);
        if (portMatch) {
            serverPort = parseInt(portMatch[1]);
            serverUrl = `http://localhost:${serverPort}`;
        }
    });

    devServerProcess.stderr?.on('data', (data) => {
        outputChannel.append(data.toString());
    });

    devServerProcess.on('close', (code) => {
        outputChannel.appendLine(`\nServer process closed with code ${code}`);
        devServerProcess = null;
        devServerWorkingDir = null;
        updateStatusBar();
    });

    devServerProcess.on('exit', (code, signal) => {
        outputChannel.appendLine(`\nServer process exited with code ${code}, signal ${signal}`);
    });

    devServerProcess.on('error', (error) => {
        vscode.window.showErrorMessage(`Failed to start server: ${error.message}`);
        outputChannel.appendLine(`Error: ${error.message}`);
        devServerProcess = null;
        devServerWorkingDir = null;
        updateStatusBar();
    });

    updateStatusBar();
}

async function stopDevServer() {
    if (!devServerProcess || devServerProcess.killed) {
        vscode.window.showWarningMessage('No managed dev server is running');
        return;
    }

    const pid = devServerProcess.pid;
    const workingDir = devServerWorkingDir;

    console.log(`Stopping dev server with PID ${pid}, working dir: ${workingDir}`);

    try {
        // Approach 1: Find and kill all nuxt processes in the working directory
        if (workingDir) {
            try {
                console.log(`Finding nuxt processes in ${workingDir}`);
                const processes = await getRunningNuxtProcesses();
                const matchingProcesses = processes.filter(proc => {
                    const procDir = proc.workingDir.replace('~', process.env.HOME || '');
                    return procDir === workingDir;
                });

                console.log(`Found ${matchingProcesses.length} matching processes`);
                for (const proc of matchingProcesses) {
                    console.log(`Killing process ${proc.pid} on port ${proc.port}`);
                    try {
                        await execAsync(`kill -9 ${proc.pid}`);
                    } catch (error) {
                        console.log(`Failed to kill ${proc.pid}:`, error);
                    }
                }
            } catch (error) {
                console.log(`Failed to find/kill nuxt processes:`, error);
            }
        }

        // Approach 2: Kill the shell process tree
        if (pid) {
            try {
                // Kill all descendants recursively
                console.log(`Killing process tree for PID ${pid}`);
                await execAsync(`pkill -9 -P ${pid}`);
            } catch (error) {
                console.log(`No child processes found for PID ${pid}`);
            }

            // Kill the main shell process
            try {
                console.log(`Sending SIGKILL to PID ${pid}`);
                process.kill(pid, 'SIGKILL');
            } catch (error) {
                console.log(`Failed to kill ${pid}:`, error);
            }
        }

        // Wait a moment for processes to die
        await new Promise(resolve => setTimeout(resolve, 500));

        devServerProcess = null;
        devServerWorkingDir = null;
        vscode.window.showInformationMessage('Dev server stopped');
        updateStatusBar();
    } catch (error: any) {
        console.error(`Error stopping dev server:`, error);
        vscode.window.showErrorMessage(`Failed to stop server: ${error.message}`);
        devServerProcess = null;
        devServerWorkingDir = null;
        updateStatusBar();
    }
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
                await execAsync(`kill -9 ${item.process.pid}`);
                if (devServerProcess && devServerProcess.pid?.toString() === item.process.pid) {
                    devServerProcess = null;
                }
                killedCount++;
            } catch (error: any) {
                vscode.window.showErrorMessage(`Failed to kill PID ${item.process.pid}: ${error.message}`);
            }
        }

        vscode.window.showInformationMessage(`Killed ${killedCount} of ${selected.length} instance(s)`);
        updateStatusBar();
    } catch (error: any) {
        vscode.window.showErrorMessage(`Failed to list instances: ${error.message}`);
    }
}

async function killAllNuxtInstances() {
    try {
        const count = await getRunningNuxtProcessCount();

        if (count === 0) {
            vscode.window.showInformationMessage('No Nuxt instances found');
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

        // Kill all node processes running nuxt
        await execAsync('pkill -f "node.*nuxt.*(dev|preview)"');

        if (devServerProcess) {
            devServerProcess = null;
        }

        vscode.window.showInformationMessage(`Killed ${count} Nuxt instance(s)`);
        updateStatusBar();
    } catch (error: any) {
        if (error.code === 1) {
            // pkill returns 1 if no processes found, which is fine
            vscode.window.showInformationMessage('No Nuxt instances found');
        } else {
            vscode.window.showErrorMessage(`Failed to kill instances: ${error.message}`);
        }
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
        vscode.window.showErrorMessage('No workspace folder open');
        return;
    }

    const rootPath = workspaceFolders[0].uri.fsPath;

    try {
        // Get declared version from package.json
        const packageJsonPath = path.join(rootPath, 'package.json');
        let declaredVersion = 'Not found';

        if (fs.existsSync(packageJsonPath)) {
            const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
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
            try {
                const nuxtPackageJson = JSON.parse(fs.readFileSync(nuxtPackageJsonPath, 'utf8'));
                installedVersion = nuxtPackageJson.version || 'Unknown';
            } catch (error) {
                installedVersion = 'Unable to read';
            }
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
                    const procNuxtPkg = path.join(proc.workingDir.replace('~', process.env.HOME || ''), 'node_modules', 'nuxt', 'package.json');
                    if (fs.existsSync(procNuxtPkg)) {
                        const procPkgJson = JSON.parse(fs.readFileSync(procNuxtPkg, 'utf8'));
                        lines.push(`     Version: ${procPkgJson.version || 'Unknown'}`);
                    }
                } catch (error) {
                    // Couldn't read version for this process
                }
            });
        }

        const message = lines.join('\n');

        // Show in output channel for better formatting
        const outputChannel = vscode.window.createOutputChannel('Nuxt Version');
        outputChannel.clear();
        outputChannel.appendLine(message);
        outputChannel.show();

        vscode.window.showInformationMessage(`Nuxt ${installedVersion} installed. ${runningCount} instance(s) running.`);
    } catch (error: any) {
        vscode.window.showErrorMessage(`Failed to get version: ${error.message}`);
    }
}