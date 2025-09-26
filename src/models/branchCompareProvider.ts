import * as vscode from 'vscode';
import * as path from 'path';
import type { API as GitAPI, Repository, Change, Ref } from '../git';
import { Status } from '../git';
import { CONFIG_AUTOFETCH, CONFIG_BASEREFS, EXTENSION } from '../extension';
import { BaseRefUtils } from '../utils/baseRefUtils';
import { GitUtils } from '../utils/gitUtils';

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
        this.git = GitUtils.getGitApi();

        // React to config changes
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration(EXTENSION + '.' + CONFIG_BASEREFS) || e.affectsConfiguration(EXTENSION + '.' + CONFIG_AUTOFETCH)) {
                this.refresh();
            }
        });

        // Refresh on typical change triggers
        vscode.workspace.onDidSaveTextDocument(this.refresh);
        vscode.workspace.onDidCreateFiles(this.refresh);
        vscode.workspace.onDidDeleteFiles(this.refresh);
        vscode.workspace.onDidRenameFiles(this.refresh);

        // Handle existing repositories that were opened before extension activation
        if (this.git) {
            // Subscribe to existing repositories
            for (const repo of this.git.repositories) {
                this.subscribeToRepository(repo);
            }

            // Subscribe to future repository openings
            this.git.onDidOpenRepository?.((repo: Repository) => {
                this.subscribeToRepository(repo);
                this.refresh(); // Refresh when new repo is opened
            });

            // Subscribe to repository closings
            this.git.onDidCloseRepository?.(() => {
                this.refresh(); // Refresh when repo is closed
            });
        }
    }

    private get autoFetch(): boolean {
        return vscode.workspace.getConfiguration(EXTENSION).get<boolean>(CONFIG_AUTOFETCH, true);
    }

    private toUri(p: string) {
        return vscode.Uri.file(p);
    }

    private isDisabled() {
        const currBaseRef = BaseRefUtils.getCurrBaseRef();
        return !currBaseRef || currBaseRef.trim().length === 0;
    }

    private subscribeToRepository(repo: Repository) {
        if ((repo as any).__branchCompareSubscribed) {
            return;
        }
        (repo as any).__branchCompareSubscribed = true;

        repo.state.onDidChange(() => this.refresh());
        repo.onDidCheckout?.(() => this.refresh());
        repo.onDidCommit?.(() => this.refresh());
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
            tooltip: `Changes vs ${BaseRefUtils.getCurrBaseRef()}`,
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
            let baseRef = BaseRefUtils.getCurrBaseRef();

            // Handle special branch origin comparison
            if (baseRef === '__branch_origin__') {
                const currentBranch = repo.state.HEAD;
                if (currentBranch?.name) {
                    const divergencePoint = await this.findCurrentBranchCreationPoint(repo, currentBranch.name);
                    if (divergencePoint) {
                        baseRef = divergencePoint;
                    } else {
                        // Fallback to main/master
                        baseRef = await this.findMainDevelopmentBranch(repo) || 'origin/dev';
                    }
                }
            } else if (baseRef === '__main_origin__') {
                // Find and use the main development branch
                baseRef = await this.findMainDevelopmentBranch(repo) || 'origin/dev';
            }

            // Keep base ref fresh (e.g., 'origin/main')
            if (this.autoFetch && baseRef.includes('/')) { //todo Check
                const [remote, ...refParts] = baseRef.split('/');
                const remoteRef = refParts.join('/');
                if (remote && remoteRef) {
                    await repo.fetch(remote, remoteRef).catch(() => { });
                    await new Promise(resolve => setTimeout(resolve, 100)); // wait a bit for the repo to refresh its state
                }
            }

            // If comparing local branch to its origin, find the actual divergence point
            const currentBranch = repo.state.HEAD;
            if (currentBranch?.name && baseRef !== currentBranch.name) {
                const creationPoint = await this.findBranchCreationPoint(repo, currentBranch.name, baseRef);
                if (creationPoint) {
                    baseRef = creationPoint;
                }
            }

            // List file-level changes between base and HEAD
            const changes = await repo.diffBetween(baseRef, 'HEAD');
            await Promise.all(changes.map(change => this.handleChange(change)));
        } catch {
            // Ignore repo errors (non-git folder, detached states, etc.)
        }
    }

    private async findCurrentBranchCreationPoint(repo: Repository, currentBranch: string): Promise<string | null> {
        try {
            // Try to find common ancestor with main branches
            const commonBaseBranches = ['dev', 'develop', 'main', 'master'];

            for (const baseBranch of commonBaseBranches) {
                const candidates = [`origin/${baseBranch}`, baseBranch];

                for (const candidate of candidates) {
                    try {
                        const mergeBase = await repo.getMergeBase(candidate, currentBranch);
                        if (mergeBase) {
                            // Verify this is actually a divergence point, not the current commit
                            const currentCommit = repo.state.HEAD?.commit;
                            if (mergeBase !== currentCommit) {
                                return mergeBase;
                            }
                        }
                    } catch {
                        continue;
                    }
                }
            }

            return null;
        } catch {
            return null;
        }
    }

    private async findMainDevelopmentBranch(repo: Repository): Promise<string | null> {
        try {
            const commonMainBranches = ['dev', 'develop', 'main', 'master'];

            // Get all remote branches
            const remoteBranches = await repo.getBranches({ remote: true }) as Ref[];

            // Look for origin versions of main branches
            for (const branchName of commonMainBranches) {
                const found = remoteBranches.find(ref =>
                    ref.name === `origin/${branchName}`
                );

                if (found) {
                    return found.name!;
                }
            }

            return null;
        } catch {
            return null;
        }
    }

    private async findBranchCreationPoint(repo: Repository, currentBranch: string, targetBaseRef: string): Promise<string | null> {
        try {
            // Find the merge-base between current branch and the target base ref
            // This gives us the commit where the current branch was created from the target branch
            const mergeBase = await repo.getMergeBase(targetBaseRef, currentBranch);

            if (mergeBase) {
                const currentCommit = repo.state.HEAD?.commit;
                // Only use merge-base if it's different from current commit
                // (if they're the same, it means no changes have been made)
                if (mergeBase !== currentCommit) {
                    return mergeBase;
                }
            }

            return null;
        } catch {
            return null;
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
