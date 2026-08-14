import * as vscode from 'vscode';
import { showError, debugLog } from './utils';
import {
    TrustSensitiveAction,
    evaluateWorkspaceTrust,
} from './workspaceTrustLogic';

export type { TrustSensitiveAction } from './workspaceTrustLogic';
export { evaluateWorkspaceTrust, untrustedWorkspaceMessage } from './workspaceTrustLogic';

/** Show the start-gate error and return true when the action must not proceed. */
export async function refuseIfUntrusted(action: TrustSensitiveAction): Promise<boolean> {
    const decision = evaluateWorkspaceTrust(vscode.workspace.isTrusted, action);
    if (decision.allowed) {
        return false;
    }
    debugLog(`${action} blocked: workspace is not trusted`);
    await showError(decision.message);
    return true;
}

/** Silent check for periodic auto-kill — avoid toasting every 30s. */
export function isDestructiveAutoKillAllowed(): boolean {
    return evaluateWorkspaceTrust(vscode.workspace.isTrusted, 'autoKillExtras').allowed;
}
