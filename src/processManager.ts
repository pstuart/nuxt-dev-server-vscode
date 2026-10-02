import { NuxtProcess } from './types';
import { DEFAULT_CONFIG } from './constants';
import { formatPathForDisplay, debugLog, getErrorMessage, expandPath, sleep, showWarning, getConfig } from './utils';
import {
    listNuxtProcesses,
    listProcessTable,
    getProcessPort,
    getProcessWorkingDir,
    getProcessCommand,
} from './platform';
import {
    collectDescendantPids,
    inferWorkingDirFromCommand,
    isProcessGoneError,
    selectWaitForProcessTreePort,
    shouldRefuseSigkillEscalation,
} from './processLogic';
import { isValidPort, parsePid } from './validation';

/**
 * Track process detection failures
 */
let consecutiveFailures = 0;
let lastWarningTime = 0;
const WARNING_THROTTLE_MS = 60000; // Only warn once per minute
const workingDirCache = new Map<string, { command: string; workingDir: string }>();

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
        const activePids = new Set(entries.map(entry => entry.pid));
        for (const cachedPid of workingDirCache.keys()) {
            if (!activePids.has(cachedPid)) {
                workingDirCache.delete(cachedPid);
            }
        }

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
                port = await getProcessPort(parsePid(pid));
            } catch (error) {
                // Not listening on any port, skip this process
                debugLog(`Process ${pid} not listening on any port, skipping`);
                continue;
            }

            // Only include if it has a listening port (actual server)
            // Parse and validate port range to prevent out-of-range values
            if (!port) {
                debugLog(`Process ${pid} has no port, skipping`);
                continue;
            }
            const parsedPort = parseInt(port, 10);
            if (!isValidPort(parsedPort)) {
                debugLog(`Process ${pid} has invalid port ${parsedPort}, skipping`);
                continue;
            }

            // Prefer the project path from the Nuxt CLI token. Windows has no
            // reliable Win32 cwd; Unix lsof can also return Unknown.
            let workingDir = inferWorkingDirFromCommand(fullCommand)
                ?? (workingDirCache.get(pid)?.command === fullCommand
                    ? workingDirCache.get(pid)?.workingDir ?? 'Unknown'
                    : 'Unknown');
            if (workingDir === 'Unknown') {
                try {
                    workingDir = await getProcessWorkingDir(parsePid(pid));
                } catch {
                    debugLog(`Could not get working directory for ${pid}`);
                }
            }
            if (workingDir !== 'Unknown') {
                workingDirCache.set(pid, { command: fullCommand, workingDir });
            }

            processMap.set(pid, {
                pid,
                command: fullCommand.length > DEFAULT_CONFIG.COMMAND_TRUNCATE_LENGTH
                    ? fullCommand.substring(0, DEFAULT_CONFIG.COMMAND_TRUNCATE_SUFFIX_LENGTH) + '...'
                    : fullCommand,
                workingDir: formatPathForDisplay(workingDir),
                port,
                ancestorPids: entry.ancestorPids,
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
    const numPid = parsePid(pid);
    debugLog(`Killing process ${numPid}`);

    try {
        const originalCommand = await getProcessCommand(numPid);
        try {
            process.kill(numPid, 'SIGTERM');
        } catch (error) {
            if (isProcessGoneError(error)) {
                debugLog(`Process ${numPid} already gone`);
                return;
            }
            throw error;
        }

        const gracefulTimeoutMs = getConfig().gracefulShutdownTimeout;
        const deadline = Date.now() + gracefulTimeoutMs;
        while (Date.now() < deadline) {
            try {
                process.kill(numPid, 0);
            } catch {
                debugLog(`Process ${numPid} terminated successfully`);
                return;
            }
            await sleep(Math.min(100, Math.max(0, deadline - Date.now())));
        }

        const currentCommand = await getProcessCommand(numPid);
        if (shouldRefuseSigkillEscalation(originalCommand, currentCommand)) {
            throw new Error(`PID ${numPid} changed identity before SIGKILL; refusing escalation`);
        }
        debugLog(`Process ${numPid} still alive after ${gracefulTimeoutMs}ms, sending SIGKILL`);
        try {
            process.kill(numPid, 'SIGKILL');
        } catch (error) {
            if (isProcessGoneError(error)) {
                return;
            }
            throw error;
        }
    } catch (error) {
        debugLog(`Error killing process ${numPid}:`, getErrorMessage(error));
        throw new Error(
            `Failed to kill process ${numPid}: ${getErrorMessage(error)}`,
            { cause: error }
        );
    }
}

/**
 * Kill descendants (deepest first) then the parent. Uses the process table
 * so grandchildren of `npm run dev` are not left behind after `pkill -P`.
 */
export async function killProcessTree(parentPid: string): Promise<void> {
    const numPid = parsePid(parentPid);
    debugLog(`Killing process tree for ${numPid}`);

    try {
        const table = await listProcessTable();
        const descendants = collectDescendantPids(String(numPid), table);
        const results = await Promise.allSettled(descendants.map(pid => killProcess(pid)));
        results.forEach((result, index) => {
            if (result.status === 'rejected') {
                debugLog(`Failed to kill descendant ${descendants[index]}:`, getErrorMessage(result.reason));
            }
        });
    } catch (error) {
        debugLog(`Could not enumerate descendants of ${numPid}:`, getErrorMessage(error));
    }

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

    const results = await Promise.allSettled(processes.map(proc => killProcess(proc.pid)));
    const killedCount = results.filter(result => result.status === 'fulfilled').length;
    results.forEach((result, index) => {
        if (result.status === 'rejected') {
            debugLog(`Failed to kill ${processes[index].pid}:`, getErrorMessage(result.reason));
        }
    });

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

    const results = await Promise.allSettled(matchingProcesses.map(proc => killProcess(proc.pid)));
    results.forEach((result, index) => {
        if (result.status === 'rejected') {
            debugLog(`Failed to kill ${matchingProcesses[index].pid}:`, getErrorMessage(result.reason));
        }
    });
    return results.filter(result => result.status === 'fulfilled').length;
}

/**
 * Sleep that resolves early once `signal` aborts, so an abandoned poll
 * returns immediately instead of waiting out the remaining interval.
 * Both settle paths drop their listener, so no leak either way.
 */
function sleepOrAbort(ms: number, signal?: AbortSignal): Promise<void> {
    if (!signal) {
        return sleep(ms);
    }
    if (signal.aborted) {
        return Promise.resolve();
    }
    return new Promise<void>(resolve => {
        const onAbort = (): void => {
            clearTimeout(timer);
            resolve();
        };
        const timer = setTimeout(() => {
            signal.removeEventListener('abort', onAbort);
            resolve();
        }, ms);
        signal.addEventListener('abort', onAbort, { once: true });
    });
}

/** Wait for a listening Nuxt descendant of a package-manager wrapper. */
export async function waitForProcessTreePort(
    parentPid: number,
    workingDir: string,
    expectedPort: number,
    timeoutMs: number = DEFAULT_CONFIG.SERVER_START_TIMEOUT_MS,
    signal?: AbortSignal,
    detectProcesses: (signal?: AbortSignal) => Promise<NuxtProcess[]> = getRunningNuxtProcesses
): Promise<number | null> {
    const parent = parsePid(String(parentPid)).toString();
    const startTime = Date.now();
    while (!signal?.aborted && Date.now() - startTime < timeoutMs) {
        const processes = (await detectProcesses(signal)).map(proc => ({
            ...proc,
            workingDir: expandPath(proc.workingDir),
        }));
        // An abort that landed while detection was in flight must end the
        // loop before its result is consumed or another interval is spent.
        if (signal?.aborted) {
            return null;
        }
        const port = selectWaitForProcessTreePort(processes, parent, workingDir, expectedPort);
        if (port !== null) {
            return port;
        }
        try {
            process.kill(parentPid, 0);
        } catch {
            return null;
        }
        await sleepOrAbort(250, signal);
    }
    return null;
}

/**
 * Verify a process is completely terminated
 */
export async function verifyProcessTerminated(pid: string, maxWaitMs: number = 2000): Promise<boolean> {
    const numPid = parsePid(pid);
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
