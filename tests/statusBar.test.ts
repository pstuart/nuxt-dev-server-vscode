import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

// statusBar.ts imports vscode at module level (directly and via
// utils/processManager/devServer). Reuse the shared factory and add the
// status-bar surface the module under test touches. vi.mock is hoisted above
// static imports, so the shared factory is imported lazily inside the factory.
vi.mock('vscode', async () => {
    const vscodeMock = (await import('./vscodeMock')).mockVscodeModule() as {
        window: Record<string, unknown>;
        workspace: Record<string, unknown>;
    };
    return {
        ...vscodeMock,
        ThemeColor: class ThemeColor {
            constructor(public id: string) {}
        },
        StatusBarAlignment: { Left: 1, Right: 2 },
        window: {
            ...vscodeMock.window,
            createStatusBarItem: vi.fn(() => statusBarItem),
        },
        workspace: {
            ...vscodeMock.workspace,
            onDidChangeWorkspaceFolders: vi.fn(() => ({ dispose: vi.fn() })),
            onDidChangeConfiguration: vi.fn(() => ({ dispose: vi.fn() })),
        },
    };
});

interface StatusBarItemLike {
    text: string;
    tooltip: string | undefined;
    name: string | undefined;
    accessibilityInformation: { label: string } | undefined;
    backgroundColor: unknown;
    command: string | undefined;
    show: ReturnType<typeof vi.fn>;
    hide: ReturnType<typeof vi.fn>;
    dispose: ReturnType<typeof vi.fn>;
}

/** Fresh per-test mock; assigned before the module under test is used. */
let statusBarItem: StatusBarItemLike;

function freshStatusBarItem(): StatusBarItemLike {
    return {
        text: '',
        tooltip: undefined,
        name: undefined,
        accessibilityInformation: undefined,
        backgroundColor: undefined,
        command: undefined,
        show: vi.fn(),
        hide: vi.fn(),
        dispose: vi.fn(),
    };
}

const { updateStatusBar, cleanupStatusBar } = await import('../src/statusBar');
const { STATUS_BAR } = await import('../src/constants');

// Process/server state lives in module-level singletons; replace the modules
// status bar.ts consults so each branch is deterministic per test.
const processManager = await import('../src/processManager');
const devServer = await import('../src/devServer');

function stubState(options: { runningCount?: number; managedServer?: { port: number; url: string } | null; debugging?: boolean }): void {
    const runningCount = options.runningCount ?? 0;
    vi.spyOn(processManager, 'getRunningNuxtProcessCount').mockResolvedValue(runningCount);
    vi.spyOn(processManager, 'getRunningNuxtProcesses').mockResolvedValue([]);
    vi.spyOn(devServer, 'isManagedServerRunning').mockReturnValue(Boolean(options.managedServer));
    vi.spyOn(devServer, 'getManagedServer').mockReturnValue(
        options.managedServer
            ? ({ process: {}, workingDir: '/w', port: options.managedServer.port, url: options.managedServer.url } as never)
            : null
    );
    vi.spyOn(devServer, 'isDebugSessionActive').mockReturnValue(options.debugging ?? false);
}

/** Initialize the real status bar against the mock vscode and return its item. */
async function initialize(): Promise<StatusBarItemLike> {
    const vscode = (await import('vscode')) as unknown as {
        window: { createStatusBarItem: ReturnType<typeof vi.fn> };
    };
    statusBarItem = freshStatusBarItem();
    const { initializeStatusBar } = await import('../src/statusBar');
    const context = { subscriptions: [] as Array<{ dispose(): void }> } as never;
    initializeStatusBar(context);
    expect(vscode.window.createStatusBarItem).toHaveBeenCalled();
    return statusBarItem;
}

describe('updateStatusBar accessible state contract', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
    });

    afterEach(() => { cleanupStatusBar(); });

    it('running-with-port branch sets name and tooltip identifying the running server and port', async () => {
        stubState({ runningCount: 1, managedServer: { port: 3000, url: 'http://localhost:3000' } });
        const item = await initialize();

        await updateStatusBar();

        expect(item.text).toBe('$(radio-tower) Nuxt Dev :3000 (1)');
        expect(item.name).toBe(`${STATUS_BAR.ACCESSIBLE.RUNNING} on port 3000 (1 instance in total)`);
        expect(item.accessibilityInformation?.label).toBe(item.name);
        expect(item.tooltip).toContain('Nuxt server running on http://localhost:3000');
    });

    it('debug-launched managed server names the debug session in text, name and tooltip', async () => {
        stubState({ runningCount: 1, managedServer: { port: 3000, url: 'http://localhost:3000' }, debugging: true });
        const item = await initialize();

        await updateStatusBar();

        expect(item.text).toBe('$(debug-start) Nuxt Dev :3000 (1)');
        expect(item.name).toBe(`${STATUS_BAR.ACCESSIBLE.DEBUGGING} on port 3000 (1 instance in total)`);
        expect(item.accessibilityInformation?.label).toBe(item.name);
        expect(item.tooltip).toContain('(debug session)');
    });

    it('instances-detected branch sets a warning-state name distinct from the running state', async () => {
        stubState({ runningCount: 2, managedServer: null });
        const item = await initialize();

        await updateStatusBar();

        expect(item.text).toBe('$(radio-tower) Nuxt (2)');
        expect(item.name).toBe(`${STATUS_BAR.ACCESSIBLE.INSTANCES} (2)`);
        expect(item.accessibilityInformation?.label).toBe(item.name);
        expect(item.tooltip).toContain('No managed server running');
        expect(item.backgroundColor).toBeInstanceOf(((await import('vscode')) as unknown as { ThemeColor: new (id: string) => object }).ThemeColor);
    });

    it('restarts the timer on folder changes and stops it when all folders close', async () => {
        vi.useFakeTimers();
        const vscode = await import('vscode');
        const utils = await import('../src/utils');
        const config = utils.getConfig();
        vi.spyOn(utils, 'getConfig').mockReturnValue({ ...config, updateInterval: 1000 });
        stubState({});
        const originalFolders = vscode.workspace.workspaceFolders;
        try {
            await initialize();
            const callback = vi.mocked(vscode.workspace.onDidChangeWorkspaceFolders).mock.calls.at(-1)?.[0];
            expect(callback).toBeDefined();
            const event = { added: [], removed: [] };
            Object.defineProperty(vscode.workspace, 'workspaceFolders', { configurable: true, value: [{ uri: { fsPath: '/w' } }] });
            vi.mocked(utils.getConfig).mockReturnValue({ ...config, updateInterval: 2000 });
            callback!(event);
            expect(vi.getTimerCount()).toBe(1);
            vi.mocked(processManager.getRunningNuxtProcessCount).mockClear();
            await vi.advanceTimersByTimeAsync(1000);
            expect(processManager.getRunningNuxtProcessCount).not.toHaveBeenCalled();
            await vi.advanceTimersByTimeAsync(1000);
            expect(processManager.getRunningNuxtProcessCount).toHaveBeenCalledTimes(1);
            Object.defineProperty(vscode.workspace, 'workspaceFolders', { configurable: true, value: [] });
            callback!(event);
            expect(vi.getTimerCount()).toBe(0);
            Object.defineProperty(vscode.workspace, 'workspaceFolders', { configurable: true, value: [{ uri: { fsPath: '/w' } }] });
            callback!(event);
            expect(vi.getTimerCount()).toBe(1);
        } finally {
            cleanupStatusBar();
            Object.defineProperty(vscode.workspace, 'workspaceFolders', { configurable: true, value: originalFolders });
            vi.useRealTimers();
        }
    });

    it('idle branch sets an idle name and a start-hint tooltip', async () => {
        stubState({ runningCount: 0, managedServer: null });
        const item = await initialize();

        await updateStatusBar();

        expect(item.text).toBe('$(circle-slash) Nuxt Dev');
        expect(item.name).toBe(STATUS_BAR.ACCESSIBLE.IDLE);
        expect(item.accessibilityInformation?.label).toBe(item.name);
        expect(item.tooltip).toContain('No Nuxt server running');
    });
});
