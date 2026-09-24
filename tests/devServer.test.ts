import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    showInfo: vi.fn(),
    onServerStart: vi.fn(),
    openExternal: vi.fn(),
    spawn: vi.fn(),
}));

vi.mock('vscode', () => ({
    workspace: { workspaceFolders: [{ uri: { fsPath: '/fixture' } }] },
    env: { openExternal: mocks.openExternal },
    Uri: { parse: (url: string) => url },
}));
vi.mock('child_process', () => ({ spawn: mocks.spawn }));
vi.mock('../src/utils', () => ({
    getConfig: () => ({ defaultPort: 3000, preferredPackageManager: 'npm', devCommand: 'dev', openBrowserOnStart: true }),
    fileExists: async () => true,
    getOrCreateOutputChannel: () => ({ clear() {}, show() {}, append() {}, appendLine() {} }),
    showInfo: mocks.showInfo,
    showError: vi.fn(), showWarning: vi.fn(), debugLog: vi.fn(), getErrorMessage: String, sleep: vi.fn(),
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
    it('finishes, opens the browser, and arms auto-kill while the started notification stays open', async () => {
        const child = Object.assign(new EventEmitter(), {
            pid: 123, exitCode: null, signalCode: null, killed: false,
            stdout: new EventEmitter(), stderr: new EventEmitter(),
        });
        mocks.spawn.mockReturnValue(child);
        mocks.showInfo.mockImplementation((message: string) => message.includes('started on port')
            ? new Promise(() => {})
            : Promise.resolve(undefined));
        const { startDevServer, clearManagedServer } = await import('../src/devServer');
        try {
            expect(await startDevServer()).toBe(true);
            expect(mocks.showInfo).toHaveBeenCalledWith('Nuxt dev server started on port 3000');
            expect(mocks.openExternal).toHaveBeenCalledExactlyOnceWith('http://localhost:3000');
            expect(mocks.onServerStart).toHaveBeenCalledTimes(1);
            child.stdout.emit('data', Buffer.from('http://localhost:3000'));
            expect(mocks.openExternal).toHaveBeenCalledTimes(1);
            expect(mocks.showInfo.mock.calls.filter(([message]) => message.includes('started on port'))).toHaveLength(1);
        } finally {
            clearManagedServer();
        }
    }, 1000);
});
