import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    showInfo: vi.fn(),
    onServerStart: vi.fn(),
    openExternal: vi.fn(),
    executeCommand: vi.fn(),
    spawn: vi.fn(),
    browserType: 'external',
}));

vi.mock('vscode', () => ({
    workspace: { workspaceFolders: [{ uri: { fsPath: '/fixture' } }] },
    env: { openExternal: mocks.openExternal },
    commands: { executeCommand: mocks.executeCommand },
    Uri: { parse: (url: string) => url },
}));
vi.mock('child_process', () => ({ spawn: mocks.spawn }));
vi.mock('../src/utils', () => ({
    getConfig: () => ({
        defaultPort: 3000,
        preferredPackageManager: 'npm',
        devCommand: 'dev',
        openBrowserOnStart: true,
        browserType: mocks.browserType,
    }),
    fileExists: async () => true,
    getOrCreateOutputChannel: () => ({ clear() {}, show() {}, append() {}, appendLine() {} }),
    showInfo: mocks.showInfo,
    showError: vi.fn(), showWarning: vi.fn(), debugLog: vi.fn(), getErrorMessage: String, sleep: vi.fn(),
    // Mirrors src/utils.ts: embedded routes through Simple Browser, anything else
    // through openExternal. The embedded test below flips mocks.browserType and
    // asserts the destination actually changes.
    openServerUrl: (url: string) => mocks.browserType === 'embedded'
        ? mocks.executeCommand('simpleBrowser.show', url)
        : mocks.openExternal(url),
}));
vi.mock('../src/processManager', () => ({
    waitForProcessTreePort: async () => 3000,
    killProcessTree: vi.fn(), killProcessesByWorkingDir: vi.fn(), verifyProcessTerminated: vi.fn(),
}));
vi.mock('../src/autoKill', () => ({ onServerStart: mocks.onServerStart, onServerStop: vi.fn() }));
vi.mock('../src/statusBar', () => ({ forceStatusBarUpdate: vi.fn() }));
vi.mock('../src/platform', () => ({ isBinaryAvailable: async () => true }));
vi.mock('../src/workspaceTrust', () => ({ refuseIfUntrusted: async () => false }));

describe('server startup', () => {
    let child: EventEmitter & {
        pid: number; exitCode: number | null; signalCode: string | null; killed: boolean;
        stdout: EventEmitter; stderr: EventEmitter;
    };

    beforeEach(async () => {
        mocks.spawn.mockReset();
        mocks.openExternal.mockReset();
        mocks.executeCommand.mockReset();
        mocks.onServerStart.mockReset();
        mocks.showInfo.mockReset();
        mocks.browserType = 'external';
        child = Object.assign(new EventEmitter(), {
            pid: 123, exitCode: null, signalCode: null, killed: false,
            stdout: new EventEmitter(), stderr: new EventEmitter(),
        });
        mocks.spawn.mockReturnValue(child);
        mocks.showInfo.mockImplementation((message: string) => message.includes('started on port')
            ? new Promise(() => {})
            : Promise.resolve(undefined));
        // Managed-server state lives in the module; drop it between cases.
        const { clearManagedServer } = await import('../src/devServer');
        clearManagedServer();
    });

    it('finishes, opens the browser, and arms auto-kill while the started notification stays open', async () => {
        const { startDevServer, clearManagedServer } = await import('../src/devServer');
        try {
            expect(await startDevServer()).toBe(true);
            expect(mocks.showInfo).toHaveBeenCalledWith('Nuxt dev server started on port 3000');
            expect(mocks.openExternal).toHaveBeenCalledExactlyOnceWith('http://localhost:3000');
            expect(mocks.executeCommand).not.toHaveBeenCalled();
            expect(mocks.onServerStart).toHaveBeenCalledTimes(1);
            child.stdout.emit('data', Buffer.from('http://localhost:3000'));
            expect(mocks.openExternal).toHaveBeenCalledTimes(1);
            expect(mocks.showInfo.mock.calls.filter(([message]) => message.includes('started on port'))).toHaveLength(1);
        } finally {
            clearManagedServer();
        }
    }, 1000);

    it('opens the Simple Browser instead of the external browser when browserType is embedded', async () => {
        mocks.browserType = 'embedded';
        const { startDevServer, clearManagedServer } = await import('../src/devServer');
        try {
            expect(await startDevServer()).toBe(true);
            expect(mocks.executeCommand).toHaveBeenCalledExactlyOnceWith('simpleBrowser.show', 'http://localhost:3000');
            expect(mocks.openExternal).not.toHaveBeenCalled();
            expect(mocks.onServerStart).toHaveBeenCalledTimes(1);
            child.stdout.emit('data', Buffer.from('http://localhost:3000'));
            expect(mocks.executeCommand).toHaveBeenCalledTimes(1);
        } finally {
            clearManagedServer();
        }
    }, 1000);
});
