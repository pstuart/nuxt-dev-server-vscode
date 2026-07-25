import { exec } from 'child_process';
import { promisify } from 'util';
import { PROCESS_PATTERNS } from './constants';
import { sanitizePid, debugLog, getErrorMessage } from './utils';

const execAsync = promisify(exec);

/**
 * Platform-specific process management operations.
 *
 * This module abstracts the macOS/Linux-only shell commands (`ps`, `lsof`,
 * `pkill`) behind a single interface so the extension works on Windows as
 * well. On Windows, PowerShell equivalents are used.
 */

/**
 * Raw process entry returned by the platform process-lister.
 * The PID is always a string so callers can validate it with sanitizePid.
 */
export interface ProcessEntry {
    pid: string;
    command: string;
}

/**
 * Escape a string so it can be safely used inside a PowerShell single-quoted
 * string literal.  Doubles any single quotes (the PowerShell escape).
 */
function psEscape(value: string): string {
    return value.replace(/'/g, "''");
}

/**
 * Build the command (and shell option) to list node processes whose command
 * line matches the Nuxt dev/preview pattern.
 *
 * Returns an object with:
 * - `command`: the shell command to execute
 * - `shell`: whether to run through a shell (always true for these commands)
 *
 * On macOS/Linux: uses `ps -eo pid,command | grep -iE ...`
 * On Windows: uses PowerShell to enumerate processes.
 */
function buildProcessListCommand(): { command: string; windowsHide: boolean } {
    if (process.platform === 'win32') {
        // PowerShell: list all processes, filter for node + nuxt + dev/preview.
        // We use a regex that mirrors PROCESS_PATTERNS.NUXT_DEV_PREVIEW.
        const regex = psEscape(PROCESS_PATTERNS.NUXT_DEV_PREVIEW);
        return {
            command: `powershell -NoProfile -Command "Get-Process -Name node | Where-Object { $_.Path -match 'node' -and $_.CommandLine -match '${regex}' } | ForEach-Object { $_.Id; $_.CommandLine }"`,
            windowsHide: true,
        };
    }
    // macOS / Linux
    return {
        command: `ps -eo pid,command | grep -iE "${PROCESS_PATTERNS.NUXT_DEV_PREVIEW}" | grep -v grep`,
        windowsHide: false,
    };
}

/**
 * List all node processes whose command line matches the Nuxt dev/preview
 * pattern.  Returns an array of { pid, command } entries.
 *
 * On macOS/Linux, `ps` + `grep` is used.  On Windows, PowerShell is used.
 * grep returns exit code 1 when no matches are found — that is treated as
 * "no processes" rather than an error.
 */
export async function listNuxtProcesses(): Promise<ProcessEntry[]> {
    const { command } = buildProcessListCommand();

    let output: string;
    try {
        const result = await execAsync(command);
        output = result.stdout;
    } catch (error: unknown) {
        const execError = error as { code?: number };
        // grep returns exit code 1 when no matches found - this is normal
        if (execError.code === 1) {
            debugLog('No Nuxt processes found (process list returned no matches)');
            return [];
        }
        throw error;
    }

    if (!output.trim()) {
        debugLog('No Nuxt processes found (empty output)');
        return [];
    }

    const entries: ProcessEntry[] = [];
    const lines = output.trim().split('\n');

    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) {
            continue;
        }

        if (process.platform === 'win32') {
            // PowerShell output: alternating pid and command lines
            // Each process is represented as two lines: Id, then CommandLine
            const pid = trimmed;
            // The next line should be the command
            const idx = lines.indexOf(line);
            if (idx >= 0 && idx + 1 < lines.length) {
                const cmdLine = lines[idx + 1].trim();
                if (cmdLine) {
                    entries.push({ pid, command: cmdLine });
                }
            }
        } else {
            // Unix: "pid command..."
            const match = trimmed.match(/^(\d+)\s+(.+)$/);
            if (match) {
                entries.push({ pid: match[1], command: match[2] });
            }
        }
    }

    return entries;
}

/**
 * Check if a process with the given PID is listening on any TCP port.
 * Returns the port number as a string, or undefined if not listening.
 *
 * On macOS/Linux: uses `lsof -Pan -p <pid> -iTCP -sTCP:LISTEN`
 * On Windows: uses PowerShell `Get-NetTCPConnection`
 */
export async function getProcessPort(pid: number): Promise<string | undefined> {
    if (process.platform === 'win32') {
        const safePid = sanitizePid(String(pid));
        try {
            const psCommand = `powershell -NoProfile -Command "Get-NetTCPConnection -OwningProcess ${safePid} -State Listen | Select-Object -ExpandProperty LocalPort | ForEach-Object { $_ }"`;
            const { stdout } = await execAsync(psCommand);
            const ports = stdout.trim().split('\n').filter(p => p.trim());
            if (ports.length > 0) {
                return ports[0].trim();
            }
        } catch (error) {
            debugLog(`Could not get port for pid ${pid} on Windows:`, getErrorMessage(error));
        }
        return undefined;
    }

    // macOS / Linux
    const safePid = sanitizePid(String(pid));
    try {
        const { stdout } = await execAsync(`lsof -Pan -p ${safePid} -iTCP -sTCP:LISTEN 2>/dev/null`);
        const portMatch = stdout.match(PROCESS_PATTERNS.LSOF_PORT_REGEX);
        if (portMatch) {
            return portMatch[1];
        }
    } catch {
        // Not listening on any port
    }
    return undefined;
}

/**
 * Get the working directory of a process by PID.
 * Returns the directory path, or 'Unknown' if it cannot be determined.
 *
 * On macOS/Linux: uses `lsof -p <pid> | grep cwd | awk '{print $NF}'`
 * On Windows: uses PowerShell `Get-Process -Id <pid> | Select-Object -ExpandProperty WorkingDirectory`
 * (Note: WorkingDirectory may not be available for all processes on Windows
 * without elevated privileges; in that case 'Unknown' is returned.)
 */
export async function getProcessWorkingDir(pid: number): Promise<string> {
    if (process.platform === 'win32') {
        const safePid = sanitizePid(String(pid));
        try {
            const psCommand = `powershell -NoProfile -Command "Get-Process -Id ${safePid} | Select-Object -ExpandProperty WorkingDirectory"`;
            const { stdout } = await execAsync(psCommand);
            const cwd = stdout.trim();
            if (cwd && cwd !== '') {
                return cwd;
            }
        } catch (error) {
            debugLog(`Could not get working directory for pid ${pid} on Windows:`, getErrorMessage(error));
        }
        return 'Unknown';
    }

    // macOS / Linux
    const safePid = sanitizePid(String(pid));
    try {
        const { stdout } = await execAsync(`lsof -p ${safePid} 2>/dev/null | grep cwd | awk '{print $NF}'`);
        const cwd = stdout.trim();
        return cwd || 'Unknown';
    } catch {
        return 'Unknown';
    }
}

/**
 * Kill all child processes of a parent PID.
 *
 * On macOS/Linux: uses `pkill -9 -P <pid>`
 * On Windows: uses PowerShell to find and kill child processes via
 * Get-WmiObject / CIM to find processes with the parent PID.
 */
export async function killChildProcesses(parentPid: number): Promise<void> {
    if (process.platform === 'win32') {
        const safePid = sanitizePid(String(parentPid));
        try {
            const psCommand = `powershell -NoProfile -Command "Get-WmiObject -Query 'SELECT * FROM Win32_Process WHERE ParentProcessId = ${safePid}' | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"`;
            await execAsync(psCommand);
        } catch (error) {
            // No child processes found, that's fine
            debugLog(`No child processes found for ${parentPid} on Windows:`, getErrorMessage(error));
        }
        return;
    }

    // macOS / Linux
    const safePid = sanitizePid(String(parentPid));
    try {
        await execAsync(`pkill -9 -P ${safePid}`);
    } catch (error) {
        // No child processes found, that's fine
        debugLog(`No child processes found for ${parentPid}:`, getErrorMessage(error));
    }
}

/**
 * Check if a binary (e.g. a package manager) is available on the system PATH.
 *
 * On macOS/Linux: uses `which <binary>`
 * On Windows: uses `where <binary>`
 */
export async function isBinaryAvailable(binary: string): Promise<boolean> {
    if (process.platform === 'win32') {
        try {
            const { stdout } = await execAsync(`where ${binary} 2>nul`);
            return stdout.trim() !== '';
        } catch {
            return false;
        }
    }

    // macOS / Linux
    try {
        const { stdout } = await execAsync(`which '${binary}' 2>/dev/null || echo ''`);
        return stdout.trim() !== '';
    } catch {
        return false;
    }
}
