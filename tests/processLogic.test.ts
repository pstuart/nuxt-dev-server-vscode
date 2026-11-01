import { describe, expect, it, vi } from 'vitest';

// The cancellation regression below imports src/processManager, which reaches
// utils.ts → vscode. Mock vscode so the module loads in a plain Node test.
// vi.mock is hoisted above static imports, so load the shared factory lazily.
vi.mock('vscode', async () => (await import('./vscodeMock')).mockVscodeModule());

const { waitForProcessTreePort } = await import('../src/processManager');
import * as processLogic from '../src/processLogic';
import {
    ancestorPids,
    collectDescendantPids,
    createOutputPortProbe,
    inferWorkingDirFromCommand,
    isManagedNuxtProcess,
    isProcessGoneError,
    isValidDevCommand,
    matchesNuxtDevPreview,
    parseUnixProcessTable,
    parseWindowsProcessJsonLines,
    selectExtraNuxtProcesses,
    selectManagedNuxtProcess,
    selectPreferredNuxtPort,
    selectWaitForProcessTreePort,
    shouldRefuseSigkillEscalation,
} from '../src/processLogic';
import { evaluateWorkspaceTrust, untrustedWorkspaceMessage } from '../src/workspaceTrustLogic';
import { NuxtProcess } from '../src/types';

/** Shared NuxtProcess factory: canonical dev command, optional listening port. */
const makeNuxtProcess = (
    pid: string,
    workingDir: string,
    port?: string,
    ancestorPids: string[] = [],
    command = 'node /workspace/node_modules/.bin/nuxt dev'
): NuxtProcess => ({
    pid,
    workingDir,
    ancestorPids,
    command,
    ...(port === undefined ? {} : { port }),
});

describe('matchesNuxtDevPreview', () => {
    it.each([
        '/usr/bin/node /workspace/node_modules/.bin/nuxt dev',
        'node "/workspace with spaces/node_modules/.bin/nuxt" preview',
        'node C:\\workspace\\node_modules\\.bin\\nuxt dev',
        'node C:\\workspace\\node_modules\\.bin\\nuxt.cmd dev',
        'node /workspace/node_modules/.bin/nuxi preview',
        'nuxi dev',
    ])('accepts an exact Nuxt executable and command: %s', command => {
        expect(matchesNuxtDevPreview(command)).toBe(true);
    });

    it.each([
        'node /tmp/nuxt-helper development',
        'node /tmp/not-nuxt preview',
        'node /workspace/node_modules/.bin/nuxt build',
        'node /tmp/script.js --message "nuxt dev"',
    ])('rejects substring and non-server matches: %s', command => {
        expect(matchesNuxtDevPreview(command)).toBe(false);
    });
});

describe('process ancestry', () => {
    const table = parseUnixProcessTable(`
      10     1 npm run dev
      11    10 sh -c nuxt dev
      12    11 node /workspace/node_modules/.bin/nuxt dev
      20     1 unrelated
      malformed
    `);

    it('parses pid, parent pid, and the complete command', () => {
        expect(table).toHaveLength(4);
        expect(table[2]).toEqual({
            pid: '12',
            parentPid: '11',
            command: 'node /workspace/node_modules/.bin/nuxt dev',
        });
    });

    it('walks the parent chain nearest-first', () => {
        expect(ancestorPids('12', table)).toEqual(['11', '10', '1']);
    });
});

describe('selectPreferredNuxtPort', () => {
    it('prefers the requested application port over socket order', () => {
        expect(selectPreferredNuxtPort(['24678', '3001'], 3001)).toBe('3001');
    });

    it('prefers a non-HMR port and rejects invalid values', () => {
        expect(selectPreferredNuxtPort(['0', '70000', '24678', '3000'])).toBe('3000');
        expect(selectPreferredNuxtPort(['24678'])).toBe('24678');
    });
});

describe('selectExtraNuxtProcesses', () => {
    const process = (
        pid: string,
        workingDir: string,
        ancestors: string[] = []
    ): NuxtProcess => makeNuxtProcess(pid, workingDir, '3000', ancestors);

    it('excludes the managed wrapper and every listening descendant', () => {
        const extras = selectExtraNuxtProcesses([
            process('100', '/workspace'),
            process('102', '/workspace', ['101', '100']),
            process('200', '/workspace'),
        ], '/workspace', '100');

        expect(extras.map(item => item.pid)).toEqual(['200']);
    });

    it('never selects another workspace for unattended cleanup', () => {
        const extras = selectExtraNuxtProcesses([
            process('200', '/workspace'),
            process('300', '/unrelated'),
        ], '/workspace');

        expect(extras.map(item => item.pid)).toEqual(['200']);
    });

    it('identifies the listening descendant instead of the wrapper PID', () => {
        const processes = [
            process('102', '/workspace', ['101', '100']),
            { ...process('103', '/workspace', ['100']), port: '3001' },
            { ...process('200', '/workspace'), port: '3001' },
        ];

        expect(selectManagedNuxtProcess(processes, '100', '/workspace', 3001)?.pid)
            .toBe('103');
        expect(selectManagedNuxtProcess(processes, '999', '/workspace', 3001))
            .toBeUndefined();
    });
});

describe('selectExcessNuxtProcesses', () => {
    const process = (
        pid: string,
        workingDir: string,
        ancestors: string[] = []
    ): NuxtProcess => makeNuxtProcess(pid, workingDir, '3000', ancestors);

    // The helper is a fix for the length-based slice in autoKill. Bind the
    // reference through a typed function value so the regression test still
    // type-checks against the original source (no exported symbol yet): if the
    // helper is missing at runtime, the test fails by assertion rather than by
    // a compile/import error.
    const excessSelection = (processLogic as {
        selectExcessNuxtProcesses?: (
            extraProcesses: ReadonlyArray<NuxtProcess>,
            maxExtraServers: number
        ) => NuxtProcess[];
    }).selectExcessNuxtProcesses;
    const selectExcess = (
        extraProcesses: ReadonlyArray<NuxtProcess>,
        maxExtraServers: number
    ): NuxtProcess[] => {
        expect(typeof excessSelection).toBe('function');
        return excessSelection!(extraProcesses, maxExtraServers);
    };

    it('selects only valid-PID extras, lowest first, excluding the invalid PID', () => {
        // Three workspace extras (one non-numeric PID) with maxExtraServers=1.
        // validCount = 2, so the lowest (2 - 1) = 1 entry is selected — PID 100 —
        // and 'abc' is never selected. The original length-based slice computed
        // 3 - 1 = 2 and killed both valid servers [100, 200].
        const extras = selectExtraNuxtProcesses([
            process('100', '/workspace'),
            process('200', '/workspace'),
            process('abc', '/workspace'),
        ], '/workspace');

        expect(extras.map(item => item.pid)).toEqual(['100', '200', 'abc']);

        const toKill = selectExcess(extras, 1);

        expect(toKill.map(item => item.pid)).toEqual(['100']);
        expect(toKill.some(item => item.pid === 'abc')).toBe(false);
    });

    it('keeps the original kill count when every extra PID is valid', () => {
        // Regression guard against the earlier over-shrink: three valid extras
        // with maxExtraServers=1 still kill the two lowest PIDs, exactly as the
        // original length-based slice did (3 - 1 = 2).
        const extras = selectExtraNuxtProcesses([
            process('300', '/workspace'),
            process('100', '/workspace'),
            process('200', '/workspace'),
        ], '/workspace');

        expect(selectExcess(extras, 1).map(item => item.pid))
            .toEqual(['100', '200']);
    });

    it('kills nothing when valid extras are within the limit', () => {
        const extras = selectExtraNuxtProcesses([
            process('100', '/workspace'),
            process('200', '/workspace'),
            process('0', '/workspace'),
        ], '/workspace');

        expect(selectExcess(extras, 2)).toEqual([]);
    });
});

describe('untrusted start', () => {
    it('refuses start with the same trust-the-folder message used in production', () => {
        const decision = evaluateWorkspaceTrust(false, 'start');
        expect(decision.allowed).toBe(false);
        if (!decision.allowed) {
            expect(decision.message).toBe(
                'Cannot start Nuxt dev server in an untrusted workspace. Trust the folder first.'
            );
        }
    });

    it('allows start when the workspace is trusted', () => {
        expect(evaluateWorkspaceTrust(true, 'start')).toEqual({ allowed: true });
    });

    it('refuses kill-all, list-and-kill, and auto-kill extras when untrusted', () => {
        for (const action of ['killAll', 'listAndKill', 'autoKillExtras'] as const) {
            const decision = evaluateWorkspaceTrust(false, action);
            expect(decision.allowed).toBe(false);
            if (!decision.allowed) {
                expect(decision.message).toBe(untrustedWorkspaceMessage(action));
                expect(decision.message).toMatch(/Trust the folder first\.$/);
            }
        }
    });
});

describe('isValidDevCommand', () => {
    it.each(['dev', 'dev:custom', 'preview', 'dev_local', 'DEV-2'])(
        'accepts a safe script name: %s',
        command => {
            expect(isValidDevCommand(command)).toBe(true);
        }
    );

    it.each([
        'dev; rm -rf /',
        'dev && malicious',
        'dev | cat',
        'dev`id`',
        'dev $(whoami)',
        '../evil',
        'dev extra',
        '',
    ])('rejects an injectable or empty command: %s', command => {
        expect(isValidDevCommand(command)).toBe(false);
    });

    it('rejects commands at or over 100 characters', () => {
        expect(isValidDevCommand('d'.repeat(100))).toBe(false);
        expect(isValidDevCommand('d'.repeat(99))).toBe(true);
    });
});

describe('waitForProcessTreePort selection', () => {
    const process = (
        pid: string,
        workingDir: string,
        port: string,
        ancestors: string[] = []
    ): NuxtProcess => makeNuxtProcess(pid, workingDir, port, ancestors);

    it('returns the expected descendant port when the wrapper tree is listening', () => {
        const port = selectWaitForProcessTreePort(
            [
                process('102', '/workspace', '3000', ['101', '100']),
                process('103', '/workspace', '3001', ['100']),
            ],
            '100',
            '/workspace',
            3001
        );
        expect(port).toBe(3001);
    });

    it('falls back to the first listening descendant when the expected port is absent', () => {
        expect(selectWaitForProcessTreePort(
            [process('102', '/workspace', '3000', ['100'])],
            '100',
            '/workspace',
            9999
        )).toBe(3000);
    });

    it('returns null when no descendant is listening or the port is out of range', () => {
        expect(selectWaitForProcessTreePort([], '100', '/workspace', 3000)).toBeNull();
        expect(selectWaitForProcessTreePort(
            [process('200', '/other', '3000')],
            '100',
            '/workspace',
            3000
        )).toBeNull();
        expect(selectWaitForProcessTreePort(
            [process('102', '/workspace', '70000', ['100'])],
            '100',
            '/workspace',
            70000
        )).toBeNull();
    });
});

describe('waitForProcessTreePort cancellation', () => {
    // process.pid is always alive, so the parent-liveness check never ends the loop.
    const ALIVE_PID = process.pid;

    const listening = (pid: string, port: string): NuxtProcess =>
        makeNuxtProcess(pid, '/workspace', port, [String(ALIVE_PID)]);

    it('performs no detection when the signal is already aborted', async () => {
        let calls = 0;
        const detect = async (): Promise<NuxtProcess[]> => {
            calls++;
            return [];
        };
        const controller = new AbortController();
        controller.abort();

        const result = await waitForProcessTreePort(
            ALIVE_PID, '/workspace', 3000, 60_000, controller.signal, detect
        );

        expect(result).toBeNull();
        expect(calls).toBe(0);
    });

    it('returns promptly when the signal aborts while the poll is sleeping and stops calling detection', async () => {
        let calls = 0;
        const detect = async (): Promise<NuxtProcess[]> => {
            calls++;
            return [];
        };
        const controller = new AbortController();

        const poll = waitForProcessTreePort(
            ALIVE_PID, '/workspace', 3000, 60_000, controller.signal, detect
        );
        // Let the first detection finish so the loop parks in the 250ms interval.
        while (calls === 0) {
            await new Promise<void>(resolve => setImmediate(resolve));
        }

        const abortTime = Date.now();
        controller.abort();
        const result = await poll;
        const elapsedAfterAbort = Date.now() - abortTime;

        // The pre-fix loop slept out the whole 250ms interval before noticing
        // the abort; cancellation must resolve within a scheduling slice.
        expect(elapsedAfterAbort).toBeLessThan(100);
        expect(result).toBeNull();

        // No further detection iteration may start after the abort.
        const callsAtAbort = calls;
        await new Promise<void>(resolve => setTimeout(resolve, 300));
        expect(calls).toBe(callsAtAbort);
    });

    it('discards an in-flight detection result when the signal aborts during it', async () => {
        let calls = 0;
        const controller = new AbortController();
        // The caller (devServer) aborts as soon as stdout reports a port, so a
        // detection that resolves after the abort is stale: the loop must not
        // consume its result or start a second iteration.
        const detect = async (): Promise<NuxtProcess[]> => {
            calls++;
            controller.abort();
            return [listening('102', '3000')];
        };

        const result = await waitForProcessTreePort(
            ALIVE_PID, '/workspace', 3000, 60_000, controller.signal, detect
        );

        expect(result).toBeNull();
        expect(calls).toBe(1);
    });

    it('still resolves the listening port when no signal is provided', async () => {
        const detect = async (): Promise<NuxtProcess[]> => [listening('102', '3000')];

        const result = await waitForProcessTreePort(
            ALIVE_PID, '/workspace', 3000, 60_000, undefined, detect
        );

        expect(result).toBe(3000);
    });
});

describe('isManagedNuxtProcess', () => {
    it('matches the wrapper PID and any listening descendant', () => {
        expect(isManagedNuxtProcess({ pid: '100', ancestorPids: [] }, '100')).toBe(true);
        expect(isManagedNuxtProcess({ pid: '102', ancestorPids: ['101', '100'] }, '100')).toBe(true);
        expect(isManagedNuxtProcess({ pid: '200', ancestorPids: [] }, '100')).toBe(false);
        expect(isManagedNuxtProcess({ pid: '102', ancestorPids: ['101', '100'] })).toBe(false);
    });
});

describe('collectDescendantPids', () => {
    const table = parseUnixProcessTable(`
      10     1 npm run dev
      11    10 sh -c nuxt dev
      12    11 node /workspace/node_modules/.bin/nuxt dev
      20     1 unrelated
    `);

    it('returns grandchildren before children (deepest first)', () => {
        expect(collectDescendantPids('10', table)).toEqual(['12', '11']);
    });

    it('returns an empty list when the parent has no children', () => {
        expect(collectDescendantPids('20', table)).toEqual([]);
    });

    it('does not loop when the process table contains a cycle', () => {
        expect(collectDescendantPids('1', [
            { pid: '1', parentPid: '2', command: 'a' },
            { pid: '2', parentPid: '1', command: 'b' },
        ])).toEqual(['1', '2']);
    });
});

describe('inferWorkingDirFromCommand', () => {
    it('reads the project root from a node_modules Nuxt CLI path', () => {
        expect(inferWorkingDirFromCommand(
            'node /workspace/node_modules/.bin/nuxt dev'
        )).toBe('/workspace');
        expect(inferWorkingDirFromCommand(
            'node "/workspace with spaces/node_modules/.bin/nuxt" preview'
        )).toBe('/workspace with spaces');
        expect(inferWorkingDirFromCommand(
            'node C:\\workspace\\node_modules\\.bin\\nuxt.cmd dev'
        )).toBe('C:\\workspace');
        expect(inferWorkingDirFromCommand(
            'node /workspace/node_modules/nuxt/bin/nuxt.mjs dev'
        )).toBe('/workspace');
        expect(inferWorkingDirFromCommand(
            'node /workspace/node_modules/.bin/nuxi dev'
        )).toBe('/workspace');
    });

    it('returns undefined when the command has no Nuxt CLI path', () => {
        expect(inferWorkingDirFromCommand('node /tmp/script.js --message "nuxt dev"')).toBeUndefined();
    });
});

describe('parseWindowsProcessJsonLines', () => {
    it('parses compressed CIM JSON lines and skips junk', () => {
        const stdout = [
            'Get-CimInstance warning',
            '{"pid":10,"parentPid":1,"command":"npm run dev"}',
            'not-json',
            '{"pid":12,"parentPid":10,"command":"node C:\\\\workspace\\\\node_modules\\\\.bin\\\\nuxt dev"}',
        ].join('\r\n');

        expect(parseWindowsProcessJsonLines(stdout)).toEqual([
            { pid: '10', parentPid: '1', command: 'npm run dev' },
            { pid: '12', parentPid: '10', command: 'node C:\\workspace\\node_modules\\.bin\\nuxt dev' },
        ]);
    });
});

describe('isProcessGoneError', () => {
    it('accepts Node ESRCH and rejects other failures', () => {
        expect(isProcessGoneError(Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' }))).toBe(true);
        expect(isProcessGoneError(Object.assign(new Error('EPERM'), { code: 'EPERM' }))).toBe(false);
        expect(isProcessGoneError(new Error('ESRCH'))).toBe(false);
        expect(isProcessGoneError('ESRCH')).toBe(false);
    });
});

describe('kill identity change before SIGKILL', () => {
    it('allows escalation only when the command line is unchanged', () => {
        expect(shouldRefuseSigkillEscalation(
            'node /workspace/node_modules/.bin/nuxt dev',
            'node /workspace/node_modules/.bin/nuxt dev'
        )).toBe(false);
    });

    it('refuses SIGKILL when the PID was reused or the original command vanished', () => {
        expect(shouldRefuseSigkillEscalation(
            'node /workspace/node_modules/.bin/nuxt dev',
            'node /unrelated/server.js'
        )).toBe(true);
        expect(shouldRefuseSigkillEscalation(
            'node /workspace/node_modules/.bin/nuxt dev',
            undefined
        )).toBe(true);
        expect(shouldRefuseSigkillEscalation(undefined, 'node /workspace/node_modules/.bin/nuxt dev'))
            .toBe(true);
    });
});

describe('outputPort rejection on early exit', () => {
    it('rejects the outputPort promise when the process exits before printing a port', async () => {
        const outputPort = createOutputPortProbe();

        outputPort.rejectIfPending('process exited with code 1');
        outputPort.rejectIfPending('process closed with code 1');

        const result = await Promise.race([
            outputPort.promise,
            new Promise<number>(r => setTimeout(() => r(-1), 100)),
        ]).catch(() => null);
        expect(result).toBeNull();
    });

    it('does not reject after the port was already resolved from stdout', async () => {
        const outputPort = createOutputPortProbe();

        outputPort.resolve(3000);
        outputPort.rejectIfPending('process closed with code 0');

        const result = await Promise.race([
            outputPort.promise,
            new Promise<number>(r => setTimeout(() => r(-1), 100)),
        ]);
        expect(result).toBe(3000);
    });

    it('resolves the race immediately when process dies, not after polling timeout', async () => {
        const outputPort = createOutputPortProbe();
        outputPort.rejectIfPending('process exited with code 1');

        const startTime = Date.now();
        const result = await Promise.race([
            outputPort.promise,
            new Promise<number>(r => setTimeout(() => r(null as unknown as number), 3000)),
        ]).catch(() => null);
        const elapsed = Date.now() - startTime;

        expect(result).toBeNull();
        expect(elapsed).toBeLessThan(1000);
    });

    it('does not emit unhandledRejection when polling wins then the process exits', async () => {
        const unhandled: unknown[] = [];
        const onUnhandled = (reason: unknown): void => {
            unhandled.push(reason);
        };
        process.on('unhandledRejection', onUnhandled);
        try {
            const outputPort = createOutputPortProbe();
            const result = await Promise.race([
                outputPort.promise,
                Promise.resolve(3000),
            ]).catch(() => null);
            expect(result).toBe(3000);

            outputPort.rejectIfPending('process closed with code 0');
            await new Promise<void>(resolve => setImmediate(resolve));
            expect(unhandled).toEqual([]);
        } finally {
            process.off('unhandledRejection', onUnhandled);
        }
    });
});
