import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

// utils.ts imports vscode at module level; provide a minimal mock so the
// module can be imported in a plain Node test environment.
vi.mock('vscode', () => ({
    window: {
        createOutputChannel: vi.fn(() => ({ appendLine: vi.fn(), dispose: vi.fn() })),
        showErrorMessage: vi.fn(),
        showWarningMessage: vi.fn(),
        showInformationMessage: vi.fn(),
    },
    workspace: {
        getConfiguration: vi.fn(() => ({
            get: vi.fn((_key: string, defaultVal: unknown) => defaultVal),
        })),
    },
}));

const { formatPathForDisplay, expandPath } = await import('../src/utils');

const ORIGINAL_HOME = process.env.HOME;

function setHome(home: string | undefined): void {
    if (home === undefined) {
        delete process.env.HOME;
    } else {
        process.env.HOME = home;
    }
}

beforeEach(() => {
    setHome('/home/bot');
});

afterEach(() => {
    if (ORIGINAL_HOME === undefined) {
        delete process.env.HOME;
    } else {
        process.env.HOME = ORIGINAL_HOME;
    }
});

describe('expandPath', () => {
    it('expands bare ~ to the home directory', () => {
        expect(expandPath('~')).toBe('/home/bot');
    });

    it('expands ~/sub/path by appending to the home directory', () => {
        expect(expandPath('~/projects/nuxt-app')).toBe('/home/bot/projects/nuxt-app');
    });

    it('does not expand ~user forms (different user home)', () => {
        expect(expandPath('~alice/projects')).toBe('~alice/projects');
    });

    it('returns the path unchanged when it does not start with ~', () => {
        expect(expandPath('/home/bot/projects')).toBe('/home/bot/projects');
        expect(expandPath('/tmp/scratch')).toBe('/tmp/scratch');
        expect(expandPath('relative/path')).toBe('relative/path');
    });

    it('returns the path unchanged when HOME is not set', () => {
        setHome(undefined);
        expect(expandPath('~')).toBe('~');
        expect(expandPath('~/projects')).toBe('~/projects');
    });
});

describe('formatPathForDisplay', () => {
    it('replaces the home directory with ~', () => {
        expect(formatPathForDisplay('/home/bot/projects/nuxt-app')).toBe('~/projects/nuxt-app');
    });

    it('replaces an exact home-directory match with ~', () => {
        expect(formatPathForDisplay('/home/bot')).toBe('~');
    });

    it('does not treat sibling directories that share the prefix as home paths', () => {
        // /home/botX is NOT under /home/bot — the old startsWith check would
        // incorrectly produce '~/X/...'.
        expect(formatPathForDisplay('/home/botX/projects')).toBe('/home/botX/projects');
    });

    it('returns non-home paths unchanged', () => {
        expect(formatPathForDisplay('/tmp/scratch')).toBe('/tmp/scratch');
        expect(formatPathForDisplay('/var/log')).toBe('/var/log');
    });

    it('returns the path unchanged when HOME is not set', () => {
        setHome(undefined);
        expect(formatPathForDisplay('/home/bot/projects')).toBe('/home/bot/projects');
    });

    it('round-trips: expandPath(formatPathForDisplay(p)) restores the original', () => {
        const original = '/home/bot/projects/my-app';
        const displayed = formatPathForDisplay(original);
        expect(expandPath(displayed)).toBe(original);
    });
});
