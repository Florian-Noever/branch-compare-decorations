import * as vscode from 'vscode';
import { MANIFEST } from '../constants';
import type { BranchCompareProvider } from '../utils/branchCompareProvider';
import { setDecorationsEnabled } from '../utils/enabledUtils';
import { errorMessage } from '../utils/errors';
import { Logger } from '../utils/logger';

export async function handleSetDecorationsEnabled(provider: BranchCompareProvider, enabled: boolean): Promise<void> {
    const action = enabled ? 'activate' : 'deactivate';
    try {
        await setDecorationsEnabled(enabled);
    } catch (e) {
        Logger.error(`Failed to ${action} the decorations: ${errorMessage(e)}`);
        vscode.window.showErrorMessage(`${MANIFEST.displayName}: Failed to ${action} the decorations: ${errorMessage(e)}`);
        return;
    }

    await provider.refresh();
    vscode.window.showInformationMessage(enabled
        ? `${MANIFEST.displayName}: Decorations activated.`
        : `${MANIFEST.displayName}: Decorations deactivated. Only VS Code's Git decorations are shown.`);
}
