import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    commands: new Map<string, () => Promise<unknown>>(),
    openServerUrl: vi.fn(),
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
}));

import { activate } from '../src/extension';
import { COMMANDS } from '../src/constants';
import type { ExtensionContext } from 'vscode';

describe('Open in Browser command URL', () => {
    it('uses settings for unmanaged discovery but never rebuilds a managed printed URL', async () => {
        activate({ subscriptions: [] } as unknown as ExtensionContext);
        const open = mocks.commands.get(COMMANDS.OPEN_BROWSER)!;
        await open();
        expect(mocks.openServerUrl).toHaveBeenLastCalledWith('https://[::1]:4444');
        mocks.managed = { url: 'https://dev.local:5555/app/' };
        await open();
        expect(mocks.openServerUrl).toHaveBeenLastCalledWith('https://dev.local:5555/app/');
        expect(mocks.openServerUrl).toHaveBeenCalledTimes(2);
    });
});
