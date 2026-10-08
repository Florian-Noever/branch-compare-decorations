import * as vscode from 'vscode';
import { Sema } from 'async-sema';
import type { API as GitAPI, Repository } from '../types/git';
import type { ChangeCategory } from '../types/changeCategory';
import { CONFIG_AUTO_FETCH, CONFIG_BASE_REFS, CONFIG_ENABLED, CONFIG_SECTION, FETCH_COOLDOWN_MS, MAX_CONCURRENT_REPOSITORIES, MAX_DECORATION_EVENT_URIS, REFRESH_DEBOUNCE_MS } from '../constants';
import { getBaseRefForBranch } from './baseRefUtils';
import { computeBaseline, describeBaseRef, getUpstreamRef, resolveSpecialBaseRef } from './baselineResolver';
import { CATEGORY_PRESETS, categoryFromStatus } from './changeCategory';
import { areDecorationsEnabled } from './enabledUtils';
import { errorMessage } from './errors';
import { parseRemoteRef } from './gitUtils';
import { Logger } from './logger';
import { getAncestorDirs, normalizeFsPath } from './pathUtils';

interface PathChange {
    category: ChangeCategory;
    /** Describes the base ref of the path's repository */
    tooltip: string;
}

/**
 * Decorates the files that changed between a configurable base ref and HEAD, using the badges and
 * theme colors of the built-in Git decorations. Every repository is compared against the base ref
 * configured for its own current branch.
 */
export class BranchCompareProvider implements vscode.FileDecorationProvider, vscode.Disposable {
    private readonly _onDidChangeFileDecorations = new vscode.EventEmitter<vscode.Uri[] | undefined>();
    readonly onDidChangeFileDecorations = this._onDidChangeFileDecorations.event;

    /** Keyed by the normalized path of every changed file */
    private changedFiles = new Map<string, PathChange>();
    /** Keyed by the normalized path of every folder containing changed files */
    private changedDirs = new Map<string, PathChange>();
    private readonly disposables: vscode.Disposable[] = [this._onDidChangeFileDecorations];
    private readonly repositorySubscriptions = new Map<Repository, vscode.Disposable>();
    /** Latest baseline per normalized repository root */
    private readonly baselineCache = new Map<string, { key: string; baseline: string }>();
    private readonly lastFetchByRef = new Map<string, number>();
    private readonly repositorySema = new Sema(MAX_CONCURRENT_REPOSITORIES);
    /** Failures already logged as a warning, so each problem is reported once instead of on every refresh */
    private readonly reportedFailures = new Set<string>();
    private refreshTimer?: NodeJS.Timeout;
    private currentRefresh?: Promise<void>;
    private queuedRefresh?: Promise<void>;

    constructor(private readonly gitApi: GitAPI) {
        this.disposables.push(
            vscode.workspace.onDidChangeConfiguration(e => {
                if ([CONFIG_ENABLED, CONFIG_BASE_REFS, CONFIG_AUTO_FETCH].some(key => e.affectsConfiguration(`${CONFIG_SECTION}.${key}`))) {
                    this.scheduleRefresh();
                }
            }),
            gitApi.onDidOpenRepository(repository => {
                Logger.info(`Repository opened: ${repository.rootUri.fsPath}`);
                this.subscribeToRepository(repository);
                this.scheduleRefresh();
            }),
            gitApi.onDidCloseRepository(repository => {
                Logger.info(`Repository closed: ${repository.rootUri.fsPath}`);
                this.unsubscribeFromRepository(repository);
                this.baselineCache.delete(normalizeFsPath(repository.rootUri.fsPath));
                this.scheduleRefresh();
            })
        );

        for (const repository of gitApi.repositories) {
            this.subscribeToRepository(repository);
        }
        if (gitApi.repositories.length > 0) {
            this.scheduleRefresh();
        }
    }

    dispose(): void {
        clearTimeout(this.refreshTimer);
        for (const repository of [...this.repositorySubscriptions.keys()]) {
            this.unsubscribeFromRepository(repository);
        }
        for (const disposable of this.disposables) {
            disposable.dispose();
        }
    }

    /** Forgets the cached baselines, e.g. after a base ref was rewritten */
    resetBaselines(): void {
        this.baselineCache.clear();
    }

    provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
        const fsPath = normalizeFsPath(uri.fsPath);
        // VS Code only propagates colors to folders whose children it has rendered, so folders
        // containing changes are decorated explicitly
        const change = this.changedFiles.get(fsPath) ?? this.changedDirs.get(fsPath);
        if (!change) {
            return undefined;
        }

        const { badge, colorKey } = CATEGORY_PRESETS[change.category];
        return {
            badge,
            tooltip: change.tooltip,
            color: new vscode.ThemeColor(colorKey),
            propagate: true,
        };
    }

    /**
     * Recomputes the changes of all repositories and fires decoration events for what changed.
     * Calls made while a refresh runs share one follow-up refresh; the returned promise settles once
     * a refresh that started after the call has finished. Never rejects.
     */
    refresh(): Promise<void> {
        if (!this.currentRefresh) {
            this.currentRefresh = this.runRefresh().finally(() => {
                this.currentRefresh = undefined;
            });
            return this.currentRefresh;
        }
        this.queuedRefresh ??= this.currentRefresh.then(() => {
            this.queuedRefresh = undefined;
            return this.refresh();
        });
        return this.queuedRefresh;
    }

    private async runRefresh(): Promise<void> {
        try {
            const previousFiles = this.changedFiles;
            const rootPaths = this.getRootPaths();
            this.changedFiles = areDecorationsEnabled() ? await this.computeChanges() : new Map();
            this.changedDirs = this.collectChangedDirs(rootPaths);
            this.fireDecorationChanges(previousFiles, rootPaths);
        } catch (e) {
            Logger.error(`Failed to refresh decorations: ${errorMessage(e)}`);
        }
    }

    private scheduleRefresh(delay = REFRESH_DEBOUNCE_MS): void {
        clearTimeout(this.refreshTimer);
        this.refreshTimer = setTimeout(() => void this.refresh(), delay);
    }

    private subscribeToRepository(repository: Repository): void {
        if (this.repositorySubscriptions.has(repository)) {
            return;
        }
        // Fires after every `git status`, so it covers commits, checkouts and fetches from any source
        this.repositorySubscriptions.set(repository, repository.state.onDidChange(() => this.scheduleRefresh()));
    }

    private unsubscribeFromRepository(repository: Repository): void {
        this.repositorySubscriptions.get(repository)?.dispose();
        this.repositorySubscriptions.delete(repository);
    }

    private fireDecorationChanges(previousFiles: Map<string, PathChange>, rootPaths: string[]): void {
        const impactedFiles = new Set<string>();
        for (const [filePath, change] of this.changedFiles) {
            const previous = previousFiles.get(filePath);
            if (previous?.category !== change.category || previous.tooltip !== change.tooltip) {
                impactedFiles.add(filePath);
            }
        }
        for (const filePath of previousFiles.keys()) {
            if (!this.changedFiles.has(filePath)) {
                impactedFiles.add(filePath);
            }
        }

        const impactedPaths = new Set(impactedFiles);
        for (const filePath of impactedFiles) {
            for (const dirPath of getAncestorDirs(filePath, rootPaths)) {
                impactedPaths.add(dirPath);
            }
        }

        if (impactedPaths.size === 0) {
            return;
        }
        if (impactedPaths.size > MAX_DECORATION_EVENT_URIS) {
            Logger.debug(`${impactedPaths.size} decorations changed, refreshing all`);
            this._onDidChangeFileDecorations.fire(undefined);
            return;
        }
        this._onDidChangeFileDecorations.fire([...impactedPaths].map(fsPath => vscode.Uri.file(fsPath)));
    }

    /** Folders whose descendants can be decorated: workspace folders and repository roots */
    private getRootPaths(): string[] {
        return [
            ...(vscode.workspace.workspaceFolders ?? []).map(folder => folder.uri.fsPath),
            ...this.gitApi.repositories.map(repository => repository.rootUri.fsPath),
        ].map(normalizeFsPath);
    }

    private collectChangedDirs(rootPaths: string[]): Map<string, PathChange> {
        const changedDirs = new Map<string, PathChange>();
        for (const [filePath, { tooltip }] of this.changedFiles) {
            for (const dirPath of getAncestorDirs(filePath, rootPaths)) {
                if (changedDirs.has(dirPath)) {
                    break; // Its ancestors were added along with it
                }
                changedDirs.set(dirPath, { category: 'modified', tooltip });
            }
        }
        return changedDirs;
    }

    private async computeChanges(): Promise<Map<string, PathChange>> {
        const changedFiles = new Map<string, PathChange>();
        await Promise.all(this.gitApi.repositories.map(async repository => {
            await this.repositorySema.acquire();
            try {
                await this.collectChanges(repository, changedFiles);
            } catch (e) {
                // A broken base ref in one repository must not hide the decorations of the others
                this.reportFailure(`No decorations for ${repository.rootUri.fsPath}: ${errorMessage(e)}`);
            } finally {
                this.repositorySema.release();
            }
        }));

        Logger.debug(`Found ${changedFiles.size} changed files`);
        return changedFiles;
    }

    private reportFailure(message: string): void {
        if (this.reportedFailures.has(message)) {
            Logger.debug(message);
            return;
        }
        this.reportedFailures.add(message);
        Logger.warn(message);
    }

    private async collectChanges(repository: Repository, changedFiles: Map<string, PathChange>): Promise<void> {
        const branchName = repository.state.HEAD?.name;
        if (!branchName) {
            return; // Detached HEAD
        }
        const configuredRef = getBaseRefForBranch(branchName).trim();
        if (!configuredRef) {
            return; // Not configured, or disabled for this branch
        }

        const upstreamRef = getUpstreamRef(repository);
        const baseRef = await resolveSpecialBaseRef(repository, configuredRef, upstreamRef);

        // Fetch first, so the baseline is computed from up-to-date refs
        await this.autoFetch(repository, baseRef);

        const baseline = await this.getBaseline(repository, branchName, baseRef, upstreamRef);
        Logger.debug(`Computing diff ${baseline}..HEAD in ${repository.rootUri.fsPath}`);
        const tooltip = describeBaseRef(configuredRef, baseRef);
        for (const change of await repository.diffBetween(baseline, 'HEAD')) {
            changedFiles.set(normalizeFsPath(change.uri.fsPath), { category: categoryFromStatus(change.status), tooltip });
        }
    }

    /**
     * The fork-point search costs two git calls per candidate branch, so its result is cached. A base
     * ref moving forward doesn't change where HEAD forked from it, so HEAD is enough to key the cache;
     * resetBaselines() covers rewritten base refs.
     */
    private async getBaseline(repository: Repository, branchName: string, baseRef: string, upstreamRef: string | undefined): Promise<string> {
        const rootPath = normalizeFsPath(repository.rootUri.fsPath);
        const key = [repository.state.HEAD?.commit, branchName, baseRef, upstreamRef].join('|');
        const cached = this.baselineCache.get(rootPath);
        if (cached?.key === key) {
            return cached.baseline;
        }

        const baseline = await computeBaseline(this.gitApi, repository, branchName, baseRef, upstreamRef);
        this.baselineCache.set(rootPath, { key, baseline });
        return baseline;
    }

    private async autoFetch(repository: Repository, baseRef: string): Promise<void> {
        if (!vscode.workspace.getConfiguration(CONFIG_SECTION).get<boolean>(CONFIG_AUTO_FETCH, true)) {
            return;
        }
        const remoteRef = parseRemoteRef(baseRef, repository.state.remotes.map(remote => remote.name));
        if (!remoteRef) {
            return; // A local branch, tag or commit: nothing to fetch
        }

        const fetchKey = `${normalizeFsPath(repository.rootUri.fsPath)}#${baseRef}`;
        const now = Date.now();
        if (now - (this.lastFetchByRef.get(fetchKey) ?? 0) < FETCH_COOLDOWN_MS) {
            return;
        }
        // Recorded before fetching so that failures (e.g. while offline) are throttled too
        this.lastFetchByRef.set(fetchKey, now);

        try {
            await repository.fetch(remoteRef.remote, remoteRef.branch);
            Logger.info(`Fetched ${baseRef}`);
        } catch (e) {
            Logger.warn(`Failed to fetch ${baseRef}: ${errorMessage(e)}`);
        }
    }
}
