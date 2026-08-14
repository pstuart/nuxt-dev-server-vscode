import { describe, it, expect, beforeEach } from 'vitest';
import {
    isValidPid,
    isValidPort,
    parsePid,
    parsePort,
    clampPort,
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
    });

    describe('isPidNumber type guard', () => {
        it('should narrow valid PID numbers', () => {
            const value: unknown = 123;
            if (isPidNumber(value)) {
                expect(value).toBeTypeOf('number');
                expect(value).toBe(123);
            }
        });

        it('should reject invalid PIDs', () => {
            expect(isPidNumber(0)).toBe(false);
            expect(isPidNumber(-1)).toBe(false);
            expect(isPidNumber(1.5)).toBe(false);
            expect(isPidNumber('123')).toBe(false);
        });
    });

    describe('isPortNumber type guard', () => {
        it('should narrow valid port numbers', () => {
            const value: unknown = 8080;
            if (isPortNumber(value)) {
                expect(value).toBeTypeOf('number');
                expect(value).toBe(8080);
            }
        });

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
