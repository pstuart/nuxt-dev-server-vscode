import { exec } from 'child_process';
import { promisify } from 'util';
import { NuxtProcess } from './types';
import { PROCESS_PATTERNS, DEFAULT_CONFIG } from './constants';
import { formatPathForDisplay, sanitizePid, debugLog, getErrorMessage, expandPath, sleep, showWarning } from './utils';

const execAsync = promisify(exec);

/**
 * Track process detection failures
 */
let consecutiveFailures = 0;
let lastWarningTime = 0;
const WARNING_THROTTLE_MS = 60000; // Only warn once per minute

/**
 * Get all running Nuxt processes with port-based detection
 * Only returns processes that are actually listening on ports (real servers)
 *
 * @returns Array of NuxtProcess objects, or empty array if none found or on error
 */
export async function getRunningNuxtProcesses(): Promise<NuxtProcess[]> {
    try {
        debugLog('Detecting running Nuxt processes...');

        // Find all node processes that contain "nuxt" and "dev" or "preview"
        const psCommand = `ps -eo pid,command | grep -iE "${PROCESS_PATTERNS.NUXT_DEV_PREVIEW}" | grep -v grep`;

        let psOut: string;
        try {
            const result = await execAsync(psCommand);
            psOut = result.stdout;
        } catch (error: any) {
            // grep returns exit code 1 when no matches found - this is normal
            if (error.code === 1) {
                debugLog('No Nuxt processes found (grep returned no matches)');
                consecutiveFailures = 0; // Reset failure counter - this is expected
                return [];
            }
            throw error; // Re-throw if it's a real error
        }

        if (!psOut.trim()) {
            debugLog('No Nuxt processes found (empty output)');
            consecutiveFailures = 0; // Reset failure counter - this is expected
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
                const sanitizedPid = sanitizePid(pid);
                const { stdout: lsofOut } = await execAsync(`lsof -Pan -p ${sanitizedPid} -iTCP -sTCP:LISTEN 2>/dev/null`);
                const portMatch = lsofOut.match(PROCESS_PATTERNS.LSOF_PORT_REGEX);
                if (portMatch) {
                    port = portMatch[1];
                }
            } catch (error) {
                // Not listening on any port, skip this process
                debugLog(`Process ${pid} not listening on any port, skipping`);
                continue;
            }

            // Only include if it has a listening port (actual server)
            if (!port) {
                continue;
            }

            // Get working directory
            let workingDir = 'Unknown';
            try {
                const sanitizedPid = sanitizePid(pid);
                const { stdout: cwdOut } = await execAsync(`lsof -p ${sanitizedPid} 2>/dev/null | grep cwd | awk '{print $NF}'`);
                workingDir = cwdOut.trim() || 'Unknown';
            } catch (error) {
                debugLog(`Could not get working directory for ${pid}`);
            }

            processMap.set(pid, {
                pid,
                command: fullCommand.length > DEFAULT_CONFIG.COMMAND_TRUNCATE_LENGTH
                    ? fullCommand.substring(0, DEFAULT_CONFIG.COMMAND_TRUNCATE_SUFFIX_LENGTH) + '...'
                    : fullCommand,
                workingDir: formatPathForDisplay(workingDir),
                port
            });
        }

        const processes = Array.from(processMap.values());
        debugLog(`Found ${processes.length} running Nuxt instances`);

        // Reset failure counter on success
        consecutiveFailures = 0;

        return processes;
    } catch (error) {
        // Track failures and warn user if detection consistently fails
        consecutiveFailures++;

        const errorMsg = getErrorMessage(error);
        debugLog(`Error detecting processes (failure #${consecutiveFailures}):`, errorMsg);

        // Show warning to user if detection fails repeatedly (but throttle warnings)
        const now = Date.now();
        if (consecutiveFailures >= 3 && (now - lastWarningTime) > WARNING_THROTTLE_MS) {
            lastWarningTime = now;
            const platform = process.platform;
            void showWarning(
                `Process detection failing (${consecutiveFailures} consecutive failures). ` +
                `This may be due to missing system tools (ps, lsof) or permissions. ` +
                `Platform: ${platform}. Check the debug output for details.`
            );
        }

        // Return empty array but user has been warned
        return [];
    }
}

/**
 * Get count of running Nuxt processes
 */
export async function getRunningNuxtProcessCount(): Promise<number> {
    const processes = await getRunningNuxtProcesses();
    return processes.length;
}

/**
 * Kill a specific process by PID
 */
export async function killProcess(pid: string): Promise<void> {
    const numPid = sanitizePid(pid);
    debugLog(`Killing process ${numPid}`);

    try {
        // Try graceful kill first
        process.kill(numPid, 'SIGTERM');

        // Wait a moment
        await sleep(500);

        // Check if still alive, force kill if needed
        try {
            process.kill(numPid, 0); // Check if process exists
            debugLog(`Process ${numPid} still alive, sending SIGKILL`);
            process.kill(numPid, 'SIGKILL');
        } catch (error) {
            // Process already dead, good
            debugLog(`Process ${numPid} terminated successfully`);
        }
    } catch (error) {
        debugLog(`Error killing process ${numPid}:`, getErrorMessage(error));
        throw new Error(`Failed to kill process ${numPid}: ${getErrorMessage(error)}`);
    }
}

/**
 * Kill all child processes of a parent PID
 */
export async function killProcessTree(parentPid: string): Promise<void> {
    const numPid = sanitizePid(parentPid);
    debugLog(`Killing process tree for ${numPid}`);

    try {
        // Kill all descendants recursively using pkill
        const sanitizedPid = sanitizePid(String(numPid));
        await execAsync(`pkill -9 -P ${sanitizedPid}`);
    } catch (error) {
        // No child processes found, that's fine
        debugLog(`No child processes found for ${numPid}`);
    }

    // Kill the parent
    await killProcess(parentPid);
}

/**
 * Kill all Nuxt processes on the system
 */
export async function killAllNuxtProcesses(): Promise<number> {
    debugLog('Killing all Nuxt processes');

    // Get current processes before killing
    const processes = await getRunningNuxtProcesses();
    const count = processes.length;

    if (count === 0) {
        return 0;
    }

    // Kill each process individually for better reliability
    let killedCount = 0;
    for (const proc of processes) {
        try {
            await killProcess(proc.pid);
            killedCount++;
        } catch (error) {
            debugLog(`Failed to kill ${proc.pid}:`, getErrorMessage(error));
        }
    }

    debugLog(`Killed ${killedCount} of ${count} processes`);
    return killedCount;
}

/**
 * Kill all Nuxt processes in a specific working directory
 */
export async function killProcessesByWorkingDir(workingDir: string): Promise<number> {
    debugLog(`Killing processes in ${workingDir}`);

    const processes = await getRunningNuxtProcesses();
    const matchingProcesses = processes.filter(proc => {
        const procDir = expandPath(proc.workingDir);
        return procDir === workingDir;
    });

    debugLog(`Found ${matchingProcesses.length} matching processes`);

    let killedCount = 0;
    for (const proc of matchingProcesses) {
        try {
            await killProcess(proc.pid);
            killedCount++;
        } catch (error) {
            debugLog(`Failed to kill ${proc.pid}:`, getErrorMessage(error));
        }
    }

    return killedCount;
}

/**
 * Wait for a process to start listening on a port
 * Returns the port number when detected, or null if timeout
 */
export async function waitForProcessPort(
    pid: number,
    timeoutMs: number = DEFAULT_CONFIG.SERVER_START_TIMEOUT_MS
): Promise<number | null> {
    debugLog(`Waiting for process ${pid} to listen on a port (timeout: ${timeoutMs}ms)`);

    const startTime = Date.now();
    const checkInterval = 500;

    while (Date.now() - startTime < timeoutMs) {
        try {
            const { stdout: lsofOut } = await execAsync(`lsof -Pan -p ${pid} -iTCP -sTCP:LISTEN 2>/dev/null`);
            const portMatch = lsofOut.match(PROCESS_PATTERNS.LSOF_PORT_REGEX);
            if (portMatch) {
                const port = parseInt(portMatch[1], 10);
                debugLog(`Process ${pid} is listening on port ${port}`);
                return port;
            }
        } catch (error) {
            // Not listening yet
        }

        // Check if process is still alive
        try {
            process.kill(pid, 0);
        } catch (error) {
            debugLog(`Process ${pid} died while waiting for port`);
            return null;
        }

        await sleep(checkInterval);
    }

    debugLog(`Timeout waiting for process ${pid} to listen on port`);
    return null;
}

/**
 * Verify a process is completely terminated
 */
export async function verifyProcessTerminated(pid: string, maxWaitMs: number = 2000): Promise<boolean> {
    const numPid = sanitizePid(pid);
    const startTime = Date.now();

    while (Date.now() - startTime < maxWaitMs) {
        try {
            process.kill(numPid, 0); // Check if process exists
            await sleep(100);
        } catch (error) {
            // Process is dead
            debugLog(`Process ${numPid} confirmed terminated`);
            return true;
        }
    }

    debugLog(`Process ${numPid} still alive after ${maxWaitMs}ms`);
    return false;
}
