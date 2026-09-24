import * as vscode from 'vscode';
import type { API as GitAPI } from '../types/git';
import { MANIFEST } from '../constants';
import { getCurrentBaseRef, setBaseRefForBranch } from '../utils/baseRefUtils';
import type { BranchCompareProvider } from '../utils/branchCompareProvider';
import { errorMessage } from '../utils/errors';
import type { GitBranchPicker } from '../utils/gitBranchPicker';
import { getActiveRepository } from '../utils/gitUtils';
import { Logger } from '../utils/logger';

export async function handleSetBaseBranch(gitApi: GitAPI, picker: GitBranchPicker, provider: BranchCompareProvider): Promise<void> {
    const repository = getActiveRepository(gitApi);
    if (!repository) {
        vscode.window.showErrorMessage(`${MANIFEST.displayName}: Failed to get the current repository.`);
        return;
    }
    const branchName = repository.state.HEAD?.name ?? '';

    const chosen = await picker.pickBaseReference(getCurrentBaseRef(gitApi));
    if (chosen === undefined) {
        return;
    }

    try {
        await setBaseRefForBranch(branchName, chosen);
    } catch (e) {
        Logger.error(`Failed to save the base ref: ${errorMessage(e)}`);
        vscode.window.showErrorMessage(`${MANIFEST.displayName}: Failed to save the base ref: ${errorMessage(e)}`);
        return;
    }

    vscode.window.showInformationMessage(chosen.trim()
        ? `${MANIFEST.displayName}: compare to '${chosen}'.`
        : `${MANIFEST.displayName}: disabled.`);
    await provider.refresh();
}
