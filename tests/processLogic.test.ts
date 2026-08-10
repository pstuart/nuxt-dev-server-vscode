import { describe, expect, it } from 'vitest';
import {
    ancestorPids,
    matchesNuxtDevPreview,
    parseUnixProcessTable,
    selectExtraNuxtProcesses,
    selectManagedNuxtProcess,
    selectPreferredNuxtPort,
} from '../src/processLogic';
import { NuxtProcess } from '../src/types';

describe('matchesNuxtDevPreview', () => {
    it.each([
        '/usr/bin/node /workspace/node_modules/.bin/nuxt dev',
        'node "/workspace with spaces/node_modules/.bin/nuxt" preview',
        'node C:\\workspace\\node_modules\\.bin\\nuxt dev',
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
