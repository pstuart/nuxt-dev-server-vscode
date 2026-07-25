import { NuxtProcess } from './types';
import { DEFAULT_CONFIG } from './constants';
import { formatPathForDisplay, sanitizePid, debugLog, getErrorMessage, expandPath, sleep, showWarning, getConfig } from './utils';
import {
    listNuxtProcesses,
    getProcessPort,
    getProcessWorkingDir,
    killChildProcesses
} from './platform';

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
        const entries = await listNuxtProcesses();

        if (entries.length === 0) {
            debugLog('No Nuxt processes found');
            consecutiveFailures = 0; // Reset failure counter - this is expected
            return [];
        }

        const processMap = new Map<string, NuxtProcess>();

        for (const entry of entries) {
            const pid = entry.pid;
            const fullCommand = entry.command;

            // Skip if already processed
            if (processMap.has(pid)) {
                continue;
            }

            // Verify this process is actually listening on a port
            let port: string | undefined;
            try {
                const sanitizedPid = sanitizePid(pid);
                port = await getProcessPort(sanitizedPid);
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
                workingDir = await getProcessWorkingDir(sanitizedPid);
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
                `This may be due to missing system tools or permissions. ` +
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

        // Wait for graceful shutdown — respects the user's
        // `nuxt-dev-server.gracefulShutdownTimeout` setting (default 5000ms,
        // bounded 1000-30000 by package.json contributes.configuration).
        // Until this scan, the config value was read by getConfig() but no
        // caller actually used it; the SIGTERM-to-SIGKILL gap was hardcoded
        // to 500ms regardless of what the user set.
        const gracefulTimeoutMs = getConfig().gracefulShutdownTimeout;
        await sleep(gracefulTimeoutMs);

        // Check if still alive, force kill if needed
        try {
            process.kill(numPid, 0); // Check if process exists
            debugLog(`Process ${numPid} still alive after ${gracefulTimeoutMs}ms, sending SIGKILL`);
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

    // Kill all descendants recursively using platform abstraction
    await killChildProcesses(numPid);

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
            const safePid = sanitizePid(String(pid));
            const port = await getProcessPort(safePid);
            if (port) {
                const parsedPort = parseInt(port, 10);
                // Port from lsof/netstat should be a valid number; bound to
                // valid TCP port range (1-65535) before treating as listener.
                if (parsedPort < 1 || parsedPort > 65535) {
                    debugLog(`Ignoring out-of-range port for pid ${pid}: ${parsedPort}`);
                } else {
                    debugLog(`Process ${pid} is listening on port ${parsedPort}`);
                    return parsedPort;
                }
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
