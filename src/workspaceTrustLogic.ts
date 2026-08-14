export type TrustSensitiveAction = 'start' | 'killAll' | 'listAndKill' | 'autoKillExtras';

/**
 * Same tone as the existing start-gate: refuse the action and tell the user
 * to trust the folder first.
 */
export function untrustedWorkspaceMessage(action: TrustSensitiveAction): string {
    switch (action) {
        case 'start':
            return 'Cannot start Nuxt dev server in an untrusted workspace. Trust the folder first.';
        case 'killAll':
            return 'Cannot kill Nuxt processes in an untrusted workspace. Trust the folder first.';
        case 'listAndKill':
            return 'Cannot list and kill Nuxt processes in an untrusted workspace. Trust the folder first.';
        case 'autoKillExtras':
            return 'Cannot auto-kill extra Nuxt servers in an untrusted workspace. Trust the folder first.';
    }
}

export function evaluateWorkspaceTrust(
    isTrusted: boolean,
    action: TrustSensitiveAction
): { allowed: true } | { allowed: false; message: string } {
    if (isTrusted) {
        return { allowed: true };
    }
    return { allowed: false, message: untrustedWorkspaceMessage(action) };
}
