import { execFile } from 'child_process';
import { promisify } from 'util';
import { PROCESS_PATTERNS } from './constants';
import { sanitizePid, debugLog, getErrorMessage } from './utils';

const execFileAsync = promisify(execFile);

/**
 * Platform-specific process management operations.
 *
 * Abstracts macOS/Linux and Windows process discovery/kill behind one interface.
 * Prefer execFile + argv (never shell string interpolation) to avoid cmd/PowerShell injection.
 */

export interface ProcessEntry {
    pid: string;
    command: string;
}

const BINARY_NAME_RE = /^[a-zA-Z0-9_-]+$/;

/** Run PowerShell with a single -Command argv (no cmd.exe reparse of the script). */
async function runPowerShell(script: string): Promise<string> {
    const { stdout } = await execFileAsync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', script],
        { windowsHide: true, maxBuffer: 10 * 1024 * 1024, encoding: 'utf8' }
    );
    return stdout;
}

/** JS filter mirroring PROCESS_PATTERNS.NUXT_DEV_PREVIEW (case-insensitive). */
function matchesNuxtDevPreview(command: string): boolean {
    return /node.*nuxt.*(dev|preview)/i.test(command);
}

/**
 * List node processes whose command line matches the Nuxt dev/preview pattern.
 */
export async function listNuxtProcesses(): Promise<ProcessEntry[]> {
    if (process.platform === 'win32') {
        // Win32_Process exposes CommandLine; Get-Process does not.
        // Emit one JSON object per line for robust parsing.
        const script = [
            "$ErrorActionPreference = 'SilentlyContinue'",
            "Get-CimInstance Win32_Process |",
            "  Where-Object { $_.Name -match 'node' -and $_.CommandLine -and ($_.CommandLine -match 'nuxt') -and ($_.CommandLine -match 'dev|preview') } |",
            "  ForEach-Object { (@{ pid = $_.ProcessId; command = $_.CommandLine } | ConvertTo-Json -Compress) }",
        ].join(' ');

        try {
            const stdout = await runPowerShell(script);
            if (!stdout.trim()) {
                debugLog('No Nuxt processes found (Windows empty output)');
                return [];
            }
            const entries: ProcessEntry[] = [];
            for (const line of stdout.split(/\r?\n/)) {
                const trimmed = line.trim();
                if (!trimmed?.startsWith('{')) {
                    continue;
                }
                try {
                    const obj = JSON.parse(trimmed) as { pid?: number | string; command?: string };
                    if (obj.pid !== undefined && obj.pid !== null && obj.command) {
                        entries.push({ pid: String(obj.pid), command: String(obj.command) });
                    }
                } catch {
                    // skip malformed line
                }
            }
            return entries;
        } catch (error) {
            debugLog('Windows process list failed:', getErrorMessage(error));
            return [];
        }
    }

    // macOS / Linux: parse `ps` in JS (no shell pipeline)
    try {
        const { stdout } = await execFileAsync('ps', ['-eo', 'pid,command'], {
            maxBuffer: 10 * 1024 * 1024,
            encoding: 'utf8',
        });
        const entries: ProcessEntry[] = [];
        for (const line of stdout.split('\n')) {
            const trimmed = line.trim();
            if (!trimmed) {
                continue;
            }
            const match = trimmed.match(/^(\d+)\s+(.+)$/);
            if (!match) {
                continue;
            }
            const pid = match[1];
            const command = match[2];
            if (matchesNuxtDevPreview(command) && !/\bgrep\b/.test(command)) {
                entries.push({ pid, command });
            }
        }
        if (entries.length === 0) {
            debugLog('No Nuxt processes found (ps filter empty)');
        }
        return entries;
    } catch (error) {
        debugLog('Unix process list failed:', getErrorMessage(error));
        throw error;
    }
}

/**
 * Check if a process with the given PID is listening on any TCP port.
 */
export async function getProcessPort(pid: number): Promise<string | undefined> {
    const safePid = sanitizePid(String(pid));

    if (process.platform === 'win32') {
        const script =
            `Get-NetTCPConnection -OwningProcess ${safePid} -State Listen -ErrorAction SilentlyContinue | ` +
            `Select-Object -ExpandProperty LocalPort -First 1`;
        try {
            const stdout = await runPowerShell(script);
            const port = stdout.trim().split(/\r?\n/).map(p => p.trim()).find(Boolean);
            return port ?? undefined;
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
 * Kill all child processes of a parent PID.
 */
export async function killChildProcesses(parentPid: number): Promise<void> {
    const safePid = sanitizePid(String(parentPid));

    if (process.platform === 'win32') {
        const script =
            `Get-CimInstance Win32_Process -Filter "ParentProcessId = ${safePid}" -ErrorAction SilentlyContinue | ` +
            `ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`;
        try {
            await runPowerShell(script);
        } catch (error) {
            debugLog(`No child processes found for ${parentPid} on Windows:`, getErrorMessage(error));
        }
        return;
    }

    try {
        await execFileAsync('pkill', ['-9', '-P', String(safePid)], { encoding: 'utf8' });
    } catch (error) {
        debugLog(`No child processes found for ${parentPid}:`, getErrorMessage(error));
    }
}

/**
 * Check if a binary is available on PATH. Name must match /^[a-zA-Z0-9_-]+$/.
 */
export async function isBinaryAvailable(binary: string): Promise<boolean> {
    if (!BINARY_NAME_RE.test(binary)) {
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
