import * as vscode from 'vscode';
import * as path from 'path';
import { Sema } from 'async-sema';
import type { API as GitAPI, Repository } from '../types/git';
import type { ChangeCategory } from '../types/changeCategory';
import { CONFIG_AUTO_FETCH, CONFIG_BASE_REFS, CONFIG_SECTION, FETCH_COOLDOWN_MS, MAX_CONCURRENT_REPOSITORIES, MAX_DECORATION_EVENT_URIS, QUEUED_REFRESH_DELAY_MS, REFRESH_DEBOUNCE_MS } from '../constants';
import { getCurrentBaseRef } from './baseRefUtils';
import { computeBaseline, getUpstreamRef, resolveSpecialBaseRef } from './baselineResolver';
import { CATEGORY_PRESETS, categoryFromStatus } from './changeCategory';
import { errorMessage } from './errors';
import { Logger } from './logger';
import { normalizeFsPath } from './pathUtils';

/**
 * Decorates the files that changed between a configurable base ref and HEAD, using the badges and
 * theme colors of the built-in Git decorations.
 */
export class BranchCompareProvider implements vscode.FileDecorationProvider, vscode.Disposable {
    private readonly _onDidChangeFileDecorations = new vscode.EventEmitter<vscode.Uri[] | undefined>();
    readonly onDidChangeFileDecorations = this._onDidChangeFileDecorations.event;

    /** Normalized path of every changed file */
    private changedFiles = new Map<string, ChangeCategory>();
    private readonly disposables: vscode.Disposable[] = [this._onDidChangeFileDecorations];
    private readonly repositorySubscriptions = new Map<Repository, vscode.Disposable[]>();
    private readonly baselineCache = new Map<string, string>();
    private readonly lastFetchByRef = new Map<string, number>();
    private readonly repositorySema = new Sema(MAX_CONCURRENT_REPOSITORIES);
    private refreshTimer?: NodeJS.Timeout;
    private isRefreshing = false;
    private isRefreshQueued = false;

    constructor(private readonly gitApi: GitAPI) {
        this.disposables.push(
            vscode.workspace.onDidChangeConfiguration(e => {
                if (e.affectsConfiguration(`${CONFIG_SECTION}.${CONFIG_BASE_REFS}`) || e.affectsConfiguration(`${CONFIG_SECTION}.${CONFIG_AUTO_FETCH}`)) {
                    this.scheduleRefresh();
                }
            }),
            vscode.workspace.onDidSaveTextDocument(() => this.scheduleRefresh()),
            vscode.workspace.onDidCreateFiles(() => this.scheduleRefresh()),
            vscode.workspace.onDidDeleteFiles(() => this.scheduleRefresh()),
            vscode.workspace.onDidRenameFiles(() => this.scheduleRefresh()),
            gitApi.onDidOpenRepository(repository => {
                Logger.info(`Repository opened: ${repository.rootUri.fsPath}`);
                this.subscribeToRepository(repository);
                this.scheduleRefresh();
            }),
            gitApi.onDidCloseRepository(repository => {
                Logger.info(`Repository closed: ${repository.rootUri.fsPath}`);
                this.unsubscribeFromRepository(repository);
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

    provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
        const baseRef = getCurrentBaseRef(this.gitApi);
        if (!baseRef.trim()) {
            return undefined;
        }

        const filePath = normalizeFsPath(uri.fsPath);
        let category = this.changedFiles.get(filePath);
        if (!category) {
            // VS Code only propagates colors to folders whose children it has rendered, so folders
            // containing changes are decorated explicitly
            const containsChanges = [...this.changedFiles.keys()].some(changedFile => changedFile.startsWith(filePath));
            if (!containsChanges) {
                return undefined;
            }
            category = 'modified';
        }

        const { badge, colorKey } = CATEGORY_PRESETS[category];
        return {
            badge,
            tooltip: `Changes vs ${baseRef}`,
            color: new vscode.ThemeColor(colorKey),
            propagate: true,
        };
    }

    /** Recomputes the changes of all repositories and fires decoration events for what changed */
    async refresh(): Promise<void> {
        if (this.isRefreshing) {
            this.isRefreshQueued = true;
            return;
        }

        this.isRefreshing = true;
        try {
            const previousFiles = new Set(this.changedFiles.keys());
            this.changedFiles = await this.computeChanges();
            this.fireDecorationChanges(previousFiles);
        } finally {
            this.isRefreshing = false;
            if (this.isRefreshQueued) {
                this.isRefreshQueued = false;
                this.scheduleRefresh(QUEUED_REFRESH_DELAY_MS);
            }
        }
    }

    private scheduleRefresh(delay = REFRESH_DEBOUNCE_MS): void {
        clearTimeout(this.refreshTimer);
        this.refreshTimer = setTimeout(() => this.refresh(), delay);
    }

    private subscribeToRepository(repository: Repository): void {
        if (this.repositorySubscriptions.has(repository)) {
            return;
        }
        const onRepositoryChange = () => {
            this.invalidateBaselines(repository);
            this.scheduleRefresh();
        };
        this.repositorySubscriptions.set(repository, [
            repository.state.onDidChange(onRepositoryChange),
            repository.onDidCheckout(onRepositoryChange),
            repository.onDidCommit(onRepositoryChange),
        ]);
    }

    private unsubscribeFromRepository(repository: Repository): void {
        for (const subscription of this.repositorySubscriptions.get(repository) ?? []) {
            subscription.dispose();
        }
        this.repositorySubscriptions.delete(repository);
    }

    private fireDecorationChanges(previousFiles: Set<string>): void {
        const impactedFiles = new Set<string>();
        for (const filePath of this.changedFiles.keys()) {
            if (!previousFiles.has(filePath)) {
                impactedFiles.add(filePath);
            }
        }
        for (const filePath of previousFiles) {
            if (!this.changedFiles.has(filePath)) {
                impactedFiles.add(filePath);
            }
        }

        const uris: vscode.Uri[] = [];
        for (const filePath of impactedFiles) {
            uris.push(vscode.Uri.file(filePath));
            for (const dirPath of this.getParentDirsWithinWorkspace(filePath)) {
                uris.push(vscode.Uri.file(dirPath));
            }
        }

        if (uris.length === 0 || uris.length > MAX_DECORATION_EVENT_URIS) {
            this._onDidChangeFileDecorations.fire(undefined);
        } else {
            this._onDidChangeFileDecorations.fire(uris);
        }
    }

    private getParentDirsWithinWorkspace(filePath: string): string[] {
        const dirPaths: string[] = [];
        for (const folder of vscode.workspace.workspaceFolders ?? []) {
            const rootPath = normalizeFsPath(folder.uri.fsPath);
            if (!filePath.startsWith(rootPath)) {
                continue;
            }
            let dirPath = path.dirname(filePath);
            while (dirPath.length > rootPath.length) {
                dirPaths.push(dirPath);
                const parentPath = path.dirname(dirPath);
                if (parentPath === dirPath) {
                    break;
                }
                dirPath = parentPath;
            }
        }
        return dirPaths;
    }

    private async computeChanges(): Promise<Map<string, ChangeCategory>> {
        const changedFiles = new Map<string, ChangeCategory>();
        if (!getCurrentBaseRef(this.gitApi).trim()) {
            return changedFiles;
        }

        await Promise.all(this.getWorkspaceRepositories().map(async repository => {
            await this.repositorySema.acquire();
            try {
                await this.collectChanges(repository, changedFiles);
            } finally {
                this.repositorySema.release();
            }
        }));

        Logger.info(`Found ${changedFiles.size} changed files`);
        return changedFiles;
    }

    private getWorkspaceRepositories(): Repository[] {
        const repositoriesByRoot = new Map<string, Repository>();
        for (const folder of vscode.workspace.workspaceFolders ?? []) {
            const repository = this.findRepositoryForFolder(folder);
            if (repository) {
                repositoriesByRoot.set(normalizeFsPath(repository.rootUri.fsPath), repository);
            }
        }
        return [...repositoriesByRoot.values()];
    }

    private findRepositoryForFolder(folder: vscode.WorkspaceFolder): Repository | undefined {
        const repository = this.gitApi.getRepository(folder.uri);
        if (repository) {
            return repository;
        }
        const folderPath = normalizeFsPath(folder.uri.fsPath);
        return this.gitApi.repositories.find(candidate => folderPath.startsWith(normalizeFsPath(candidate.rootUri.fsPath)));
    }

    private async collectChanges(repository: Repository, changedFiles: Map<string, ChangeCategory>): Promise<void> {
        const branchName = repository.state.HEAD?.name;
        if (!branchName) {
            return;
        }

        const upstreamRef = getUpstreamRef(repository);
        const baseRef = await resolveSpecialBaseRef(repository, getCurrentBaseRef(this.gitApi), upstreamRef);

        // Fetch first, so the baseline is computed from up-to-date refs
        await this.autoFetch(repository, baseRef);

        const baseline = await this.getBaseline(repository, branchName, baseRef, upstreamRef);
        Logger.debug(`Computing diff ${baseline}..HEAD in ${repository.rootUri.fsPath}`);
        for (const change of await repository.diffBetween(baseline, 'HEAD')) {
            changedFiles.set(normalizeFsPath(change.uri.fsPath), categoryFromStatus(change.status));
        }
    }

    private async getBaseline(repository: Repository, branchName: string, baseRef: string, upstreamRef: string | undefined): Promise<string> {
        const cacheKey = [normalizeFsPath(repository.rootUri.fsPath), repository.state.HEAD?.commit ?? '', baseRef, upstreamRef ?? ''].join('|');
        let baseline = this.baselineCache.get(cacheKey);
        if (!baseline) {
            baseline = await computeBaseline(this.gitApi, repository, branchName, baseRef, upstreamRef);
            this.baselineCache.set(cacheKey, baseline);
        }
        return baseline;
    }

    private invalidateBaselines(repository: Repository): void {
        const keyPrefix = `${normalizeFsPath(repository.rootUri.fsPath)}|`;
        for (const cacheKey of [...this.baselineCache.keys()]) {
            if (cacheKey.startsWith(keyPrefix)) {
                this.baselineCache.delete(cacheKey);
            }
        }
    }

    private async autoFetch(repository: Repository, baseRef: string): Promise<void> {
        const autoFetchEnabled = vscode.workspace.getConfiguration(CONFIG_SECTION).get<boolean>(CONFIG_AUTO_FETCH, true);
        if (!autoFetchEnabled || !baseRef.includes('/')) {
            return;
        }

        const [remote, ...refParts] = baseRef.split('/');
        const ref = refParts.join('/');
        if (!remote || !ref) {
            return;
        }

        const fetchKey = `${normalizeFsPath(repository.rootUri.fsPath)}#${remote}/${ref}`;
        const now = Date.now();
        if (now - (this.lastFetchByRef.get(fetchKey) ?? 0) < FETCH_COOLDOWN_MS) {
            return;
        }

        try {
            await repository.fetch(remote, ref);
            this.lastFetchByRef.set(fetchKey, now);
            Logger.info(`Fetched ${remote}/${ref}`);
        } catch (e) {
            Logger.error(`Failed to fetch ${remote}/${ref}: ${errorMessage(e)}`);
        }
    }
}
