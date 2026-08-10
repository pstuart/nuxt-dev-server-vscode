import { NuxtProcess } from './types';

export interface ProcessTableEntry {
    pid: string;
    parentPid: string;
    command: string;
}

const NUXT_COMMANDS = new Set(['dev', 'preview']);
const HMR_PORT = '24678';

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
    return normalized.slice(normalized.lastIndexOf('/') + 1).toLowerCase();
}

/** Match an argv token named exactly `nuxt` followed by the dev/preview command. */
export function matchesNuxtDevPreview(command: string): boolean {
    const tokens = commandTokens(command);
    return tokens.some((token, index) => {
        if (executableName(token) !== 'nuxt') {
            return false;
        }
        return NUXT_COMMANDS.has(tokens[index + 1]?.toLowerCase() ?? '');
    });
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
        if (!managedPid) {
            return true;
        }
        return proc.pid !== managedPid && !proc.ancestorPids.includes(managedPid);
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
