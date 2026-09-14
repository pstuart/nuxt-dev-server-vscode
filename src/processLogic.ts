import { NuxtProcess } from './types';
import { isValidPort } from './validation';

export interface ProcessTableEntry {
    pid: string;
    parentPid: string;
    command: string;
}

const NUXT_COMMANDS = new Set(['dev', 'preview']);
const NUXT_EXECUTABLES = new Set(['nuxt', 'nuxi']);
const HMR_PORT = '24678';
const NODE_ERRNO_GONE = 'ESRCH';

function commandTokens(command: string): string[] {
    const tokens: string[] = [];
    const pattern = /"([^"]*)"|'([^']*)'|([^\s]+)/g;
    for (const match of command.matchAll(pattern)) {
        tokens.push(match[1] ?? match[2] ?? match[3]);
    }
    return tokens;
}

function executableName(token: string): string {
    const normalized = token.replace(/\\/g, '/');
    const base = normalized.slice(normalized.lastIndexOf('/') + 1).toLowerCase();
    return base.replace(/\.(cmd|exe|bat|ps1|js|mjs|cjs)$/i, '');
}

/** Match an argv token named `nuxt` or `nuxi` followed by the dev/preview command. */
export function matchesNuxtDevPreview(command: string): boolean {
    const tokens = commandTokens(command);
    return tokens.some((token, index) => {
        if (!NUXT_EXECUTABLES.has(executableName(token))) {
            return false;
        }
        return NUXT_COMMANDS.has(tokens[index + 1]?.toLowerCase() ?? '');
    });
}

/**
 * Project root from a Nuxt CLI path inside node_modules.
 * Windows Win32_Process has no cwd; this is the reliable fallback.
 */
export function inferWorkingDirFromCommand(command: string): string | undefined {
    for (const token of commandTokens(command)) {
        const match = token.match(
            /^(.*?)[/\\]node_modules[/\\](?:\.bin[/\\](?:nuxt|nuxi)(?:\.\w+)?|(?:nuxt|nuxi)(?:[/\\]|$))/i
        );
        if (match?.[1]) {
            return match[1];
        }
    }
    return undefined;
}

/** Listening descendant or the wrapper itself. */
export function isManagedNuxtProcess(
    proc: Pick<NuxtProcess, 'pid' | 'ancestorPids'>,
    managedPid?: string
): boolean {
    if (!managedPid) {
        return false;
    }
    return proc.pid === managedPid || proc.ancestorPids.includes(managedPid);
}

/** Descendants of parentPid, deepest first. Cycle-safe. */
export function collectDescendantPids(
    parentPid: string,
    entries: ReadonlyArray<ProcessTableEntry>
): string[] {
    const childrenByParent = new Map<string, string[]>();
    for (const entry of entries) {
        const siblings = childrenByParent.get(entry.parentPid);
        if (siblings) {
            siblings.push(entry.pid);
        } else {
            childrenByParent.set(entry.parentPid, [entry.pid]);
        }
    }

    const result: string[] = [];
    const visited = new Set<string>();
    const walk = (pid: string): void => {
        for (const child of childrenByParent.get(pid) ?? []) {
            if (visited.has(child)) {
                continue;
            }
            visited.add(child);
            walk(child);
            result.push(child);
        }
    };
    walk(parentPid);
    return result;
}

/** Node `process.kill` on a missing PID. */
export function isProcessGoneError(error: unknown): boolean {
    return Boolean(
        error &&
        typeof error === 'object' &&
        'code' in error &&
        (error as { code?: unknown }).code === NODE_ERRNO_GONE
    );
}

/** One compressed JSON object per line from the Windows CIM listing. */
export function parseWindowsProcessJsonLines(stdout: string): ProcessTableEntry[] {
    const table: ProcessTableEntry[] = [];
    for (const line of stdout.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('{')) {
            continue;
        }
        try {
            const obj = JSON.parse(trimmed) as {
                pid?: number | string;
                parentPid?: number | string;
                command?: string;
            };
            if (obj.pid !== undefined && obj.parentPid !== undefined && obj.command) {
                table.push({
                    pid: String(obj.pid),
                    parentPid: String(obj.parentPid),
                    command: String(obj.command),
                });
            }
        } catch {
            // skip malformed line
        }
    }
    return table;
}

export function parseUnixProcessTable(output: string): ProcessTableEntry[] {
    const entries: ProcessTableEntry[] = [];
    for (const line of output.split(/\r?\n/)) {
        const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
        if (match) {
            entries.push({ pid: match[1], parentPid: match[2], command: match[3] });
        }
    }
    return entries;
}

export function ancestorPids(
    pid: string,
    entries: ReadonlyArray<ProcessTableEntry>
): string[] {
    const parents = new Map(entries.map(entry => [entry.pid, entry.parentPid]));
    const ancestors: string[] = [];
    const visited = new Set<string>([pid]);
    let current = parents.get(pid);
    while (current && current !== '0' && !visited.has(current)) {
        ancestors.push(current);
        visited.add(current);
        current = parents.get(current);
    }
    return ancestors;
}

export function selectPreferredNuxtPort(
    ports: ReadonlyArray<string>,
    expectedPort?: number
): string | undefined {
    const valid = Array.from(new Set(ports)).filter(port => {
        const value = Number(port);
        return Number.isInteger(value) && value >= 1 && value <= 65535;
    });
    const expected = expectedPort?.toString();
    if (expected && valid.includes(expected)) {
        return expected;
    }
    return valid.find(port => port !== HMR_PORT) ?? valid[0];
}

function normalizedPath(path: string): string {
    return path.replace(/[\\/]+$/, '');
}

/** Restrict unattended cleanup to the active workspace and exclude owned descendants. */
export function selectExtraNuxtProcesses(
    processes: ReadonlyArray<NuxtProcess>,
    workspaceDir: string,
    managedPid?: string
): NuxtProcess[] {
    const workspace = normalizedPath(workspaceDir);
    return processes.filter(proc => {
        if (normalizedPath(proc.workingDir) !== workspace) {
            return false;
        }
        return !isManagedNuxtProcess(proc, managedPid);
    });
}

export function selectManagedNuxtProcess(
    processes: ReadonlyArray<NuxtProcess>,
    wrapperPid: string,
    workingDir: string,
    expectedPort: number
): NuxtProcess | undefined {
    const workspace = normalizedPath(workingDir);
    const descendants = processes.filter(proc =>
        proc.ancestorPids.includes(wrapperPid) &&
        normalizedPath(proc.workingDir) === workspace &&
        proc.port
    );
    return descendants.find(proc => proc.port === expectedPort.toString()) ?? descendants[0];
}

/**
 * Port chosen by waitForProcessTreePort: managed descendant, then 1–65535.
 */
export function selectWaitForProcessTreePort(
    processes: ReadonlyArray<NuxtProcess>,
    wrapperPid: string,
    workingDir: string,
    expectedPort: number
): number | null {
    const descendant = selectManagedNuxtProcess(processes, wrapperPid, workingDir, expectedPort);
    if (!descendant?.port) {
        return null;
    }
    const port = Number(descendant.port);
    if (isValidPort(port)) {
        return port;
    }
    return null;
}

/** npm script names only — blocks `dev; rm -rf /` style injection. */
export function isValidDevCommand(command: string): boolean {
    if (!command || typeof command !== 'string') {
        return false;
    }
    return /^[a-zA-Z0-9_:-]+$/.test(command) && command.length < 100;
}

/**
 * After SIGTERM times out, refuse SIGKILL if the PID was reused or the
 * command line disappeared (process already gone / identity changed).
 */
export function shouldRefuseSigkillEscalation(
    originalCommand: string | undefined,
    currentCommand: string | undefined
): boolean {
    return !originalCommand || currentCommand !== originalCommand;
}

const BINARY_NAME_RE = /^[a-zA-Z0-9_-]+$/;

/** Names passed to `which` / `where.exe` via execFile argv. */
export function isSafeBinaryName(binary: string): boolean {
    return BINARY_NAME_RE.test(binary);
}

interface OutputPortProbe {
    readonly promise: Promise<number>;
    resolve(port: number): void;
    rejectIfPending(reason: string): void;
}

/**
 * Port from stdout, or rejection if the child exits first.
 * Attaches a no-op catch so a later exit cannot become unhandled if
 * waitForProcessTreePort already won the start-up race.
 */
export function createOutputPortProbe(): OutputPortProbe {
    let settled = false;
    let resolvePort!: (port: number) => void;
    let rejectPort!: (reason: Error) => void;
    const promise = new Promise<number>((resolve, reject) => {
        resolvePort = resolve;
        rejectPort = reject;
    });
    void promise.catch(() => {});
    return {
        promise,
        resolve(port: number): void {
            if (!settled) {
                settled = true;
                resolvePort(port);
            }
        },
        rejectIfPending(reason: string): void {
            if (!settled) {
                settled = true;
                rejectPort(new Error(reason));
            }
        },
    };
}
