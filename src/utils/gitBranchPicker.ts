import * as vscode from 'vscode';
import { RefType } from '../types/git';
import type { API as GitAPI, Ref, Repository } from '../types/git';
import { BRANCH_ORIGIN_REF, MAIN_ORIGIN_REF } from '../constants';
import { errorMessage } from './errors';
import { getPreferredRemote } from './gitUtils';
import { Logger } from './logger';
import { isPathInside, normalizeFsPath } from './pathUtils';

type BaseRefPickItem = vscode.QuickPickItem & { value: string };

const MANUAL_ENTRY = '__manual__';

/** Remote branches, without the `<remote>/HEAD` symbolic refs */
function isRemoteBranch(branch: Ref): branch is Ref & { name: string } {
    return branch.type === RefType.RemoteHead && !!branch.name && !branch.name.endsWith('/HEAD');
}

/** Quick picks for choosing the base ref the current branch is compared against */
export class GitBranchPicker {
    constructor(private readonly gitApi: GitAPI) { }

    /** @returns the chosen base ref, an empty string to disable decorations, or undefined if cancelled */
    async pickBaseReference(repository: Repository, currentSelection: string): Promise<string | undefined> {
        const items: BaseRefPickItem[] = [
            ...this.createSpecialItems(repository),
            { label: '', kind: vscode.QuickPickItemKind.Separator, value: '' },
            { label: 'Remote Branches', kind: vscode.QuickPickItemKind.Separator, value: '' },
            ...await this.createRemoteBranchItems(repository),
            { label: '', kind: vscode.QuickPickItemKind.Separator, value: '' },
            {
                label: '$(pencil) Enter manually…',
                description: 'Any branch, tag or commit',
                value: MANUAL_ENTRY,
            },
            {
                label: '$(circle-slash) Disable',
                description: 'Show no custom decorations',
                value: '',
            },
        ];

        const selected = await vscode.window.showQuickPick(items, {
            placeHolder: 'Pick a remote branch or special comparison for Explorer decorations',
            matchOnDescription: true,
        });
        if (!selected) {
            return undefined;
        }
        if (selected.value === MANUAL_ENTRY) {
            return this.promptManualReference(repository, currentSelection);
        }
        return selected.value;
    }

    /**
     * The only repository, the one matching a single workspace folder, or otherwise the one the user
     * picks. Undefined if there is none or the user cancelled.
     */
    async selectRepository(): Promise<Repository | undefined> {
        const repositories = this.gitApi.repositories;
        if (repositories.length <= 1) {
            return repositories[0];
        }

        const workspaceFolders = vscode.workspace.workspaceFolders ?? [];
        if (workspaceFolders.length === 1) {
            const folderPath = normalizeFsPath(workspaceFolders[0].uri.fsPath);
            const matchingRepository = repositories.find(repository => {
                const repositoryPath = normalizeFsPath(repository.rootUri.fsPath);
                return isPathInside(repositoryPath, folderPath) || isPathInside(folderPath, repositoryPath);
            });
            if (matchingRepository) {
                return matchingRepository;
            }
        }

        const selected = await vscode.window.showQuickPick(
            repositories.map(repository => ({
                label: vscode.workspace.asRelativePath(repository.rootUri, false),
                description: repository.rootUri.fsPath,
                repository,
            })),
            { placeHolder: 'Select a Git repository' }
        );
        return selected?.repository;
    }

    private createSpecialItems(repository: Repository): BaseRefPickItem[] {
        const items: BaseRefPickItem[] = [];
        const branchName = repository.state.HEAD?.name;
        if (branchName) {
            items.push({
                label: '$(git-branch) Current Branch Origin',
                description: `Show all changes since '${branchName}' was created`,
                value: BRANCH_ORIGIN_REF,
            });
        }
        items.push({
            label: '$(git-merge) Main Development Branch',
            description: 'Show changes since branching from main/master/dev/develop',
            value: MAIN_ORIGIN_REF,
        });
        return items;
    }

    /** Branches of all remotes, those of the preferred remote first */
    private async createRemoteBranchItems(repository: Repository): Promise<BaseRefPickItem[]> {
        const preferredRemote = getPreferredRemote(repository);
        try {
            const branches = await repository.getBranches({ remote: true });
            return branches
                .filter(isRemoteBranch)
                .sort((a, b) => Number(b.remote === preferredRemote) - Number(a.remote === preferredRemote) || a.name.localeCompare(b.name))
                .map(branch => ({ label: `$(git-branch) ${branch.name}`, description: branch.remote, value: branch.name }));
        } catch (e) {
            Logger.warn(`Failed to list remote branches: ${errorMessage(e)}`);
            return [];
        }
    }

    private async promptManualReference(repository: Repository, currentSelection: string): Promise<string | undefined> {
        const remote = getPreferredRemote(repository);
        const remotePrefix = remote ? `${remote}/` : '';
        const isSpecialRef = currentSelection === BRANCH_ORIGIN_REF || currentSelection === MAIN_ORIGIN_REF;
        const value = currentSelection && !isSpecialRef ? currentSelection : remotePrefix;

        return vscode.window.showInputBox({
            prompt: `Enter a branch, tag or commit to compare against (e.g. ${remotePrefix}main). Empty disables.`,
            value,
            // Select the current ref for replacement, otherwise place the cursor after the remote prefix
            valueSelection: value === currentSelection ? [0, value.length] : [value.length, value.length],
        });
    }
}
