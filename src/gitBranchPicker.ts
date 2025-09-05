import * as vscode from 'vscode';
import type { API as GitAPI, Repository, Ref } from './git';
import path from 'path';

export class GitBranchPicker {
    constructor(private readonly git: GitAPI | undefined) { }

    /** Show a Quick Pick and return the chosen base ref ("" means "disable"). */
    async pickBaseRef(current?: string): Promise<string | undefined> {
        const repo = await this.pickRepo();
        // Build items (branches, manual, disable)
        const branchItems = await this.buildBranchItems(repo);
        const items: (vscode.QuickPickItem & { value: string })[] = [
            ...branchItems,
            { label: '$(pencil) Enter manually…', description: 'Tag or commit SHA', value: '__manual__' },
            { label: '$(circle-slash) Disable (empty base)', description: 'Show no custom decorations', value: '' }
        ];

        const pick = await vscode.window.showQuickPick(items, {
            placeHolder: repo
                ? 'Pick a base ref (branch/tag/sha) for Explorer decorations'
                : 'No Git repository detected. Enter a base ref or disable.',
            matchOnDescription: true
        });
        if (!pick) {
            return undefined;
        }

        if (pick.value === '__manual__') {
            const typed = await vscode.window.showInputBox({
                prompt: 'Enter base ref (branch/tag/sha). Empty disables.',
                value: current,
                valueSelection: current ? [0, current.length] : undefined
            });
            return typed; // may be "" (disable) or undefined (cancel)
        }

        return pick.value; // branch name like "main" or "origin/main", or "" (disable)
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
