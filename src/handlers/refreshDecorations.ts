import * as vscode from 'vscode';
import { MANIFEST } from '../constants';
import type { BranchCompareProvider } from '../utils/branchCompareProvider';

export async function handleRefreshDecorations(provider: BranchCompareProvider): Promise<void> {
    provider.resetBaselines();
    await provider.refresh();
    vscode.window.showInformationMessage(`${MANIFEST.displayName}: Decorations refreshed`);
}
