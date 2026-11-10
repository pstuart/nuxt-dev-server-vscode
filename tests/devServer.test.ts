import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    showInfo: vi.fn(),
    showWarning: vi.fn(),
    onServerStart: vi.fn(),
    openExternal: vi.fn(),
    executeCommand: vi.fn(),
    spawn: vi.fn(),
    killProcessesByWorkingDir: vi.fn(),
    outputChannel: { clear: vi.fn(), show: vi.fn(), append: vi.fn(), appendLine: vi.fn() },
    browserType: 'external',
    showNotifications: true,
}));

vi.mock('vscode', () => ({
    workspace: { workspaceFolders: [{ uri: { fsPath: '/fixture' } }] },
    env: { openExternal: mocks.openExternal },
    commands: { executeCommand: mocks.executeCommand },
    window: { showWarningMessage: mocks.showWarning },
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
        showNotifications: mocks.showNotifications,
    }),
    fileExists: async () => true,
    getOrCreateOutputChannel: () => mocks.outputChannel,
    showInfo: mocks.showInfo,
    // Mirrors src/utils.ts: warnings (and their actions) only surface when
    // showNotifications is enabled; otherwise the resolved value is undefined.
    showWarning: (message: string, ...actions: string[]) => mocks.showNotifications
        ? mocks.showWarning(message, ...actions)
        : Promise.resolve(undefined),
    showError: vi.fn(), debugLog: vi.fn(), getErrorMessage: String, sleep: vi.fn(),
    // Mirrors src/utils.ts: embedded routes through Simple Browser, anything else
    // through openExternal. The embedded test below flips mocks.browserType and
    // asserts the destination actually changes.
    openServerUrl: (url: string) => mocks.browserType === 'embedded'
        ? mocks.executeCommand('simpleBrowser.show', url)
        : mocks.openExternal(url),
}));
vi.mock('../src/processManager', () => ({
    waitForProcessTreePort: async () => 3000,
    killProcessTree: vi.fn(),
    killProcessesByWorkingDir: mocks.killProcessesByWorkingDir,
    verifyProcessTerminated: async () => true,
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
        mocks.showWarning.mockReset();
        mocks.killProcessesByWorkingDir.mockReset();
        for (const fn of Object.values(mocks.outputChannel)) {
            (fn as ReturnType<typeof vi.fn>).mockReset();
        }
        mocks.browserType = 'external';
        mocks.showNotifications = true;
        child = Object.assign(new EventEmitter(), {
            pid: 123, exitCode: null, signalCode: null, killed: false,
            stdout: new EventEmitter(), stderr: new EventEmitter(),
        });
        mocks.spawn.mockReturnValue(child);
        mocks.killProcessesByWorkingDir.mockResolvedValue(1);
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

    it('routes the detected server URL to the embedded Simple Browser once when openBrowserOnStart is enabled', async () => {
        // openBrowserOnStart is true in the shared getConfig mock; only browserType flips.
        mocks.browserType = 'embedded';
        const { startDevServer, clearManagedServer } = await import('../src/devServer');
        try {
            expect(await startDevServer()).toBe(true);
            // Port detection happened inside startDevServer (waitForProcessTreePort mock
            // resolves 3000), so the embedded branch fired exactly once with that URL.
            expect(mocks.executeCommand).toHaveBeenCalledExactlyOnceWith(
                'simpleBrowser.show', 'http://localhost:3000');
            expect(mocks.openExternal).not.toHaveBeenCalled();
            // The later stdout chunk must not re-open the preview.
            child.stdout.emit('data', Buffer.from('http://localhost:3000'));
            expect(mocks.executeCommand).toHaveBeenCalledTimes(1);
        } finally {
            clearManagedServer();
        }
    }, 1000);

    it('routes the detected server URL to the external browser when browserType stays at its default', async () => {
        // mocks.browserType is reset to 'external' in beforeEach — the default branch.
        const { startDevServer, clearManagedServer } = await import('../src/devServer');
        try {
            expect(await startDevServer()).toBe(true);
            expect(mocks.openExternal).toHaveBeenCalledExactlyOnceWith('http://localhost:3000');
            expect(mocks.executeCommand).not.toHaveBeenCalled();
            // The later stdout chunk must not re-open the browser.
            child.stdout.emit('data', Buffer.from('http://localhost:3000'));
            expect(mocks.openExternal).toHaveBeenCalledTimes(1);
        } finally {
            clearManagedServer();
        }
    }, 1000);

    it('warns once with the exit code plus Restart and Show Output when the child dies outside our control', async () => {
        const { startDevServer, clearManagedServer } = await import('../src/devServer');
        mocks.showWarning.mockResolvedValue(undefined);
        try {
            expect(await startDevServer()).toBe(true);
            // An outside terminal kill fires both 'exit' and 'close' on the handle.
            child.emit('exit', 42, null);
            child.emit('close', 42, null);
            await Promise.resolve();
            expect(mocks.showWarning).toHaveBeenCalledExactlyOnceWith(
                'Nuxt dev server exited unexpectedly (code 42)', 'Restart', 'Show Output');
        } finally {
            clearManagedServer();
        }
    }, 1000);

    it('restarts the managed server when the Restart action is chosen', async () => {
        const { startDevServer, clearManagedServer, getManagedServer } = await import('../src/devServer');
        mocks.showWarning.mockResolvedValue('Restart');
        try {
            expect(await startDevServer()).toBe(true);
            child.emit('close', 1, null);
            // Drain the microtask queue (flush) so the showWarning then-chain and the
            // restarted startDevServer() pre-flight both settle.
            await vi.waitFor(() => {
                expect(mocks.spawn).toHaveBeenCalledTimes(2);
            });
            expect(mocks.showWarning).toHaveBeenCalledExactlyOnceWith(
                'Nuxt dev server exited unexpectedly (code 1)', 'Restart', 'Show Output');
            // Restart routed back into startDevServer: a second spawn happened.
            expect(mocks.spawn).toHaveBeenCalledTimes(2);
            expect(getManagedServer()).not.toBeNull();
        } finally {
            clearManagedServer();
        }
    }, 1000);

    it('reveals the Nuxt Dev Server output channel when Show Output is chosen', async () => {
        const { startDevServer, clearManagedServer } = await import('../src/devServer');
        mocks.showWarning.mockResolvedValue('Show Output');
        try {
            expect(await startDevServer()).toBe(true);
            child.emit('close', 3, null);
            await Promise.resolve();
            expect(mocks.showWarning).toHaveBeenCalledExactlyOnceWith(
                'Nuxt dev server exited unexpectedly (code 3)', 'Restart', 'Show Output');
            // One reveal from startup plus one from the Show Output action.
            expect(mocks.outputChannel.show).toHaveBeenCalledTimes(2);
            expect(mocks.spawn).toHaveBeenCalledTimes(1);
        } finally {
            clearManagedServer();
        }
    }, 1000);

    it('stays silent for planned stops and restarts of the managed server', async () => {
        const { startDevServer, stopDevServer, restartDevServer, clearManagedServer } = await import('../src/devServer');
        mocks.showWarning.mockResolvedValue(undefined);
        try {
            expect(await startDevServer()).toBe(true);
            // stopDevServer() kills the child, so the real handle settles here.
            expect(await stopDevServer()).toBe(true);
            // Second managed instance, then the restart path tears it down itself.
            expect(await startDevServer()).toBe(true);
            expect(await restartDevServer()).toBe(true);
            const unexpected = mocks.showWarning.mock.calls.filter(
                ([message]) => String(message).includes('exited unexpectedly'));
            expect(unexpected).toHaveLength(0);
        } finally {
            clearManagedServer();
        }
    }, 1000);

    it('stays silent when an auto-killed server process reports its exit', async () => {
        const { startDevServer, stopDevServer, clearManagedServer } = await import('../src/devServer');
        mocks.showWarning.mockResolvedValue(undefined);
        try {
            expect(await startDevServer()).toBe(true);
            // src/autoKill.ts funnels timeout/idle kills through stopDevServer().
            expect(await stopDevServer()).toBe(true);
            // The auto-killed handle reports its death after the planned teardown.
            child.emit('exit', null, 'SIGTERM');
            child.emit('close', null, 'SIGTERM');
            await Promise.resolve();
            const unexpected = mocks.showWarning.mock.calls.filter(
                ([message]) => String(message).includes('exited unexpectedly'));
            expect(unexpected).toHaveLength(0);
        } finally {
            clearManagedServer();
        }
    }, 1000);

    it('shows no unexpected-exit warning when showNotifications is disabled', async () => {
        const { startDevServer, clearManagedServer } = await import('../src/devServer');
        mocks.showNotifications = false;
        try {
            expect(await startDevServer()).toBe(true);
            child.emit('close', 7, null);
            await Promise.resolve();
            expect(mocks.showWarning).not.toHaveBeenCalled();
            expect(mocks.outputChannel.show).toHaveBeenCalledTimes(1);
        } finally {
            clearManagedServer();
        }
    }, 1000);
});
