import { describe, expect, it } from 'vitest';
import {
    ancestorPids,
    collectDescendantPids,
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
    ): NuxtProcess => ({
        pid,
        workingDir,
        ancestorPids: ancestors,
        command: 'node /workspace/node_modules/.bin/nuxt dev',
        port: '3000',
    });

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
    ): NuxtProcess => ({
        pid,
        workingDir,
        ancestorPids: ancestors,
        command: 'node /workspace/node_modules/.bin/nuxt dev',
        port,
    });

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
