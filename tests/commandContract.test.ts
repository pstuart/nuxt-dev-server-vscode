import { readFileSync } from 'fs';
import { describe, expect, it } from 'vitest';
import { COMMANDS } from '../src/constants';
import packageJson from '../package.json';

// Public command surface contract. The command IDs are the extension's
// externally visible API: users bind them in keybindings, other extensions
// invoke them via vscode.commands.executeCommand, and the Command Palette
// shows the contributed titles. Pin the three surfaces that must agree —
// src/constants.ts COMMANDS, package.json contributes.commands and the
// registerCommand calls in src/extension.ts — plus the README documentation.
// extension.ts cannot be imported here (it needs the vscode runtime), so its
// registration calls are read textually, as tests/platformSafety.test.ts does.

interface ContributedCommand {
    command: string;
    title?: string;
}

const extensionSource = readFileSync(new URL('../src/extension.ts', import.meta.url), 'utf8');
const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
const contributed = packageJson.contributes.commands as ContributedCommand[];

const constantCommandIds: string[] = Object.values(COMMANDS).sort();
const contributedCommandIds: string[] = contributed.map(({ command }) => command).sort();

/** COMMANDS keys registered through vscode.commands.registerCommand. */
function registeredConstantKeys(): string[] {
    return [...extensionSource.matchAll(/vscode\.commands\.registerCommand\(\s*COMMANDS\.([A-Z0-9_]+)/g)]
        .map((match) => match[1])
        .sort();
}

/** Command IDs registered through vscode.commands.registerCommand. */
function registeredCommandIds(): string[] {
    return [...extensionSource.matchAll(/vscode\.commands\.registerCommand\(\s*['"]([^'"]+)['"]/g)]
        .map((match) => match[1])
        .sort();
}

/** README command bullets: "- **Nuxt: <Title>** - <description>". */
function readmeCommandTitles(): string[] {
    return [...readme.matchAll(/^- \*\*(Nuxt: [^*]+)\*\* - /gm)].map((match) => match[1]).sort();
}

describe('COMMANDS matches the contributed command manifest', () => {
    it('contributes every COMMANDS value in package.json', () => {
        expect(contributedCommandIds).toEqual(constantCommandIds);
    });

    it('contributes no command that is absent from COMMANDS', () => {
        const unknown = contributedCommandIds.filter((id) => !constantCommandIds.includes(id));
        expect(unknown).toEqual([]);
    });

    it('every contributed command uses the nuxt-dev-server. prefix', () => {
        for (const { command } of contributed) {
            expect(command.startsWith('nuxt-dev-server.'), `${command} prefix`).toBe(true);
        }
    });
});

describe('COMMANDS is registered in extension activation', () => {
    it('registers every COMMANDS key via vscode.commands.registerCommand', () => {
        expect(registeredConstantKeys()).toEqual(Object.keys(COMMANDS).sort());
    });

    it('registers no command ID literal that is absent from COMMANDS', () => {
        const literalIds = registeredCommandIds();
        expect(literalIds.filter((id) => !constantCommandIds.includes(id))).toEqual([]);
    });

    it('registers no command that is missing from package.json contributes.commands', () => {
        const registered = [...new Set([...registeredCommandIds(), ...constantCommandIds])].sort();
        expect(registered).toEqual(contributedCommandIds);
    });
});

describe('README Commands section documents the contributed titles', () => {
    it('documents every contributed command title', () => {
        const contributedTitles = contributed.map(({ title }) => title as string).sort();
        expect(readmeCommandTitles()).toEqual(contributedTitles);
    });

    it('documents no title that is not contributed in package.json', () => {
        const contributedTitles = contributed.map(({ title }) => title as string);
        const undocumented = readmeCommandTitles().filter((title) => !contributedTitles.includes(title));
        expect(undocumented).toEqual([]);
    });
});
