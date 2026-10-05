import { readFileSync } from 'fs';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Values returned by the mocked workspace configuration for the setting key
// passed to get(); keys absent from the store fall back to the default that
// getConfig() itself supplies. Read lazily inside the mock factory below, so
// declaration order relative to vi.mock hoisting does not matter.
let mockSettings: Record<string, unknown> = {};

// utils.ts imports vscode at module level. Build on the shared mock
// (tests/vscodeMock.ts) but override getConfiguration so tests can drive
// getConfig() with out-of-range values. vi.mock is hoisted above static
// imports; the factory reads mockSettings only when get() is called.
vi.mock('vscode', async () => {
    const { mockVscodeModule } = await import('./vscodeMock');
    const mod = mockVscodeModule() as {
        window: Record<string, unknown>;
        workspace: { getConfiguration: unknown };
    };
    mod.workspace.getConfiguration = () => ({
        get: (key: string, fallback: unknown) =>
            Object.prototype.hasOwnProperty.call(mockSettings, key) ? mockSettings[key] : fallback,
    });
    return mod;
});

const { getConfig } = await import('../src/utils');
const { isValidDevCommand } = await import('../src/processLogic');
import packageJson from '../package.json';

interface SchemaProperty {
    type?: string;
    default?: unknown;
    minimum?: number;
    maximum?: number;
}

interface NumericContract {
    default: number;
    minimum?: number;
    maximum?: number;
}

// The publicly documented numeric contract, pinned here so a silent edit to
// package.json, getConfig(), or README fails at least one of the checks below.
const DOCUMENTED: Record<string, NumericContract> = {
    defaultPort: { default: 3000, minimum: 1, maximum: 65535 },
    updateInterval: { default: 5000, minimum: 1000, maximum: 60000 },
    gracefulShutdownTimeout: { default: 5000, minimum: 1000, maximum: 30000 },
    autoKillTimeout: { default: 0, minimum: 0 },
    autoKillIdleTime: { default: 0, minimum: 0 },
    maxExtraServers: { default: 0, minimum: 0 },
};

const SECTION_PREFIX = 'nuxt-dev-server.';
const properties = packageJson.contributes.configuration.properties as Record<string, SchemaProperty>;
const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');

function shortName(key: string): string {
    if (!key.startsWith(SECTION_PREFIX)) {
        throw new Error(`Setting ${key} does not use the ${SECTION_PREFIX} section prefix`);
    }
    return key.slice(SECTION_PREFIX.length);
}

function numericProperties(): Array<{ name: string; schema: SchemaProperty }> {
    return Object.entries(properties)
        .filter(([, schema]) => schema.type === 'number')
        .map(([key, schema]) => ({ name: shortName(key), schema }));
}

function getConfigWith(values: Record<string, unknown>): Record<string, unknown> {
    mockSettings = values;
    return getConfig() as unknown as Record<string, unknown>;
}

afterEach(() => {
    mockSettings = {};
});

function readmeBlock(name: string): string {
    const token = `- **\`${SECTION_PREFIX}${name}\`**`;
    const start = readme.indexOf(token);
    if (start === -1) {
        throw new Error(`README does not document ${SECTION_PREFIX}${name}`);
    }
    const rest = readme.slice(start);
    // Block runs until the next setting bullet or the next section heading.
    const boundary = rest.slice(1).search(/\n- \*\*`|\n#{2,3} /);
    return boundary === -1 ? rest : rest.slice(0, boundary + 1);
}

describe('settings schema matches the documented numeric contract', () => {
    const numeric = numericProperties();

    it('contributes exactly the documented numeric settings with matching default/minimum/maximum', () => {
        expect(numeric.map(({ name }) => name).sort()).toEqual(Object.keys(DOCUMENTED).sort());
        for (const { name, schema } of numeric) {
            const doc = DOCUMENTED[name];
            expect(schema.default, `${name} default`).toBe(doc.default);
            expect(schema.minimum, `${name} minimum`).toBe(doc.minimum);
            expect(schema.maximum, `${name} maximum`).toBe(doc.maximum);
        }
    });

    it('every contributed setting uses the nuxt-dev-server. section prefix', () => {
        for (const key of Object.keys(properties)) {
            expect(key.startsWith(SECTION_PREFIX)).toBe(true);
        }
    });
});

describe('getConfig() honors the contributed schema', () => {
    it('returns the schema default for every setting when nothing is configured', () => {
        const config = getConfigWith({});
        for (const [key, schema] of Object.entries(properties)) {
            expect(config[shortName(key)], `${key} default`).toBe(schema.default);
        }
    });

    it('clamps each numeric setting to its schema minimum and maximum', () => {
        for (const { name, schema } of numericProperties()) {
            if (schema.minimum !== undefined) {
                expect(getConfigWith({ [name]: schema.minimum - 1 })[name], `${name} below min`).toBe(schema.minimum);
            }
            if (schema.maximum !== undefined) {
                expect(getConfigWith({ [name]: schema.maximum + 1 })[name], `${name} above max`).toBe(schema.maximum);
            } else {
                // Schema documents no upper bound (0 = unlimited/disabled semantics).
                expect(getConfigWith({ [name]: 9999999 })[name], `${name} unbounded above`).toBe(9999999);
            }
        }
    });

    it('clamps the documented out-of-range examples to the documented bounds', () => {
        const config = getConfigWith({
            defaultPort: 0,
            updateInterval: 10,
            gracefulShutdownTimeout: 99999,
        });
        expect(config.defaultPort).toBe(DOCUMENTED.defaultPort.minimum);
        expect(config.updateInterval).toBe(DOCUMENTED.updateInterval.minimum);
        expect(config.gracefulShutdownTimeout).toBe(DOCUMENTED.gracefulShutdownTimeout.maximum);

        const upperPort = getConfigWith({ defaultPort: 70000 });
        expect(upperPort.defaultPort).toBe(DOCUMENTED.defaultPort.maximum);
    });

    it('falls back to the schema default for non-finite numeric values', () => {
        for (const { name, schema } of numericProperties()) {
            expect(getConfigWith({ [name]: Number.NaN })[name], `${name} NaN fallback`).toBe(schema.default);
        }
    });
});

describe('README Extension Settings matches the contributed schema', () => {
    it('documents every contributed setting with the schema default', () => {
        const readmeDefaults = new Map<string, string>();
        for (const match of readme.matchAll(/^- \*\*`(nuxt-dev-server\.[A-Za-z]+)`\*\* \(default: `([^`]*)`\)$/gm)) {
            readmeDefaults.set(match[1].slice(SECTION_PREFIX.length), match[2]);
        }
        const schemaNames = Object.keys(properties).map(shortName).sort();
        expect([...readmeDefaults.keys()].sort()).toEqual(schemaNames);
        for (const [name, documented] of readmeDefaults) {
            expect(documented.replace(/^"|"$/g, ''), `${name} README default`).toBe(
                String(properties[SECTION_PREFIX + name].default),
            );
        }
    });

    it('Min/Max lines agree with the schema minimum/maximum', () => {
        for (const { name, schema } of numericProperties()) {
            const block = readmeBlock(name);
            const min = block.match(/Min:\s*(\d+)/);
            const max = block.match(/Max:\s*(\d+)/);
            if (min) {
                expect(Number(min[1]), `${name} README Min`).toBe(schema.minimum);
            }
            // Every schema maximum must be documented; no README Max may
            // exist for settings the schema leaves unbounded.
            if (schema.maximum !== undefined) {
                expect(max, `${name} README Max missing`).not.toBeNull();
                expect(Number(max![1]), `${name} README Max`).toBe(schema.maximum);
            } else {
                expect(max, `${name} README documents Max but schema has none`).toBeNull();
            }
        }
    });
});

describe('devCommand contract', () => {
    it('getConfig() passes devCommand through unmodified', () => {
        expect(getConfigWith({ devCommand: 'dev:custom' }).devCommand).toBe('dev:custom');
    });

    it('README documents the charset and length limit enforced by isValidDevCommand', () => {
        const block = readmeBlock('devCommand');
        expect(block).toMatch(/Only alphanumeric characters, dashes, underscores, and colons are allowed/);
        expect(block).toMatch(/shorter than 100 characters/);
    });

    it('isValidDevCommand enforces exactly the documented charset and length', () => {
        expect(isValidDevCommand('dev')).toBe(true);
        expect(isValidDevCommand('dev:custom')).toBe(true);
        expect(isValidDevCommand('dev_build-2:v1')).toBe(true);
        expect(isValidDevCommand('x'.repeat(99))).toBe(true);

        expect(isValidDevCommand('')).toBe(false);
        expect(isValidDevCommand('x'.repeat(100))).toBe(false);
        expect(isValidDevCommand('dev; rm -rf /')).toBe(false);
        expect(isValidDevCommand('dev cmd')).toBe(false);
        expect(isValidDevCommand('dev&&echo')).toBe(false);
        expect(isValidDevCommand('dev.js')).toBe(false);
    });
});
