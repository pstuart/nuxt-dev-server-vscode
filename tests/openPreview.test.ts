import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    commands: new Map<string, () => Promise<unknown>>(),
    openServerUrl: vi.fn(),
    openServerUrlAs: vi.fn(),
    managed: null as { url: string } | null,
}));
vi.mock('vscode', () => ({
    commands: { registerCommand: (id: string, handler: () => Promise<unknown>) => {
        mocks.commands.set(id, handler);
        return { dispose: vi.fn() };
    } },
}));
vi.mock('../src/devServer', () => ({
    getManagedServer: () => mocks.managed,
    startPreviewServer: vi.fn(), runProductionScript: vi.fn(), startDevServer: vi.fn(), startDevServerWithDebugger: vi.fn(), stopDevServer: vi.fn(), restartDevServer: vi.fn(),
}));
vi.mock('../src/statusBar', () => ({ initializeStatusBar: vi.fn() }));
vi.mock('../src/autoKill', () => ({ initializeAutoKill: vi.fn() }));
vi.mock('../src/versionDetector', () => ({ showNuxtVersion: vi.fn() }));
vi.mock('../src/processManager', () => ({
    getRunningNuxtProcesses: async () => [{ port: '4444' }],
}));
vi.mock('../src/utils', () => ({
    debugLog: vi.fn(), showError: vi.fn(),
    getConfig: () => ({ port: 4443, host: '::1', https: true, autoStartOnOpen: false }),
    openServerUrl: mocks.openServerUrl,
    openServerUrlAs: mocks.openServerUrlAs,
}));

import { activate } from '../src/extension';
import { COMMANDS } from '../src/constants';
import type { ExtensionContext } from 'vscode';

// Issue #107: an in-editor preview that works whatever browserType is set to.
describe('Open Preview in Editor command', () => {
    it('routes the managed server URL to the embedded destination', async () => {
        activate({ subscriptions: [] } as unknown as ExtensionContext);
        const openPreview = mocks.commands.get(COMMANDS.OPEN_PREVIEW)!;
        mocks.managed = { url: 'https://dev.local:5555/app/' };
        await openPreview();
        expect(mocks.openServerUrlAs).toHaveBeenLastCalledWith('https://dev.local:5555/app/', true);
    });

    it('falls back to discovered processes and still uses the embedded destination', async () => {
        activate({ subscriptions: [] } as unknown as ExtensionContext);
        const openPreview = mocks.commands.get(COMMANDS.OPEN_PREVIEW)!;
        mocks.managed = null;
        await openPreview();
        // The getConfig mock pins https/heart, so the fallback URL is built from them.
        expect(mocks.openServerUrlAs).toHaveBeenLastCalledWith('https://[::1]:4444', true);
    });
});
