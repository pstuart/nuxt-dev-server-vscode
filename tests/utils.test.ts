import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

// utils.ts imports vscode at module level; provide a minimal mock so the
// module can be imported in a plain Node test environment.
// vi.mock is hoisted above static imports, so load the shared factory lazily.
vi.mock('vscode', async () => (await import('./vscodeMock')).mockVscodeModule());

const { formatPathForDisplay, expandPath, getConfig } = await import('../src/utils');
const { clampNumber } = await import('../src/validation');

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

describe('getConfig numeric clamping equivalence', () => {
    interface NumericField {
        key: 'defaultPort' | 'updateInterval' | 'autoKillTimeout' | 'autoKillIdleTime' | 'maxExtraServers' | 'gracefulShutdownTimeout';
        min: number;
        max: number;
        fallback: number;
    }

    // Bounds mirror the getConfig call sites exactly.
    const numericFields: NumericField[] = [
        { key: 'defaultPort', min: 1, max: 65535, fallback: 3000 },
        { key: 'updateInterval', min: 1000, max: 60000, fallback: 5000 },
        { key: 'autoKillTimeout', min: 0, max: Number.POSITIVE_INFINITY, fallback: 0 },
        { key: 'autoKillIdleTime', min: 0, max: Number.POSITIVE_INFINITY, fallback: 0 },
        { key: 'maxExtraServers', min: 0, max: Number.POSITIVE_INFINITY, fallback: 0 },
        { key: 'gracefulShutdownTimeout', min: 1000, max: 30000, fallback: 5000 }
    ];

    // Pre-consolidation implementation of the private clampConfigNumber.
    const legacyClamp = (value: number, min: number, max: number, fallback: number): number => {
        if (!Number.isFinite(value)) { return fallback; }
        return Math.min(max, Math.max(min, value));
    };

    const sharedClamp = (value: number, min: number, max: number, fallback: number): number =>
        clampNumber(value, min, max) ?? fallback;

    it.each([
        ['non-finite NaN uses the fallback', NaN],
        ['+Infinity falls back per config contract', Infinity],
        ['-Infinity falls back per config contract', -Infinity],
        ['in-range value passes through', 42],
        ['below min clamps to min', -100],
        ['above max clamps to max', 1e9]
    ])('%s', (_label, value: number) => {
        for (const field of numericFields) {
            expect(getConfigFieldEquals(field, value, legacyClamp, sharedClamp)).toBe(true);
        }
    });

    function getConfigFieldEquals(
        field: NumericField,
        value: number,
        legacy: typeof legacyClamp,
        shared: typeof sharedClamp
    ): boolean {
        // The shared helper and the legacy inline clamp must agree for this field.
        return legacy(value, field.min, field.max, field.fallback) === shared(value, field.min, field.max, field.fallback);
    }
});
