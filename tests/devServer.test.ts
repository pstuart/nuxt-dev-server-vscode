import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    untrusted: false,
    showInfo: vi.fn(),
    showError: vi.fn(),
    waitForPort: vi.fn(),
    port: null as unknown,
    host: '' as unknown,
    https: false as unknown,
    manager: 'npm',
    showWarning: vi.fn(),
    onServerStart: vi.fn(),
    openExternal: vi.fn(),
    executeCommand: vi.fn(),
    spawn: vi.fn(),
    killProcessesByWorkingDir: vi.fn(),
    outputChannel: { clear: vi.fn(), show: vi.fn(), append: vi.fn(), appendLine: vi.fn() },
    browserType: 'external',
    showNotifications: true,
    // '' → devServer falls through to workspace.findFiles discovery; 'apps/web'
    // exercises the explicit nuxt-dev-server.projectDirectory setting path.
    projectDirectory: '',
    // fsPath values returned by the mocked workspace.findFiles call.
    foundConfigPaths: [] as string[],
}));

vi.mock('vscode', () => ({
    workspace: {
        workspaceFolders: [{ uri: { fsPath: '/fixture' } }],
        // Nested configs are returned only for a recursive glob. A root-only
        // pattern (no `**`) must miss apps/web/nuxt.config.ts so the discovery
        // test fails instead of passing by accident.
        findFiles: async (include: { pattern?: string } | string) => {
            const pattern = typeof include === 'string' ? include : include?.pattern ?? '';
            if (!pattern.includes('**')) return [];
            return mocks.foundConfigPaths.map((fsPath) => ({ fsPath }));
        },
        // devServer.resolveProjectDirectory reads nuxt-dev-server.projectDirectory
        // directly from the workspace configuration.
        getConfiguration: () => ({
            get: (key: string, fallback: unknown) =>
                key === 'projectDirectory' ? mocks.projectDirectory : fallback,
        }),
    },
    env: { openExternal: mocks.openExternal },
    commands: { executeCommand: mocks.executeCommand },
    window: { showWarningMessage: mocks.showWarning },
    Uri: { parse: (url: string) => url },
    RelativePattern: class {
        constructor(public baseUri: unknown, public pattern: string) {}
    },
}));
vi.mock('child_process', () => ({ spawn: mocks.spawn }));
vi.mock('../src/utils', () => ({
    getConfig: () => ({
        defaultPort: 3000,
        port: mocks.port,
        host: mocks.host,
        https: mocks.https,
        preferredPackageManager: mocks.manager,
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
    showError: mocks.showError, debugLog: vi.fn(), getErrorMessage: String, sleep: vi.fn(),
    // Mirrors src/utils.ts: embedded routes through Simple Browser, anything else
    // through openExternal. The embedded test below flips mocks.browserType and
    // asserts the destination actually changes.
    openServerUrl: (url: string) => mocks.browserType === 'embedded'
        ? mocks.executeCommand('simpleBrowser.show', url)
        : mocks.openExternal(url),
}));
vi.mock('../src/processManager', () => ({
    waitForProcessTreePort: mocks.waitForPort,
    killProcessTree: vi.fn(),
    killProcessesByWorkingDir: mocks.killProcessesByWorkingDir,
    verifyProcessTerminated: async () => true,
}));
vi.mock('../src/autoKill', () => ({ onServerStart: mocks.onServerStart, onServerStop: vi.fn() }));
vi.mock('../src/statusBar', () => ({ forceStatusBarUpdate: vi.fn() }));
vi.mock('../src/platform', () => ({ isBinaryAvailable: async () => true }));
vi.mock('../src/workspaceTrust', () => ({ refuseIfUntrusted: async () => mocks.untrusted }));

describe('server startup', () => {
    describe.each([
        { manager: 'npm', prefix: ['run'] },
        { manager: 'bun', prefix: ['run'] },
        { manager: 'pnpm', prefix: [] },
        { manager: 'yarn', prefix: [] },
    ])('$manager production scripts', ({ manager, prefix }) => {
        it.each(['build', 'generate'] as const)('runs the %s package script and reports its exit code', async (script) => {
            mocks.manager = manager;
            const { runProductionScript } = await import('../src/devServer');
            const pending = runProductionScript(script);
            await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalled());
            expect(mocks.spawn).toHaveBeenCalledExactlyOnceWith(manager, [...prefix, script], expect.objectContaining({ shell: false, cwd: '/fixture' }));
            child.stdout.emit('data', Buffer.from('building'));
            child.emit('close', 0, null);
            expect(await pending).toBe(true);
            expect(mocks.outputChannel.append).toHaveBeenCalledWith('building');
            expect(mocks.showInfo).toHaveBeenCalledWith(`Nuxt ${script} succeeded (exit code 0)`);
        });
    });

    it('refuses production commands in Restricted Mode', async () => {
        const { runProductionScript, startPreviewServer } = await import('../src/devServer');
        mocks.untrusted = true;
        expect(await runProductionScript('build')).toBe(false);
        expect(await runProductionScript('generate')).toBe(false);
        expect(await startPreviewServer()).toBe(false);
        expect(mocks.spawn).not.toHaveBeenCalled();
    });

    it('reports a failed build exit code', async () => {
        const { runProductionScript } = await import('../src/devServer');
        const pending = runProductionScript('build');
        await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalled());
        child.emit('close', 7, null);
        expect(await pending).toBe(false);
        expect(mocks.showError).toHaveBeenCalledWith('Nuxt build failed (exit code 7)');
    });

    it('tracks preview like a dev server', async () => {
        const { startPreviewServer, getManagedServer } = await import('../src/devServer');
        expect(await startPreviewServer()).toBe(true);
        expect(mocks.spawn).toHaveBeenCalledWith('npm', ['run', 'preview'], expect.objectContaining({ shell: false }));
        expect(getManagedServer()?.port).toBe(3000);
    });

    let child: EventEmitter & {
        pid: number; exitCode: number | null; signalCode: string | null; killed: boolean;
        stdout: EventEmitter; stderr: EventEmitter;
    };

    beforeEach(async () => {
        mocks.untrusted = false;
        mocks.port = null;
        mocks.host = '';
        mocks.https = false;
        mocks.manager = 'npm';
        mocks.showError.mockReset();
        mocks.waitForPort.mockReset().mockResolvedValue(3000);
        mocks.projectDirectory = '';
        mocks.foundConfigPaths = [];
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

    it.each(['https://localhost:3000', 'http://127.0.0.1:4000', 'https://dev.local:4443', 'http://[::1]:3001'])(
        'uses the printed URL %s immediately, even when polling is pending', async (url) => {
            const { startDevServer, getManagedServer } = await import('../src/devServer');
            mocks.waitForPort.mockImplementation(() => {
                child.stdout.emit('data', Buffer.from(`Network: http://192.168.1.2:9999/\n  Local: ${url}/\n`));
                return new Promise(() => {});
            });
            expect(await startDevServer()).toBe(true);
            expect(getManagedServer()?.url).toBe(url);
            expect(getManagedServer()?.port).toBe(Number(url.match(/:(\d+)$/)?.[1]));
            expect(mocks.openExternal).toHaveBeenCalledExactlyOnceWith(url);
        }, 1000);

    it('handles ANSI, split stderr output and preserves HTTPS after polling wins', async () => {
        const { startDevServer, getManagedServer } = await import('../src/devServer');
        expect(await startDevServer()).toBe(true);
        child.stderr.emit('data', Buffer.from('\x1b[32mLocal: https://[::'));
        child.stderr.emit('data', Buffer.from('1]:4443/\x1b[0m\n'));
        expect(getManagedServer()?.url).toBe('https://[::1]:4443');
        expect(getManagedServer()?.port).toBe(4443);
    });

    it('does not let a simultaneous polling result overwrite the printed URL', async () => {
        const { startDevServer, getManagedServer } = await import('../src/devServer');
        mocks.waitForPort.mockImplementation(() => {
            child.stdout.emit('data', Buffer.from('Local: https://dev.local:4443/\n'));
            return Promise.resolve(3000);
        });
        expect(await startDevServer()).toBe(true);
        expect(getManagedServer()?.url).toBe('https://dev.local:4443');
        expect(getManagedServer()?.port).toBe(4443);
        expect(mocks.showInfo).toHaveBeenCalledWith('Nuxt dev server started on port 4443');
    });

    it.each(['stdout', 'stderr'] as const)('waits for URL termination across separate %s turns before startup and browser open', async (stream) => {
        const { startDevServer, getManagedServer } = await import('../src/devServer');
        let pollingStarted!: () => void;
        const pollingReady = new Promise<void>(resolve => { pollingStarted = resolve; });
        mocks.waitForPort.mockImplementation(() => {
            pollingStarted();
            return new Promise(() => {});
        });
        let settled = false;
        const startup = startDevServer().then(result => {
            settled = true;
            return result;
        });
        await pollingReady;
        child[stream].emit('data', Buffer.from('Local: https://localhost:44'));
        // Drain startup continuations in a separate event-loop turn, not just
        // synchronous emissions that can hide an early browser open.
        await new Promise<void>(resolve => setImmediate(resolve));
        expect(settled).toBe(false);
        expect(getManagedServer()?.port).toBe(3000);
        expect(getManagedServer()?.url).toBe('http://localhost:3000');
        expect(mocks.openExternal).not.toHaveBeenCalled();
        expect(mocks.executeCommand).not.toHaveBeenCalled();
        expect(mocks.onServerStart).not.toHaveBeenCalled();

        child[stream].emit('data', Buffer.from('43/\n'));
        expect(await startup).toBe(true);
        expect(getManagedServer()?.port).toBe(4443);
        expect(getManagedServer()?.url).toBe('https://localhost:4443');
        expect(mocks.openExternal).toHaveBeenCalledExactlyOnceWith('https://localhost:4443');
        expect(mocks.onServerStart).toHaveBeenCalledTimes(1);
    }, 1000);

    it.each(['stdout', 'stderr'] as const)('keeps a split %s URL pending when the other stream emits a newline', async (stream) => {
        const { startDevServer, getManagedServer } = await import('../src/devServer');
        let pollingStarted!: () => void;
        const pollingReady = new Promise<void>(resolve => { pollingStarted = resolve; });
        mocks.waitForPort.mockImplementation(() => {
            pollingStarted();
            return new Promise(() => {});
        });
        let settled = false;
        const startup = startDevServer().then(result => {
            settled = true;
            return result;
        });
        await pollingReady;
        child[stream].emit('data', Buffer.from('Local: https://localhost:44'));
        child[stream === 'stdout' ? 'stderr' : 'stdout'].emit('data', Buffer.from('\nwarning\n'));
        await new Promise<void>(resolve => setImmediate(resolve));
        expect(settled).toBe(false);
        expect(getManagedServer()?.port).toBe(3000);
        expect(getManagedServer()?.url).toBe('http://localhost:3000');
        expect(mocks.openExternal).not.toHaveBeenCalled();
        expect(mocks.executeCommand).not.toHaveBeenCalled();
        expect(mocks.onServerStart).not.toHaveBeenCalled();
        expect(mocks.showInfo).not.toHaveBeenCalledWith('Nuxt dev server started on port 44');

        child[stream].emit('data', Buffer.from('43/\n'));
        expect(await startup).toBe(true);
        expect(getManagedServer()?.port).toBe(4443);
        expect(getManagedServer()?.url).toBe('https://localhost:4443');
        expect(mocks.openExternal).toHaveBeenCalledExactlyOnceWith('https://localhost:4443');
        expect(mocks.onServerStart).toHaveBeenCalledTimes(1);
        expect(mocks.showInfo).toHaveBeenCalledWith('Nuxt dev server started on port 4443');
    }, 1000);

    it('finishes a port split across output chunks', async () => {
        const { startDevServer, getManagedServer } = await import('../src/devServer');
        await startDevServer();
        child.stdout.emit('data', Buffer.from('Local: https://localhost:44'));
        child.stdout.emit('data', Buffer.from('43/\n'));
        expect(getManagedServer()?.url).toBe('https://localhost:4443');
        expect(getManagedServer()?.port).toBe(4443);
    });

    it.each(['npm', 'yarn', 'pnpm', 'bun'])('forwards validated overrides via %s and honors polling fallback', async (manager) => {
        const { startDevServer, getManagedServer } = await import('../src/devServer');
        mocks.manager = manager;
        mocks.port = 4443;
        mocks.host = '[::1]';
        mocks.https = true;
        mocks.waitForPort.mockResolvedValue(4444);
        expect(await startDevServer()).toBe(true);
        const flags = ['--port', '4443', '--host', '::1', '--https'];
        expect(mocks.spawn.mock.calls[0][1]).toEqual(manager === 'npm' ? ['run', 'dev', '--', ...flags] : ['dev', ...flags]);
        expect(mocks.waitForPort.mock.calls[0][2]).toBe(4443);
        expect(getManagedServer()?.url).toBe('https://[::1]:4444');
        expect(mocks.openExternal).toHaveBeenCalledExactlyOnceWith('https://[::1]:4444');
    });

    it.each([
        ['host', 'localhost;touch /tmp/no'], ['host', '--help'], ['host', 'http://localhost'],
        ['port', 0], ['port', 65536], ['port', 3.5], ['port', '4443'], ['https', 'true'],
    ])('rejects invalid %s override %s before spawning', async (key, value) => {
        const { startDevServer } = await import('../src/devServer');
        Object.assign(mocks, { [key]: value });
        expect(await startDevServer()).toBe(false);
        expect(mocks.spawn).not.toHaveBeenCalled();
        expect(mocks.showError).toHaveBeenCalled();
    });

    it('leaves default CLI arguments unchanged', async () => {
        const { startDevServer } = await import('../src/devServer');
        expect(await startDevServer()).toBe(true);
        expect(mocks.spawn.mock.calls[0][1]).toEqual(['run', 'dev']);
    });

    it('starts in the nested project directory when nuxt.config lives only at apps/web', async () => {
        const { startDevServer, clearManagedServer, getManagedServer } = await import('../src/devServer');
        // Root folder has no nuxt.config; the only config sits at apps/web/nuxt.config.ts.
        mocks.foundConfigPaths = ['/fixture/apps/web/nuxt.config.ts'];
        try {
            expect(await startDevServer()).toBe(true);
            // Spawn used the resolved project directory, not the bare workspace root.
            expect(mocks.spawn).toHaveBeenCalledTimes(1);
            const [, , options] = mocks.spawn.mock.calls[0] as [string, string[], { cwd: string }];
            expect(options.cwd).toBe('/fixture/apps/web');
            // managedServer.workingDir carries the same resolved directory.
            expect(getManagedServer()?.workingDir).toBe('/fixture/apps/web');
            // The status bar reflects the port parsed from the child's stdout.
            child.stdout.emit('data', Buffer.from('http://localhost:3000'));
            expect(getManagedServer()?.port).toBe(3000);
            expect(mocks.showInfo).toHaveBeenCalledWith('Nuxt dev server started on port 3000');
        } finally {
            clearManagedServer();
        }
    }, 1000);

    it('honours the explicit projectDirectory setting ahead of discovery', async () => {
        const { startDevServer, clearManagedServer, getManagedServer } = await import('../src/devServer');
        mocks.projectDirectory = 'apps/web';
        // Both shapes agree on apps/web: the setting wins and discovery is skipped.
        mocks.foundConfigPaths = ['/fixture/apps/web/nuxt.config.ts'];
        try {
            expect(await startDevServer()).toBe(true);
            const [, , options] = mocks.spawn.mock.calls[0] as [string, string[], { cwd: string }];
            expect(options.cwd).toBe('/fixture/apps/web');
            expect(getManagedServer()?.workingDir).toBe('/fixture/apps/web');
        } finally {
            clearManagedServer();
        }
    }, 1000);

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
