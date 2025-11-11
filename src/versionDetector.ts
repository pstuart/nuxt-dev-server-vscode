import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs/promises';
import { NuxtVersionInfo } from './types';
import { OUTPUT_CHANNELS } from './constants';
import { getRunningNuxtProcesses } from './processManager';
import { expandPath, debugLog, getErrorMessage, getOrCreateOutputChannel } from './utils';

/**
 * Safely parse JSON file content
 */
async function readJSONFile(filePath: string): Promise<any> {
    try {
        const content = await fs.readFile(filePath, 'utf8');
        return JSON.parse(content);
    } catch (error) {
        debugLog(`Error reading/parsing JSON file ${filePath}:`, getErrorMessage(error));
        return null;
    }
}

/**
 * Check if a file exists (async)
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
 * Get comprehensive Nuxt version information
 */
export async function getNuxtVersionInfo(rootPath: string): Promise<NuxtVersionInfo> {
    const versionInfo: NuxtVersionInfo = {
        declared: 'Not found',
        installed: 'Not installed',
        running: []
    };

    // Get declared version from package.json
    try {
        const packageJsonPath = path.join(rootPath, 'package.json');
        if (await fileExists(packageJsonPath)) {
            const packageJson = await readJSONFile(packageJsonPath);
            if (packageJson) {
                const nuxtVersion = packageJson.dependencies?.nuxt || packageJson.devDependencies?.nuxt;
                if (nuxtVersion) {
                    versionInfo.declared = nuxtVersion;
                }
            }
        }
    } catch (error) {
        debugLog('Error reading package.json:', getErrorMessage(error));
    }

    // Get actual installed version from node_modules
    try {
        const nuxtPackageJsonPath = path.join(rootPath, 'node_modules', 'nuxt', 'package.json');
        if (await fileExists(nuxtPackageJsonPath)) {
            const nuxtPackageJson = await readJSONFile(nuxtPackageJsonPath);
            if (nuxtPackageJson && nuxtPackageJson.version) {
                versionInfo.installed = nuxtPackageJson.version;
            }
        }
    } catch (error) {
        debugLog('Error reading nuxt package.json:', getErrorMessage(error));
    }

    // Get running server versions
    try {
        const processes = await getRunningNuxtProcesses();
        for (const proc of processes) {
            const workingDir = expandPath(proc.workingDir);
            const procNuxtPkg = path.join(workingDir, 'node_modules', 'nuxt', 'package.json');

            let version = 'Unknown';
            try {
                if (await fileExists(procNuxtPkg)) {
                    const procPkgJson = await readJSONFile(procNuxtPkg);
                    if (procPkgJson && procPkgJson.version) {
                        version = procPkgJson.version;
                    }
                }
            } catch (error) {
                debugLog(`Error reading version for process ${proc.pid}:`, getErrorMessage(error));
            }

            versionInfo.running.push({
                pid: proc.pid,
                port: proc.port,
                workingDir: proc.workingDir,
                version
            });
        }
    } catch (error) {
        debugLog('Error getting running server versions:', getErrorMessage(error));
    }

    return versionInfo;
}

/**
 * Format version information as a readable string
 */
export function formatVersionInfo(versionInfo: NuxtVersionInfo): string {
    const lines: string[] = [
        'Nuxt Version Information:',
        '',
        `Declared (package.json): ${versionInfo.declared}`,
        `Installed (node_modules): ${versionInfo.installed}`,
        '',
        `Running instances: ${versionInfo.running.length}`
    ];

    if (versionInfo.running.length > 0) {
        lines.push('');
        lines.push('Active Servers:');
        versionInfo.running.forEach((server, idx) => {
            lines.push(`  ${idx + 1}. Port ${server.port ?? 'Unknown'} - PID ${server.pid}`);
            lines.push(`     ${server.workingDir}`);
            lines.push(`     Version: ${server.version}`);
        });
    }

    return lines.join('\n');
}

/**
 * Show Nuxt version information to the user
 */
export async function showNuxtVersion(): Promise<void> {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) {
        vscode.window.showErrorMessage('No workspace folder open');
        return;
    }

    const rootPath = workspaceFolders[0].uri.fsPath;

    try {
        const versionInfo = await getNuxtVersionInfo(rootPath);
        const message = formatVersionInfo(versionInfo);

        // Show in output channel for better formatting
        const outputChannel = getOrCreateOutputChannel(OUTPUT_CHANNELS.VERSION);
        outputChannel.clear();
        outputChannel.appendLine(message);
        outputChannel.show();

        const runningCount = versionInfo.running.length;
        vscode.window.showInformationMessage(
            `Nuxt ${versionInfo.installed} installed. ${runningCount} instance(s) running.`
        );
    } catch (error) {
        vscode.window.showErrorMessage(`Failed to get version: ${getErrorMessage(error)}`);
    }
}
