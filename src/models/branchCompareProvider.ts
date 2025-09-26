import * as vscode from 'vscode';
import * as path from 'path';
import type { API as GitAPI, Repository, Change, Ref } from '../git';
import { Status } from '../git';
import { CONFIG_AUTOFETCH, CONFIG_BASEREFS, EXTENSION } from '../extension';
import { BaseRefUtils } from '../utils/baseRefUtils';
import { GitUtils } from '../utils/gitUtils';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

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

    private repoSubscriptions = new Map<Repository, vscode.Disposable[]>();

    private refreshing = false;
    private refreshQueued = false;
    private refreshDebounce?: NodeJS.Timeout;

    private fetchCooldownMs = 30_000;
    private lastFetchByRepoRef = new Map<string, number>();

    private get autoFetch(): boolean {
        return vscode.workspace.getConfiguration(EXTENSION).get<boolean>(CONFIG_AUTOFETCH, true);
    }

    constructor() {
        // Grab the built-in Git API
        this.git = GitUtils.getGitApi();

        // React to config changes
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration(EXTENSION + '.' + CONFIG_BASEREFS) || e.affectsConfiguration(EXTENSION + '.' + CONFIG_AUTOFETCH)) {
                this.scheduleRefresh();
            }
        });

        // Refresh on typical change triggers
        vscode.workspace.onDidSaveTextDocument(() => this.scheduleRefresh());
        vscode.workspace.onDidCreateFiles(() => this.scheduleRefresh());
        vscode.workspace.onDidDeleteFiles(() => this.scheduleRefresh());
        vscode.workspace.onDidRenameFiles(() => this.scheduleRefresh());

        // Handle existing repositories that were opened before extension activation
        if (this.git) {
            // Subscribe to existing repositories
            if (this.git.repositories.length !== 0) {
                for (const repo of this.git.repositories) {
                    console.log('Branch Compare: Repository found: ' + repo.rootUri.fsPath);
                    this.subscribeToRepository(repo);
                }
                this.scheduleRefresh(); // Initial refresh
            }

            // Subscribe to future repository openings
            this.git.onDidOpenRepository?.((repo: Repository) => {
                console.log('Branch Compare: Repository opened: ' + repo.rootUri.fsPath);
                this.subscribeToRepository(repo);
                this.scheduleRefresh(); // Refresh when new repo is opened
            });

            // Subscribe to repository closings
            this.git.onDidCloseRepository?.((repo: Repository) => {
                console.log('Branch Compare: Repository closed: ' + repo.rootUri.fsPath);
                this.unsubscribeFromRepository(repo);
                this.scheduleRefresh(); // Refresh when repo is closed
            });
        }
    }

    private toUri(p: string) {
        return vscode.Uri.file(p);
    }

    private isDisabled() {
        const currBaseRef = BaseRefUtils.getCurrBaseRef();
        return !currBaseRef || currBaseRef.trim().length === 0;
    }

    private scheduleRefresh(delay = 150) {
        clearTimeout(this.refreshDebounce);
        this.refreshDebounce = setTimeout(() => this.refresh(), delay);
    }

    private subscribeToRepository(repo: Repository) {
        if (this.repoSubscriptions.has(repo)) {
            return;
        }

        const subs: vscode.Disposable[] = [];

        const repoSub = repo.state.onDidChange(() => {
            console.log('Branch Compare: Repository state changed: ' + repo.rootUri.fsPath);
            this.scheduleRefresh();
        });

        if (repoSub) {
            subs.push(repoSub);
        }

        const checkOut = repo.onDidCheckout?.(() => {
            console.log('Branch Compare: Repository checked out: ' + repo.rootUri.fsPath);
            this.scheduleRefresh();
        });
        if (checkOut) {
            subs.push(checkOut);
        }

        const commit = repo.onDidCommit?.(() => {
            console.log('Branch Compare: Repository committed: ' + repo.rootUri.fsPath);
            this.scheduleRefresh();
        });
        if (commit) {
            subs.push(commit);
        }

        this.repoSubscriptions.set(repo, subs);
    }

    private unsubscribeFromRepository(repo: Repository) {
        const subs = this.repoSubscriptions.get(repo);
        if (!subs) {
            return;
        }

        for (const d of subs) {
            try {
                console.log('Branch Compare: Unsubscribing from: ' + repo.rootUri.fsPath);
                d.dispose();
            } catch { }
        }
        this.repoSubscriptions.delete(repo);
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
        if (this.refreshing) {
            this.refreshQueued = true;
            return;
        }
        this.refreshing = true;

        try {
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
        finally {
            this.refreshing = false;
            if (this.refreshQueued) {
                this.refreshQueued = false;
                this.scheduleRefresh(50);
            }
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
            const headName = repo.state.HEAD?.name;
            if (!headName) {
                return;
            }

            let raw: string | null = BaseRefUtils.getCurrBaseRef();
            const upstreamRef = this.getUpstreamRef(repo);

            if (raw === '__branch_origin__') {
                raw = upstreamRef ?? raw;
            }
            if (raw === '__main_origin__') {
                const mainDevBranch = await this.findMainDevelopmentBranch(repo);
                raw = mainDevBranch ?? 'origin/main';
            }

            const sameBranchChosen =
                raw === upstreamRef || raw === headName || raw === repo.state.HEAD?.upstream?.name;

            let baselineSha: string | undefined | null;

            if (sameBranchChosen) {
                // Use mainish bases to find the branch creation point (stable)
                const bases = await this.mainishCandidates(repo);
                baselineSha = await this.pickForkPointFromBases(repo, headName, bases);
            } else if (typeof raw === 'string') {
                // User picked some other branch/ref -> fork-point vs that ref
                baselineSha = await this.forkPointOrMergeBase(repo, raw, headName);
            }

            let compareLeft = baselineSha ?? raw ?? 'origin/main';

            // Keep base ref fresh
            if (this.autoFetch && typeof raw === 'string' && raw.includes('/')) {
                const [remote, ...refParts] = raw.split('/');
                const remoteRef = refParts.join('/');
                if (remote && remoteRef) {
                    const key = `${normFs(repo.rootUri.fsPath)}#${remote}/${remoteRef}`;
                    const now = Date.now();
                    if ((this.lastFetchByRepoRef.get(key) ?? 0) < now - this.fetchCooldownMs) {
                        await repo.fetch(remote, remoteRef).catch(() => { });
                        this.lastFetchByRepoRef.set(key, now);
                    }
                }
            }

            // List file-level changes between base and HEAD
            const changes = await repo.diffBetween(compareLeft, 'HEAD');
            await Promise.all(changes.map(change => this.handleChange(change)));
        } catch {
            // Ignore repo errors (non-git folder, detached states, etc.)
        }
    }

    private getUpstreamRef(repo: Repository): string | undefined {
        const up = repo.state.HEAD?.upstream;
        if (!up?.name) {
            return undefined;
        }
        return up.remote ? `${up.remote}/${up.name}` : up.name;
    }

    private async mainishCandidates(repo: Repository): Promise<string[]> {
        const common = ['origin/main', 'origin/dev', 'origin/develop', 'origin/master', 'main', 'dev', 'develop', 'master'];
        try {
            const remotes = await repo.getBranches({ remote: true }) as Ref[];
            const have = new Set(remotes.map(r => r.name));
            // keep candidates that exist, but also keep locals as fallback
            return common.filter(c => have.has(c) || !c.startsWith('origin/'));
        } catch {
            return common;
        }
    }

    private async commitTimestamp(repo: Repository, sha: string): Promise<number> {
        const cwd = repo.rootUri.fsPath;
        const gitPath = (this.git as any)?.git?.path ?? 'git';
        try {
            const { stdout } = await execFileAsync(gitPath, ['show', '-s', '--format=%ct', sha], { cwd });
            const n = Number(stdout.trim());
            return isNaN(n) ? -1 : n;
        } catch {
            return -1;
        }
    }

    private async pickForkPointFromBases(repo: Repository, branch: string, bases: string[]): Promise<string | null> {
        let bestSha: string | null = null;
        let bestTs = -1;
        for (const base of bases) {
            const sha = await this.forkPointOrMergeBase(repo, base, branch);
            if (!sha) {
                continue;
            }
            const ts = await this.commitTimestamp(repo, sha);
            if (ts > bestTs) {
                bestTs = ts;
                bestSha = sha;
            }
        }
        return bestSha;
    }

    private async forkPointOrMergeBase(repo: Repository, baseRef: string, branch: string): Promise<string | undefined> {
        const cwd = repo.rootUri.fsPath;
        const gitPath = (this.git as any)?.git?.path ?? 'git';

        // Best effort: fork-point
        try {
            const command = ['merge-base', '--fork-point', baseRef, branch].join(' ');
            const { stdout } = await execFileAsync(gitPath, ['merge-base', '--fork-point', baseRef, branch], { cwd });
            const sha = stdout.trim();
            if (sha) {
                return sha;
            }
        } catch { }

        // Fallback: plain merge-base
        try {
            return await repo.getMergeBase(baseRef, branch);
        } catch {
            return undefined;
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
            /* everything else */ 'M';

        const key = normFs(change.uri.fsPath);
        this.changed.set(key, badge);
    }
}
