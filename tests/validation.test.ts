import { describe, it, expect } from 'vitest';
import {
    isValidPid,
    isValidPort,
    parsePid,
    parsePort,
    clampPort,
    clampNumber,
    isPidNumber,
    isPortNumber
} from '../src/validation';

describe('validation', () => {
    describe('isValidPid', () => {
        it('should return true for valid positive integer PIDs', () => {
            expect(isValidPid(1)).toBe(true);
            expect(isValidPid(123)).toBe(true);
            expect(isValidPid(999999)).toBe(true);
        });

        it('should return false for invalid PIDs', () => {
            expect(isValidPid(0)).toBe(false);
            expect(isValidPid(-1)).toBe(false);
            expect(isValidPid(-123)).toBe(false);
            expect(isValidPid(1.5)).toBe(false);
            expect(isValidPid(NaN)).toBe(false);
            expect(isValidPid(Infinity)).toBe(false);
        });

        it('should return false for non-numeric values', () => {
            expect(isValidPid('123' as unknown as number)).toBe(false);
            expect(isValidPid(null as unknown as number)).toBe(false);
            expect(isValidPid(undefined as unknown as number)).toBe(false);
        });
    });

    describe('isValidPort', () => {
        it('should return true for valid TCP ports', () => {
            expect(isValidPort(1)).toBe(true);
            expect(isValidPort(80)).toBe(true);
            expect(isValidPort(443)).toBe(true);
            expect(isValidPort(8080)).toBe(true);
            expect(isValidPort(65535)).toBe(true);
        });

        it('should return false for invalid port numbers', () => {
            expect(isValidPort(0)).toBe(false);
            expect(isValidPort(-1)).toBe(false);
            expect(isValidPort(-8080)).toBe(false);
            expect(isValidPort(65536)).toBe(false);
            expect(isValidPort(99999)).toBe(false);
            expect(isValidPort(1.5)).toBe(false);
            expect(isValidPort(NaN)).toBe(false);
            expect(isValidPort(Infinity)).toBe(false);
        });
    });

    describe('parsePid', () => {
        it('should parse valid PID strings to numbers', () => {
            expect(parsePid('123')).toBe(123);
            expect(parsePid('1')).toBe(1);
            expect(parsePid('999999')).toBe(999999);
        });

        it('should throw error for invalid PID strings', () => {
            expect(() => parsePid('')).toThrow('Invalid PID value');
            expect(() => parsePid('abc')).toThrow('Invalid PID value');
            expect(() => parsePid('-1')).toThrow('Invalid PID value');
            expect(() => parsePid('0')).toThrow('Invalid PID value');
            expect(() => parsePid('1.5')).toThrow('Invalid PID value');
            expect(() => parsePid('123abc')).toThrow('Invalid PID value');
            // Whitespace around valid numbers should be accepted after trimming
            expect(parsePid(' 123 ')).toBe(123);
        });

        it('should throw error for non-string values', () => {
            expect(() => parsePid(null as unknown as string)).toThrow();
            expect(() => parsePid(undefined as unknown as string)).toThrow();
        });
    });

    describe('parsePort', () => {
        it('should parse valid port strings to numbers', () => {
            expect(parsePort('8080')).toBe(8080);
            expect(parsePort('1')).toBe(1);
            expect(parsePort('65535')).toBe(65535);
        });

        it('should throw error for invalid port strings', () => {
            expect(() => parsePort('')).toThrow('Invalid port value');
            expect(() => parsePort('abc')).toThrow('Invalid port value');
            expect(() => parsePort('-1')).toThrow('Invalid port value');
            expect(() => parsePort('0')).toThrow('Invalid port value');
            expect(() => parsePort('65536')).toThrow('Invalid port value');
            expect(() => parsePort('1.5')).toThrow('Invalid port value');
            expect(() => parsePort('123abc')).toThrow('Invalid port value');
            // Whitespace around valid ports should be accepted after trimming
            expect(parsePort(' 8080 ')).toBe(8080);
        });

        it('should throw error for non-string values', () => {
            expect(() => parsePort(null as unknown as string)).toThrow();
            expect(() => parsePort(undefined as unknown as string)).toThrow();
        });
    });

    describe('clampPort', () => {
        it('should clamp values to valid port range', () => {
            expect(clampPort(0)).toBe(1);
            expect(clampPort(1)).toBe(1);
            expect(clampPort(8080)).toBe(8080);
            expect(clampPort(65535)).toBe(65535);
            expect(clampPort(65536)).toBe(65535);
        });

        it('should return null for invalid inputs', () => {
            expect(clampPort(NaN)).toBeNull();
            expect(clampPort(Infinity)).toBeNull();
            expect(clampPort(-Infinity)).toBeNull();
            expect(clampPort(undefined as unknown as number)).toBeNull();
        });

        it('should floor fractional values toward the lower bound', () => {
            expect(clampPort(8080.9)).toBe(8080);
            expect(clampPort(0.9)).toBe(1);
            expect(clampPort(-0.5)).toBe(1);
            expect(clampPort(65535.9)).toBe(65535);
        });
    });

    describe('clampNumber', () => {
        it('should clamp finite values into the requested range', () => {
            expect(clampNumber(5, 1, 10)).toBe(5);
            expect(clampNumber(0, 1, 10)).toBe(1);
            expect(clampNumber(42, 1, 10)).toBe(10);
            expect(clampNumber(-3, 0, 100)).toBe(0);
        });

        it('should return null for non-finite inputs', () => {
            expect(clampNumber(NaN, 1, 10)).toBeNull();
            expect(clampNumber(Infinity, 1, 10)).toBeNull();
            expect(clampNumber(-Infinity, 1, 10)).toBeNull();
        });

        it('should floor fractional values before clamping', () => {
            expect(clampNumber(9.9, 1, 10)).toBe(9);
            expect(clampNumber(0.1, 1, 10)).toBe(1);
            expect(clampNumber(10.1, 1, 10)).toBe(10);
        });

        it('agrees with clampPort for every finite input', () => {
            const cases = [-1, 0, 0.5, 1, 80, 8080, 65534, 65535, 65536, 1e9];
            for (const value of cases) {
                expect(clampNumber(value, 1, 65535)).toBe(clampPort(value));
            }
        });

        it('supports the config-clamp contract: fallback on non-finite values', () => {
            const fallback = 3000;
            const fromShared = (value: number): number => clampNumber(value, 1, 65535) ?? fallback;
            const legacy = (value: number): number =>
                Number.isFinite(value) ? Math.min(65535, Math.max(1, value)) : fallback;
            for (const value of [NaN, Infinity, -Infinity, 0, 1, 3000, 65535, 65536]) {
                expect(fromShared(value)).toBe(legacy(value));
            }
        });
    });

    describe('isPidNumber type guard', () => {
        it('should reject invalid PIDs', () => {
            expect(isPidNumber(0)).toBe(false);
            expect(isPidNumber(-1)).toBe(false);
            expect(isPidNumber(1.5)).toBe(false);
            expect(isPidNumber('123')).toBe(false);
        });
    });

    describe('isPortNumber type guard', () => {
        it('should reject invalid ports', () => {
            expect(isPortNumber(0)).toBe(false);
            expect(isPortNumber(-1)).toBe(false);
            expect(isPortNumber(65536)).toBe(false);
            expect(isPortNumber(1.5)).toBe(false);
            expect(isPortNumber('8080')).toBe(false);
        });
    });

    describe('validation edge cases', () => {
        it('should handle boundary port values correctly', () => {
            expect(isValidPort(1)).toBe(true);
            expect(isValidPort(65535)).toBe(true);
            expect(isValidPort(2)).toBe(true);
            expect(isValidPort(65534)).toBe(true);
        });

        it('should handle edge cases for parse functions', () => {
            // Whitespace around valid numbers should be accepted after trimming
            expect(parsePid(' 123 ')).toBe(123);
            expect(parsePort(' 8080 ')).toBe(8080);
        });
    });
});
