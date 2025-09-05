import * as vscode from 'vscode';
import * as path from 'path';
import type { API as GitAPI, Repository, Change } from './git';
import { Status } from './git';

const isWindows = process.platform === 'win32';
const normFs = (p: string) => {
    const abs = path.resolve(p);
    return isWindows ? abs.toLowerCase() : abs;
};

type ChangeStatus = 'A' | 'M' | 'D' | 'R' | 'C' | 'U' | 'T' | 'X' | '?';

export class BranchCompareProvider implements vscode.FileDecorationProvider {
    private changed = new Map<string, ChangeStatus>();
    private lastKeys = new Set<string>();
    private _onDidChange = new vscode.EventEmitter<vscode.Uri[] | undefined>();
    public readonly onDidChangeFileDecorations = this._onDidChange.event;

    private git?: GitAPI;

    constructor() {
        // Grab the built-in Git API
        const gitExt = vscode.extensions.getExtension<any>('vscode.git')?.exports;
        this.git = gitExt?.getAPI(1);

        // React to config changes
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('branchCompare.baseRef') || e.affectsConfiguration('branchCompare.autoFetch')) {
                this.refresh();
            }
        });

        // Refresh on typical change triggers
        vscode.workspace.onDidSaveTextDocument(() => this.refresh());
        vscode.workspace.onDidCreateFiles(() => this.refresh());
        vscode.workspace.onDidDeleteFiles(() => this.refresh());
        vscode.workspace.onDidRenameFiles(() => this.refresh());

        // Also refresh when Git repos change
        this.git?.onDidOpenRepository?.((repo: Repository) => {
            repo.state.onDidChange(() => this.refresh());
            repo.onDidCheckout?.(() => this.refresh());
            repo.onDidCommit?.(() => this.refresh());
            this.refresh();
        });
    }

    private get baseRef() {
        return vscode.workspace.getConfiguration('branchCompare').get<string>('baseRef', '');
    }

    private get autoFetch() {
        return vscode.workspace.getConfiguration('branchCompare').get<boolean>('autoFetch', true);
    }

    private toUri(p: string) {
        return vscode.Uri.file(p);
    }

    private isDisabled() {
        return !this.baseRef || this.baseRef.trim().length === 0;
    }

    private parentsWithinWorkspace(absPath: string): vscode.Uri[] {
        const uriList: vscode.Uri[] = [];
        const workspaces = vscode.workspace.workspaceFolders ?? [];
        const file = isWindows ? absPath.toLowerCase() : absPath;

        for (const workspace of workspaces) {
            const root = normFs(workspace.uri.fsPath);
            if (!file.startsWith(root)) {
                continue;
            }

            let cur = path.dirname(file);
            while (cur.length > root.length) {
                uriList.push(this.toUri(cur));
                const next = path.dirname(cur);
                if (next === cur) {
                    break;
                }
                cur = next;
            }
        }
        return uriList;
    }

    /** External callers can force a refresh. */
    public async refresh() {
        const changedBefore = new Set(this.lastKeys);
        await this.computeAllWorkspaceChanges();

        const changedNow = new Set(this.changed.keys());
        const impacted = new Set<string>();

        for (const k of changedNow) {
            if (!changedBefore.has(k)) {
                impacted.add(k);
            }
        }
        for (const k of changedBefore) {
            if (!changedNow.has(k)) {
                impacted.add(k);
            }
        }

        const impactedUris: vscode.Uri[] = [];
        for (const k of impacted) {
            impactedUris.push(this.toUri(k));
            for (const par of this.parentsWithinWorkspace(k)) {
                impactedUris.push(par);
            }
        }

        if (impactedUris.length === 0) {
            this._onDidChange.fire(undefined);
        } else {
            this._onDidChange.fire(impactedUris);
        }
    }

    async provideFileDecoration(uri: vscode.Uri): Promise<vscode.FileDecoration | undefined> {
        // No coloring if disabled
        if (this.isDisabled()) {
            return;
        }

        // Convert to absolute path (so it matches the Map keys)
        const key = normFs(uri.fsPath);
        const status = this.changed.get(key);
        if (!status) {
            return;
        }

        // Map Git status to VS Code gitDecoration colors.
        const colorKey =
            status === 'A' ? 'gitDecoration.addedResourceForeground' :
                status === 'D' ? 'gitDecoration.deletedResourceForeground' :
                    status === 'R' ? 'gitDecoration.renamedResourceForeground' :
                        'gitDecoration.modifiedResourceForeground';

        return {
            badge: status,                           // one-letter badge like A/M/D/R
            tooltip: `Changes vs ${this.baseRef}`,
            color: new vscode.ThemeColor(colorKey),
            propagate: true                          // decorate parent folders too
        };
    }

    private async computeAllWorkspaceChanges() {
        this.changed.clear();

        // Clear colors and exit if disabled or no Git API
        if (this.isDisabled() || !this.git) {
            this.lastKeys.clear();
            return;
        }

        const folders = vscode.workspace.workspaceFolders ?? [];
        await Promise.all(folders.map(f => this.computeChangesForFolder(f)));
        // for (const f of folders) {
        //     await this.computeChangesForFolder(f);
        // }

        this.lastKeys = new Set(this.changed.keys());
    }

    private pickRepoForFolder(folder: vscode.WorkspaceFolder): Repository | undefined {
        // Prefer a repo that contains this folder
        const direct = this.git!.getRepository(folder.uri);
        if (direct) {
            return direct;
        }

        // Fallback: pick a repo whose root is an ancestor of the folder (multi-root / nested)
        const folderPath = normFs(folder.uri.fsPath);
        return this.git!.repositories.find(r => folderPath.startsWith(normFs(r.rootUri.fsPath)));
    }

    private async computeChangesForFolder(folder: vscode.WorkspaceFolder) {
        const repo = this.pickRepoForFolder(folder);
        if (!repo) {
            return;
        }

        try {
            let baseRef = this.baseRef;

            // Keep base ref fresh (e.g., 'origin/main')
            if (this.autoFetch && baseRef.includes('/')) { //todo Check
                const [remote, ...refParts] = baseRef.split('/');
                const remoteRef = refParts.join('/');
                if (remote && remoteRef) {
                    await repo.fetch(remote, remoteRef).catch(() => { });
                }
            }

            // Compute merge-base
            const mergeBase = await repo.getMergeBase(baseRef, 'HEAD'); // may be undefined
            const ref1 = mergeBase ?? baseRef;

            // List file-level changes between ref1 and HEAD
            const changes = await repo.diffBetween(ref1, 'HEAD');
            // const changeDebug = changes.map(change => `${change.status}: ${path.basename(change.uri.fsPath)}`);
            await Promise.all(changes.map(change => this.handleChange(change)));
        } catch {
            // Ignore repo errors (non-git folder, detached states, etc.)
        }
    }

    private async handleChange(change: Change) {
        // Renames: color both old & new
        if (change.status === Status.INDEX_RENAMED && change.renameUri) {
            const newKey = normFs(change.uri.fsPath);
            this.changed.set(newKey, 'R');
            if (change.renameUri) {
                const oldKey = normFs(change.renameUri.fsPath);
                this.changed.set(oldKey, 'R');
            }
            return;
        }

        const s = change.status;
        const badge: ChangeStatus =
            s === Status.DELETED || s === Status.INDEX_DELETED ? 'D' :
                s === Status.ADDED_BY_US || s === Status.INDEX_ADDED ||
                    s === Status.UNTRACKED || s === Status.INTENT_TO_ADD ? 'A' :
            /* everything else (MODIFIED, INDEX_MODIFIED, TYPE_CHANGED, conflicts, etc.) */ 'M';

        const key = normFs(change.uri.fsPath);
        this.changed.set(key, badge);
    }
}
