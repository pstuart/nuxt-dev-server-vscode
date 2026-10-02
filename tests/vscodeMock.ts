import { vi } from 'vitest';

// Shared vi.mock('vscode', ...) factory for tests that load src/utils.ts
// (directly or via src/processManager), which imports vscode at module level.
// Provide a minimal mock so those modules load in a plain Node test environment.
// Must stay a plain hoist-safe function: no top-level side effects or await.
export function mockVscodeModule(): Record<string, unknown> {
    return {
        window: {
            createOutputChannel: vi.fn(() => ({ appendLine: vi.fn(), dispose: vi.fn() })),
            showErrorMessage: vi.fn(),
            showWarningMessage: vi.fn(),
            showInformationMessage: vi.fn(),
        },
        workspace: {
            getConfiguration: vi.fn(() => ({
                get: vi.fn((_key: string, defaultVal: unknown) => defaultVal),
            })),
        },
    };
}
