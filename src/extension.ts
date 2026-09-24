import * as vscode from 'vscode';
import { COMMAND_REFRESH, COMMAND_SET_BASE, MANIFEST } from './constants';
import { handleRefreshDecorations } from './handlers/refreshDecorations';
import { handleSetBaseBranch } from './handlers/setBaseBranch';
import { BranchCompareProvider } from './utils/branchCompareProvider';
import { GitBranchPicker } from './utils/gitBranchPicker';
import { getGitApi } from './utils/gitUtils';
import { Logger } from './utils/logger';

export function activate(context: vscode.ExtensionContext) {
    Logger.initialize(context);

    const gitApi = getGitApi();
    if (!gitApi) {
        Logger.warn('The built-in Git extension is unavailable, decorations are turned off.');
        return;
    }

    const provider = new BranchCompareProvider(gitApi);
    const picker = new GitBranchPicker(gitApi);

    context.subscriptions.push(
        provider,
        vscode.window.registerFileDecorationProvider(provider),
        vscode.commands.registerCommand(COMMAND_REFRESH, () => handleRefreshDecorations(provider)),
        vscode.commands.registerCommand(COMMAND_SET_BASE, () => handleSetBaseBranch(gitApi, picker, provider))
    );

    Logger.info(`Successfully activated "${MANIFEST.displayName}" extension.`);
}

export function deactivate() { }
