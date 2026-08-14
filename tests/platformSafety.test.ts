import { readFileSync } from 'fs';
import { resolve } from 'path';
import { describe, expect, it } from 'vitest';
import { isSafeBinaryName } from '../src/processLogic';

const platformSource = readFileSync(resolve(__dirname, '../src/platform.ts'), 'utf8');

describe('platform process helpers stay on execFile + argv', () => {
    it('does not spawn a shell via exec, execSync, or spawn(..., { shell: true })', () => {
        expect(platformSource).toMatch(/from 'child_process'/);
        expect(platformSource).toMatch(/execFile/);
        expect(platformSource).not.toMatch(/\bexecSync\b/);
        expect(platformSource).not.toMatch(/spawn\(/);
        expect(platformSource).not.toMatch(/shell:\s*true/);
        expect(platformSource).not.toMatch(/import\s*\{[^}]*\bexec\b[^}]*\}\s*from\s*'child_process'/);
    });

    it('rejects binary names that could be interpolated as a shell payload', () => {
        expect(isSafeBinaryName('npm; rm -rf /')).toBe(false);
        expect(isSafeBinaryName('npm && id')).toBe(false);
        expect(isSafeBinaryName('../npm')).toBe(false);
        expect(isSafeBinaryName('')).toBe(false);
        expect(isSafeBinaryName('npm')).toBe(true);
        expect(isSafeBinaryName('pnpm')).toBe(true);
    });
});
