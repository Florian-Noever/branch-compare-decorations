import * as vscode from 'vscode';
import type { API as GitAPI, Repository, Ref } from '../git';
import path from 'path';
import { GitUtils } from '../utils/gitUtils';

export class GitBranchPicker {
    private git?: GitAPI;

    constructor() {
        this.git = GitUtils.getGitApi();
    }

    /** Show a Quick Pick and return the chosen base ref ("" means "disable"). */
    async pickBaseRef(current?: string): Promise<string | undefined> {
        const repo = await this.pickRepo();

        // Build special items first
        const specialItems: (vscode.QuickPickItem & { value: string })[] = [];

        if (repo) {
            const currentBranch = repo.state.HEAD;
            if (currentBranch?.name) {
                // Special option: Compare with current branch origin point
                specialItems.push({
                    label: `$(git-branch) Current Branch Origin`,
                    description: `Show all changes since '${currentBranch.name}' was created`,
                    value: '__branch_origin__'
                });
            }

            // Special option: Compare with main development branch
            specialItems.push({
                label: `$(git-merge) Main Development Branch`,
                description: `Show changes since branching from main/master/dev/develop`,
                value: '__main_origin__'
            });
        }

        // Build remote branch items only
        const remoteBranchItems = await this.buildRemoteBranchItems(repo);

        const items: (vscode.QuickPickItem & { value: string })[] = [
            ...specialItems,
            { label: '', kind: vscode.QuickPickItemKind.Separator, value: '' },
            { label: 'Remote Branches', kind: vscode.QuickPickItemKind.Separator, value: '' },
            ...remoteBranchItems,
            { label: '', kind: vscode.QuickPickItemKind.Separator, value: '' },
            { label: '$(pencil) Enter manually…', description: 'Custom remote branch (e.g., origin/feature-branch)', value: '__manual__' },
            { label: '$(circle-slash) Disable', description: 'Show no custom decorations', value: '' }
        ];

        const pick = await vscode.window.showQuickPick(items, {
            placeHolder: repo
                ? 'Pick a remote branch or special comparison for Explorer decorations'
                : 'No Git repository detected. Enter a base ref or disable.',
            matchOnDescription: true
        });

        if (!pick) {
            return undefined;
        }

        if (pick.value === '__manual__') {
            const typed = await vscode.window.showInputBox({
                prompt: 'Enter remote branch (e.g., origin/feature-branch). Empty disables.',
                value: current?.startsWith('origin/') ? current : 'origin/',
                valueSelection: current?.startsWith('origin/') ? [0, current.length] : [7, 7]
            });
            return typed; // may be "" (disable) or undefined (cancel)
        }

        return pick.value; // remote branch like "origin/main", special values, or "" (disable)
    }

    private async buildRemoteBranchItems(repo: Repository | undefined): Promise<(vscode.QuickPickItem & { value: string })[]> {
        if (!repo) {
            return [];
        }

        try {
            // Simply get all remote branches
            const remoteBranches = await repo.getBranches({ remote: true }) as Ref[];

            return remoteBranches
                .filter(ref => ref.name !== null && ref.name !== undefined && ref.name.startsWith('origin/'))
                .map(ref => ({
                    label: `$(git-branch) ${ref.name!}`,
                    description: 'remote',
                    value: ref.name!
                }))
                .sort((a, b) => {
                    // Sort by: origin branches first, then alphabetically
                    const aIsOrigin = a.value.startsWith('origin/');
                    const bIsOrigin = b.value.startsWith('origin/');

                    if (aIsOrigin && !bIsOrigin) {
                        return -1;
                    }
                    if (!aIsOrigin && bIsOrigin) {
                        return 1;
                    }

                    return a.value.localeCompare(b.value);
                });
        } catch {
            return [];
        }
    }

    /** Choose a repo without requiring an active editor. */
    private async pickRepo(): Promise<Repository | undefined> {
        if (!this.git || this.git.repositories.length === 0) {
            return undefined;
        }

        // 1) Single repo? Use it.
        if (this.git.repositories.length === 1) {
            return this.git.repositories[0];
        }

        // 2) If there's a single workspace folder, prefer the repo matching it.
        const folders = vscode.workspace.workspaceFolders ?? [];
        if (folders.length === 1) {
            const wsPath = this.normalizeFs(folders[0].uri.fsPath);
            const match = this.git.repositories.find(r =>
                this.isInside(this.normalizeFs(r.rootUri.fsPath), wsPath) ||
                this.isInside(wsPath, this.normalizeFs(r.rootUri.fsPath))
            );
            if (match) {
                return match;
            }
        }

        // 3) Ask the user.
        const items = this.git.repositories.map(r => ({
            label: vscode.workspace.asRelativePath(r.rootUri, false),
            description: r.rootUri.fsPath,
            repo: r
        }));
        const picked = await vscode.window.showQuickPick(items, { placeHolder: 'Select a Git repository' });
        return picked?.repo;
    }

    /** Build QuickPick items from branches (locals + remotes). */
    private async buildBranchItems(repo?: Repository): Promise<(vscode.QuickPickItem & { value: string })[]> {
        if (!repo) {
            return [];
        }

        const locals = await repo.getBranches({ remote: false }).catch(() => []) as Ref[];
        const remotes = await repo.getBranches({ remote: true }).catch(() => []) as Ref[];

        const items: (vscode.QuickPickItem & { value: string })[] = [];

        for (const local of locals.filter(l => l.name !== null && l.name !== undefined)) {
            items.push({
                label: local.name!,
                description: 'Local branch',
                value: local.name!
            });
        }

        for (const remote of remotes.filter(l => l.name !== null && l.name !== undefined)) {
            items.push({
                label: remote.name!,
                description: 'Remote branch',
                value: remote.name!
            });
        }

        items.sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: 'base' }));
        return items;
    }

    private normalizeFs(p: string) {
        const abs = path.resolve(p);
        return process.platform === 'win32' ? abs.toLowerCase() : abs;
    }

    private isInside(ancestor: string, descendant: string) {
        if (descendant === ancestor) {
            return true;
        }
        const sep = path.sep;
        return descendant.startsWith(ancestor.endsWith(sep) ? ancestor : ancestor + sep);
    }
}
