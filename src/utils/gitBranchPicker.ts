import * as vscode from 'vscode';
import type { API as GitAPI, Repository } from '../types/git';
import { BRANCH_ORIGIN_REF, MAIN_ORIGIN_REF } from '../constants';
import { errorMessage } from './errors';
import { Logger } from './logger';
import { isPathInside, normalizeFsPath } from './pathUtils';

type BaseRefPickItem = vscode.QuickPickItem & { value: string };

const MANUAL_ENTRY = '__manual__';
const REMOTE_PREFIX = 'origin/';

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
                description: 'Custom remote branch (e.g., origin/feature-branch)',
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
            return this.promptManualReference(currentSelection);
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

    private async createRemoteBranchItems(repository: Repository): Promise<BaseRefPickItem[]> {
        try {
            const branches = await repository.getBranches({ remote: true });
            return branches
                .map(branch => branch.name)
                .filter((name): name is string => !!name?.startsWith(REMOTE_PREFIX))
                .sort((a, b) => a.localeCompare(b))
                .map(name => ({ label: `$(git-branch) ${name}`, description: 'remote', value: name }));
        } catch (e) {
            Logger.warn(`Failed to list remote branches: ${errorMessage(e)}`);
            return [];
        }
    }

    private async promptManualReference(currentSelection: string): Promise<string | undefined> {
        const value = currentSelection.startsWith(REMOTE_PREFIX) ? currentSelection : REMOTE_PREFIX;

        return vscode.window.showInputBox({
            prompt: 'Enter remote branch (e.g., origin/feature-branch). Empty disables.',
            value,
            // Select the current ref for replacement, otherwise place the cursor after the remote prefix
            valueSelection: value === currentSelection ? [0, value.length] : [value.length, value.length],
        });
    }
}
