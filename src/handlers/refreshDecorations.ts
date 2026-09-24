import * as vscode from 'vscode';
import { MANIFEST } from '../constants';
import type { BranchCompareProvider } from '../utils/branchCompareProvider';
import { errorMessage } from '../utils/errors';
import { Logger } from '../utils/logger';

export async function handleRefreshDecorations(provider: BranchCompareProvider): Promise<void> {
    try {
        await provider.refresh();
        vscode.window.showInformationMessage(`${MANIFEST.displayName}: Decorations refreshed`);
    } catch (e) {
        Logger.error(`Failed to refresh decorations: ${errorMessage(e)}`);
        vscode.window.showErrorMessage(`${MANIFEST.displayName}: Failed to refresh decorations: ${errorMessage(e)}`);
    }
}
