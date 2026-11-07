import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    showInfo: vi.fn(),
    onServerStart: vi.fn(),
    openExternal: vi.fn(),
    executeCommand: vi.fn(),
    spawn: vi.fn(),
    browserType: 'external' as 'external' | 'embedded',
}));

// Workspace fixture: the root folder has no nuxt.config; only apps/web does.
const ROOT = '/fixture';
const WEB = `${ROOT}/apps/web`;
const nuxtConfigFiles = [`${WEB}/nuxt.config.ts`];
const findFiles = vi.fn(async (..._args: unknown[]) => nuxtConfigFiles.map(fsPath => ({ fsPath })));

vi.mock('vscode', () => ({
    workspace: {
        workspaceFolders: [{ uri: { fsPath: ROOT } }],
        findFiles: (...args: unknown[]) => findFiles(...args),
        getConfiguration: () => ({ get: (_key: string, fallback: unknown) => fallback }),
    },
    window: {
        createOutputChannel: () => ({ clear() {}, show() {}, append() {}, appendLine() {}, dispose() {} }),
        showErrorMessage: vi.fn(), showWarningMessage: vi.fn(), showInformationMessage: vi.fn(),
        showQuickPick: vi.fn(),
    },
    env: { openExternal: mocks.openExternal },
    commands: { executeCommand: mocks.executeCommand },
    Uri: { parse: (url: string) => url },
}));
vi.mock('child_process', () => ({ spawn: mocks.spawn }));
vi.mock('../src/utils', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../src/utils')>()),
    getConfig: () => ({
        defaultPort: 3000,
        preferredPackageManager: 'npm',
        devCommand: 'dev',
        projectDirectory: '',
        openBrowserOnStart: true,
        browserType: mocks.browserType,
    }),
    // Path-aware: only the nested project directory actually holds a config.
    fileExists: async (filePath: string) => nuxtConfigFiles.includes(filePath),
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
        findFiles.mockClear();
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

    it('starts the monorepo project in apps/web when the workspace root has no nuxt.config', async () => {
        const child = Object.assign(new EventEmitter(), {
            pid: 456, exitCode: null, signalCode: null, killed: false,
            stdout: new EventEmitter(), stderr: new EventEmitter(),
        });
        mocks.spawn.mockReturnValue(child);
        mocks.showInfo.mockResolvedValue(undefined);
        const { startDevServer, getManagedServer, clearManagedServer } = await import('../src/devServer');
        try {
            expect(await startDevServer()).toBe(true);

            expect(mocks.spawn).toHaveBeenCalledTimes(1);
            const [command, , options] = mocks.spawn.mock.calls[0] as [string, string[], { cwd: string }];
            expect(command).toBe('npm');
            expect(options.cwd).toBe(WEB);

            const managed = getManagedServer();
            expect(managed?.workingDir).toBe(WEB);
            expect(managed?.port).toBe(3000);
            expect(mocks.showInfo).toHaveBeenCalledWith('Nuxt dev server started on port 3000');
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
