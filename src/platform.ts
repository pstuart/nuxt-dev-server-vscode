import { execFile } from 'child_process';
import { promisify } from 'util';
import { sanitizePid, debugLog, getErrorMessage } from './utils';
import {
    ancestorPids,
    isSafeBinaryName,
    matchesNuxtDevPreview,
    parseUnixProcessTable,
    parseWindowsProcessJsonLines,
    ProcessTableEntry,
    selectPreferredNuxtPort,
} from './processLogic';

const execFileAsync = promisify(execFile);

/**
 * Platform-specific process management operations.
 *
 * Abstracts macOS/Linux and Windows process discovery/kill behind one interface.
 * Prefer execFile + argv (never shell string interpolation) to avoid cmd/PowerShell injection.
 */

interface ProcessEntry {
    pid: string;
    command: string;
    ancestorPids: string[];
}

/** Run PowerShell with a single -Command argv (no cmd.exe reparse of the script). */
async function runPowerShell(script: string): Promise<string> {
    const { stdout } = await execFileAsync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', script],
        { windowsHide: true, maxBuffer: 10 * 1024 * 1024, encoding: 'utf8' }
    );
    return stdout;
}

/** Full pid/ppid/command snapshot used for ancestry and recursive tree kill. */
export async function listProcessTable(): Promise<ProcessTableEntry[]> {
    if (process.platform === 'win32') {
        // Include every process so JS can reconstruct ancestry before filtering.
        const script = [
            "$ErrorActionPreference = 'SilentlyContinue'",
            "Get-CimInstance Win32_Process |",
            "  Where-Object { $_.CommandLine } |",
            "  ForEach-Object { (@{ pid = $_.ProcessId; parentPid = $_.ParentProcessId; command = $_.CommandLine } | ConvertTo-Json -Compress) }",
        ].join(' ');

        try {
            const stdout = await runPowerShell(script);
            if (!stdout.trim()) {
                debugLog('No processes found (Windows empty output)');
                return [];
            }
            return parseWindowsProcessJsonLines(stdout);
        } catch (error) {
            debugLog('Windows process list failed:', getErrorMessage(error));
            return [];
        }
    }

    try {
        const { stdout } = await execFileAsync('ps', ['-eo', 'pid=,ppid=,command='], {
            maxBuffer: 10 * 1024 * 1024,
            encoding: 'utf8',
        });
        return parseUnixProcessTable(stdout);
    } catch (error) {
        debugLog('Unix process list failed:', getErrorMessage(error));
        throw error;
    }
}

/**
 * List node processes whose command line matches the Nuxt dev/preview pattern.
 */
export async function listNuxtProcesses(): Promise<ProcessEntry[]> {
    const table = await listProcessTable();
    const entries = table
        .filter(entry => matchesNuxtDevPreview(entry.command))
        .map(entry => ({
            pid: entry.pid,
            command: entry.command,
            ancestorPids: ancestorPids(entry.pid, table),
        }));
    if (entries.length === 0) {
        debugLog('No Nuxt processes found');
    }
    return entries;
}

/**
 * Check if a process with the given PID is listening on any TCP port.
 */
export async function getProcessPort(
    pid: number,
    expectedPort?: number
): Promise<string | undefined> {
    const safePid = sanitizePid(String(pid));

    if (process.platform === 'win32') {
        const script =
            `Get-NetTCPConnection -OwningProcess ${safePid} -State Listen -ErrorAction SilentlyContinue | ` +
            `Select-Object -ExpandProperty LocalPort`;
        try {
            const stdout = await runPowerShell(script);
            const ports = stdout.trim().split(/\r?\n/).map(port => port.trim()).filter(Boolean);
            return selectPreferredNuxtPort(ports, expectedPort);
        } catch (error) {
            debugLog(`Could not get port for pid ${pid} on Windows:`, getErrorMessage(error));
            return undefined;
        }
    }

    try {
        const { stdout } = await execFileAsync(
            'lsof',
            ['-Pan', '-p', String(safePid), '-iTCP', '-sTCP:LISTEN'],
            { encoding: 'utf8', maxBuffer: 1024 * 1024 }
        );
        const ports = Array.from(stdout.matchAll(/:(\d+)\s+\(LISTEN\)/g), match => match[1]);
        return selectPreferredNuxtPort(ports, expectedPort);
    } catch {
        // Not listening on any port
    }
    return undefined;
}

/** Return the exact command for identity checks before force-killing a PID. */
export async function getProcessCommand(pid: number): Promise<string | undefined> {
    const safePid = sanitizePid(String(pid));
    if (process.platform === 'win32') {
        const script =
            `$p = Get-CimInstance Win32_Process -Filter "ProcessId = ${safePid}" -ErrorAction SilentlyContinue; ` +
            `if ($p) { $p.CommandLine }`;
        const stdout = await runPowerShell(script);
        return stdout.trim() || undefined;
    }
    try {
        const { stdout } = await execFileAsync('ps', ['-p', String(safePid), '-o', 'command='], {
            encoding: 'utf8',
        });
        return stdout.trim() || undefined;
    } catch {
        return undefined;
    }
}

/**
 * Get the working directory of a process by PID.
 */
export async function getProcessWorkingDir(pid: number): Promise<string> {
    const safePid = sanitizePid(String(pid));

    if (process.platform === 'win32') {
        // WorkingDirectory is not reliably on Get-Process; try ExecutablePath dirname as fallback.
        const script =
            `$p = Get-CimInstance Win32_Process -Filter "ProcessId = ${safePid}" -ErrorAction SilentlyContinue; ` +
            `if ($p -and $p.ExecutablePath) { Split-Path -Parent $p.ExecutablePath }`;
        try {
            const stdout = await runPowerShell(script);
            const cwd = stdout.trim();
            if (cwd) {
                return cwd;
            }
        } catch (error) {
            debugLog(`Could not get working directory for pid ${pid} on Windows:`, getErrorMessage(error));
        }
        return 'Unknown';
    }

    try {
        const { stdout } = await execFileAsync('lsof', ['-a', '-p', String(safePid), '-d', 'cwd', '-Fn'], {
            encoding: 'utf8',
            maxBuffer: 1024 * 1024,
        });
        // -Fn emits "n/path" lines for the cwd name
        for (const line of stdout.split('\n')) {
            if (line.startsWith('n') && line.length > 1) {
                return line.slice(1);
            }
        }
        return 'Unknown';
    } catch {
        return 'Unknown';
    }
}

/**
 * Check if a binary is available on PATH. Name must match /^[a-zA-Z0-9_-]+$/.
 */
export async function isBinaryAvailable(binary: string): Promise<boolean> {
    if (!isSafeBinaryName(binary)) {
        debugLog(`Rejected invalid binary name: ${binary}`);
        return false;
    }

    if (process.platform === 'win32') {
        try {
            const { stdout } = await execFileAsync('where.exe', [binary], {
                windowsHide: true,
                encoding: 'utf8',
            });
            return stdout.trim() !== '';
        } catch {
            return false;
        }
    }

    try {
        const { stdout } = await execFileAsync('which', [binary], { encoding: 'utf8' });
        return stdout.trim() !== '';
    } catch {
        return false;
    }
}
