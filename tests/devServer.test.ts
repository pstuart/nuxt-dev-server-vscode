import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    showInfo: vi.fn(),
    onServerStart: vi.fn(),
    openExternal: vi.fn(),
    spawn: vi.fn(),
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
    Uri: { parse: (url: string) => url },
}));
vi.mock('child_process', () => ({ spawn: mocks.spawn }));
vi.mock('../src/utils', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../src/utils')>()),
    getConfig: () => ({
        defaultPort: 3000, preferredPackageManager: 'npm', devCommand: 'dev',
        projectDirectory: '', openBrowserOnStart: true,
    }),
    // Path-aware: only the nested project directory actually holds a config.
    fileExists: async (filePath: string) => nuxtConfigFiles.includes(filePath),
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
    afterEach(() => {
        mocks.spawn.mockReset();
        findFiles.mockClear();
    });

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
});
