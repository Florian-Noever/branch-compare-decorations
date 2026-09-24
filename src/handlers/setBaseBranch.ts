import * as vscode from 'vscode';
import type { API as GitAPI } from '../types/git';
import { MANIFEST } from '../constants';
import { getBaseRefForBranch, setBaseRefForBranch } from '../utils/baseRefUtils';
import type { BranchCompareProvider } from '../utils/branchCompareProvider';
import { errorMessage } from '../utils/errors';
import type { GitBranchPicker } from '../utils/gitBranchPicker';
import { Logger } from '../utils/logger';

export async function handleSetBaseBranch(gitApi: GitAPI, picker: GitBranchPicker, provider: BranchCompareProvider): Promise<void> {
    if (gitApi.repositories.length === 0) {
        vscode.window.showInformationMessage(`${MANIFEST.displayName}: No Git repository is open.`);
        return;
    }

    const repository = await picker.selectRepository();
    if (!repository) {
        return;
    }
    const branchName = repository.state.HEAD?.name;
    if (!branchName) {
        vscode.window.showWarningMessage(`${MANIFEST.displayName}: No branch is checked out in ${repository.rootUri.fsPath} (detached HEAD).`);
        return;
    }

    const chosen = await picker.pickBaseReference(repository, getBaseRefForBranch(branchName));
    if (chosen === undefined) {
        return;
    }

    try {
        await setBaseRefForBranch(branchName, chosen);
    } catch (e) {
        Logger.error(`Failed to save the base ref of '${branchName}': ${errorMessage(e)}`);
        vscode.window.showErrorMessage(`${MANIFEST.displayName}: Failed to save the base ref: ${errorMessage(e)}`);
        return;
    }

    vscode.window.showInformationMessage(chosen.trim()
        ? `${MANIFEST.displayName}: '${branchName}' is compared to '${chosen}'.`
        : `${MANIFEST.displayName}: Decorations disabled for '${branchName}'.`);
    await provider.refresh();
}
