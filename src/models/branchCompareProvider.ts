import * as vscode from 'vscode';
import * as path from 'path';
import type { API as GitAPI, Repository, Change, Ref } from '../git';
import { Status } from '../git';
import { CONFIG_AUTOFETCH, CONFIG_BASEREFS, EXTENSION, log } from '../extension';
import { BaseRefUtils } from '../utils/baseRefUtils';
import { GitUtils } from '../utils/gitUtils';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { Sema } from 'async-sema';

const execFileAsync = promisify(execFile);

const isWindows = process.platform === 'win32';
const normFs = (p: string) => {
    const abs = path.resolve(p);
    return isWindows ? abs.toLowerCase() : abs;
};

const CATEGORY_PRESETS: Record<ChangeCategory, { badge: string; colorKey: GitDecorationColorKey }> = {
    added: { badge: 'A', colorKey: 'gitDecoration.addedResourceForeground' },
    modified: { badge: 'M', colorKey: 'gitDecoration.modifiedResourceForeground' },
    deleted: { badge: 'D', colorKey: 'gitDecoration.deletedResourceForeground' },
    renamed: { badge: 'R', colorKey: 'gitDecoration.renamedResourceForeground' },
    conflicted: { badge: 'U', colorKey: 'gitDecoration.conflictingResourceForeground' },
    untracked: { badge: '?', colorKey: 'gitDecoration.untrackedResourceForeground' },
    ignored: { badge: '!', colorKey: 'gitDecoration.ignoredResourceForeground' },
    copied: { badge: 'C', colorKey: 'gitDecoration.modifiedResourceForeground' }, // closest fit
};

const STATUS_PRESETS: Partial<Record<Status, ChangeCategory>> = {
    // Index changes
    [Status.INDEX_ADDED]: 'added',
    [Status.INDEX_MODIFIED]: 'modified',
    [Status.INDEX_DELETED]: 'deleted',
    [Status.INDEX_RENAMED]: 'renamed',
    [Status.INDEX_COPIED]: 'copied',

    // Working tree changes
    [Status.MODIFIED]: 'modified',
    [Status.DELETED]: 'deleted',
    [Status.UNTRACKED]: 'untracked',
    [Status.IGNORED]: 'ignored',
    [Status.INTENT_TO_ADD]: 'untracked',
    [Status.TYPE_CHANGED]: 'modified',

    // Merge/conflict states
    [Status.ADDED_BY_US]: 'conflicted',
    [Status.ADDED_BY_THEM]: 'conflicted',
    [Status.DELETED_BY_US]: 'conflicted',
    [Status.DELETED_BY_THEM]: 'conflicted',
    [Status.BOTH_ADDED]: 'conflicted',
    [Status.BOTH_DELETED]: 'conflicted',
    [Status.BOTH_MODIFIED]: 'conflicted',
};

/**
 * Provides file decorations to indicate changes between the current branch and a base reference.
 *
 * This class implements the VS Code FileDecorationProvider interface to visually highlight files
 * that have been added, modified, deleted, or renamed compared to a configurable base branch.
 * It integrates with VS Code's Git API to analyze repository changes and automatically updates
 * decorations when files or repository state changes.
 *
 * Key features:
 * - Compares current branch against configurable base references (origin, main, custom)
 * - Provides visual badges (A/M/D/R) and colors for different change types
 * - Supports multiple repositories and workspace folders
 * - Automatically fetches remote references when needed
 * - Handles complex scenarios like fork-points and merge-bases
 */
export class BranchCompareProvider implements vscode.FileDecorationProvider {
    // ============================================================================
    // PRIVATE PROPERTIES
    // ============================================================================

    /** Map of file paths to their change category (A/M/D/R) */
    private readonly changedFiles = new Map<string, ChangeCategory>();

    /** Set of file paths that had changes in the previous refresh cycle */
    private readonly lastChangedKeys = new Set<string>();

    /** Event emitter for file decoration changes */
    private readonly _onDidChangeDecorations = new vscode.EventEmitter<vscode.Uri[] | undefined>();

    /** Public event for VS Code to subscribe to decoration changes */
    public readonly onDidChangeFileDecorations = this._onDidChangeDecorations.event;

    /** Reference to VS Code's Git API */
    private readonly gitApi?: GitAPI;

    /** Map of repository subscriptions for cleanup */
    private readonly repositorySubscriptions = new Map<Repository, vscode.Disposable[]>();

    /** Flag to prevent concurrent refresh operations */
    private isCurrentlyRefreshing = false;

    /** Flag indicating a refresh is queued while another is running */
    private isRefreshQueued = false;

    /** Timer handle for debounced refresh operations */
    private refreshDebounceTimer?: NodeJS.Timeout;

    /** Cooldown period between fetches for the same remote reference (30 seconds) */
    private readonly fetchCooldownMilliseconds = 30_000;

    /** Semaphore to limit concurrent processing of workspace folders */
    private readonly folderSema = new Sema(3);

    /** Map tracking the last fetch time for each repository and remote reference */
    private readonly lastFetchTimestampByRepoRef = new Map<string, number>();

    /** Map tracking the last known baseline for each repository */
    private readonly baselineCache = new Map<string, string | null>();

    /** Gets the auto-fetch configuration setting */
    private get shouldAutoFetch(): boolean {
        return vscode.workspace.getConfiguration(EXTENSION).get<boolean>(CONFIG_AUTOFETCH, true);
    }

    // ============================================================================
    // CONSTRUCTOR
    // ============================================================================

    /**
     * Initializes the BranchCompareProvider with Git API integration and event subscriptions.
     *
     * Sets up:
     * - Git API connection
     * - Configuration change listeners
     * - Workspace file change listeners
     * - Repository event subscriptions
     */
    constructor() {
        log.info('[BranchCompareProvider] Initializing provider');

        // Initialize Git API connection
        this.gitApi = GitUtils.getGitApi();
        if (!this.gitApi) {
            log.warn('[BranchCompareProvider] Git API not available - decorations will be disabled');
        } else {
            log.info('[BranchCompareProvider] Git API connected successfully');
        }

        this.setupConfigurationListeners();
        this.setupWorkspaceListeners();
        this.setupRepositoryHandling();

        log.info('[BranchCompareProvider] Provider initialization completed');
    }

    // ============================================================================
    // INITIALIZATION HELPERS
    // ============================================================================

    /**
     * Sets up listeners for configuration changes that affect the provider.
     */
    private setupConfigurationListeners(): void {
        vscode.workspace.onDidChangeConfiguration(configChangeEvent => {
            const affectsBaseRefs = configChangeEvent.affectsConfiguration(`${EXTENSION}.${CONFIG_BASEREFS}`);
            const affectsAutoFetch = configChangeEvent.affectsConfiguration(`${EXTENSION}.${CONFIG_AUTOFETCH}`);

            if (affectsBaseRefs || affectsAutoFetch) {
                log.debug('[BranchCompareProvider] Configuration changed, scheduling refresh', {
                    baseRefs: affectsBaseRefs,
                    autoFetch: affectsAutoFetch
                });
                this.scheduleRefresh();
            }
        });
    }

    /**
     * Sets up listeners for workspace file system changes.
     */
    private setupWorkspaceListeners(): void {
        // Refresh decorations when files change
        vscode.workspace.onDidSaveTextDocument(() => {
            log.debug('[BranchCompareProvider] Document saved, scheduling refresh');
            this.scheduleRefresh();
        });

        vscode.workspace.onDidCreateFiles(() => {
            log.debug('[BranchCompareProvider] Files created, scheduling refresh');
            this.scheduleRefresh();
        });

        vscode.workspace.onDidDeleteFiles(() => {
            log.debug('[BranchCompareProvider] Files deleted, scheduling refresh');
            this.scheduleRefresh();
        });

        vscode.workspace.onDidRenameFiles(() => {
            log.debug('[BranchCompareProvider] Files renamed, scheduling refresh');
            this.scheduleRefresh();
        });
    }

    /**
     * Sets up handling for existing and future Git repositories.
     */
    private setupRepositoryHandling(): void {
        if (!this.gitApi) {
            return;
        }

        // Handle existing repositories
        if (this.gitApi.repositories.length > 0) {
            log.debug(`[BranchCompareProvider] Found ${this.gitApi.repositories.length} existing repositories`);

            for (const repository of this.gitApi.repositories) {
                log.debug(`[BranchCompareProvider] Subscribing to existing repository: ${repository.rootUri.fsPath}`);
                this.subscribeToRepository(repository);
            }

            this.scheduleRefresh(); // Initial refresh for existing repositories
        }

        // Handle future repository openings
        this.gitApi.onDidOpenRepository?.((repository: Repository) => {
            log.info(`[BranchCompareProvider] New repository opened: ${repository.rootUri.fsPath}`);
            this.subscribeToRepository(repository);
            this.scheduleRefresh();
        });

        // Handle repository closings
        this.gitApi.onDidCloseRepository?.((repository: Repository) => {
            log.info(`[BranchCompareProvider] Repository closed: ${repository.rootUri.fsPath}`);
            this.unsubscribeFromRepository(repository);
            this.scheduleRefresh();
        });
    }

    // ============================================================================
    // UTILITY METHODS
    // ============================================================================

    /**
     * Converts a file system path to a VS Code URI.
     *
     * @param filePath - The absolute file system path
     * @returns VS Code URI for the file
     */
    private convertPathToUri(filePath: string): vscode.Uri {
        return vscode.Uri.file(filePath);
    }

    /**
     * Checks if the provider is disabled based on current configuration.
     *
     * @returns True if no base reference is configured or the configuration is empty
     */
    private isProviderDisabled(): boolean {
        const currentBaseReference = BaseRefUtils.getCurrBaseRef();
        const isDisabled = !currentBaseReference || currentBaseReference.trim().length === 0;

        if (isDisabled) {
            log.debug('[BranchCompareProvider] Provider is disabled - no base reference configured');
        }

        return isDisabled;
    }

    /**
     * Creates a cache key for the baseline comparison.
     *
     * @param repo - The Git repository
     * @param headSha - The SHA of the HEAD commit
     * @param baseRef - The base reference (branch or commit) for comparison
     * @param upstreamRef - The upstream reference (branch or commit) for comparison
     * @returns A unique cache key for the baseline comparison
     */
    private makeBaselineCacheKey(repo: Repository, headSha: string, baseRef: string | null, upstreamRef: string | undefined): string {
        return `${normFs(repo.rootUri.fsPath)}|${headSha}|${baseRef ?? ''}|${upstreamRef ?? ''}`;
    }

    /**
     * Invalidates all cached baseline comparisons for the specified repository.
     *
     * @param repo - The Git repository
     */
    private invalidateRepoCaches(repo: Repository) {
        const keyPrefix = `${normFs(repo.rootUri.fsPath)}|`;
        for (const key of [...this.baselineCache.keys()]) {
            if (key.startsWith(keyPrefix)) {
                this.baselineCache.delete(key);
            }
        }
    }

    // ============================================================================
    // REFRESH MANAGEMENT
    // ============================================================================

    /**
     * Schedules a debounced refresh operation to avoid excessive updates.
     *
     * @param delayMilliseconds - Delay before executing the refresh (default: 150ms)
     */
    private scheduleRefresh(delayMilliseconds = 150): void {
        log.trace(`[BranchCompareProvider] Scheduling refresh with ${delayMilliseconds}ms delay`);

        clearTimeout(this.refreshDebounceTimer);
        this.refreshDebounceTimer = setTimeout(() => this.refresh(), delayMilliseconds);
    }

    // ============================================================================
    // REPOSITORY SUBSCRIPTION MANAGEMENT
    // ============================================================================

    /**
     * Subscribes to repository events to automatically refresh decorations when changes occur.
     *
     * @param repository - The Git repository to subscribe to
     */
    private subscribeToRepository(repository: Repository): void {
        if (this.repositorySubscriptions.has(repository)) {
            log.debug(`[BranchCompareProvider] Already subscribed to repository: ${repository.rootUri.fsPath}`);
            return;
        }

        log.debug(`[BranchCompareProvider] Setting up subscriptions for repository: ${repository.rootUri.fsPath}`);
        const subscriptions: vscode.Disposable[] = [];

        // Subscribe to repository state changes
        const stateSubscription = repository.state.onDidChange(() => {
            log.trace(`[BranchCompareProvider] Repository state changed: ${repository.rootUri.fsPath}`);
            this.invalidateRepoCaches(repository);
            this.scheduleRefresh();
        });

        if (stateSubscription) {
            subscriptions.push(stateSubscription);
        }

        // Subscribe to checkout events (branch switches)
        const checkoutSubscription = repository.onDidCheckout?.(() => {
            log.debug(`[BranchCompareProvider] Repository checkout detected: ${repository.rootUri.fsPath}`);
            this.invalidateRepoCaches(repository);
            this.scheduleRefresh();
        });
        if (checkoutSubscription) {
            subscriptions.push(checkoutSubscription);
        }

        // Subscribe to commit events
        const commitSubscription = repository.onDidCommit?.(() => {
            log.debug(`[BranchCompareProvider] Repository commit detected: ${repository.rootUri.fsPath}`);
            this.invalidateRepoCaches(repository);
            this.scheduleRefresh();
        });
        if (commitSubscription) {
            subscriptions.push(commitSubscription);
        }

        this.repositorySubscriptions.set(repository, subscriptions);
        log.debug(`[BranchCompareProvider] Set up ${subscriptions.length} subscriptions for repository`);
    }

    /**
     * Unsubscribes from repository events and cleans up resources.
     *
     * @param repository - The Git repository to unsubscribe from
     */
    private unsubscribeFromRepository(repository: Repository): void {
        const subscriptions = this.repositorySubscriptions.get(repository);
        if (!subscriptions) {
            log.debug(`[BranchCompareProvider] No subscriptions found for repository: ${repository.rootUri.fsPath}`);
            return;
        }

        log.debug(`[BranchCompareProvider] Cleaning up ${subscriptions.length} subscriptions for repository: ${repository.rootUri.fsPath}`);

        for (const subscription of subscriptions) {
            try {
                subscription.dispose();
            } catch (error) {
                log.warn(`[BranchCompareProvider] Error disposing subscription:`, error);
            }
        }

        this.repositorySubscriptions.delete(repository);
        log.debug(`[BranchCompareProvider] Successfully unsubscribed from repository: ${repository.rootUri.fsPath}`);
    }


    /**
     * Gets all parent directories of a file path that are within workspace folders.
     * Used for decoration propagation to parent directories.
     *
     * @param absolutePath - The absolute file system path
     * @returns Array of URIs for parent directories within workspace folders
     */
    private getParentDirectoriesWithinWorkspace(absolutePath: string): vscode.Uri[] {
        const parentUris: vscode.Uri[] = [];
        const workspaceFolders = vscode.workspace.workspaceFolders ?? [];
        const normalizedFilePath = isWindows ? absolutePath.toLowerCase() : absolutePath;

        for (const workspaceFolder of workspaceFolders) {
            const workspaceRoot = normFs(workspaceFolder.uri.fsPath);

            // Skip if file is not within this workspace folder
            if (!normalizedFilePath.startsWith(workspaceRoot)) {
                continue;
            }

            // Walk up the directory tree within the workspace
            let currentPath = path.dirname(normalizedFilePath);
            while (currentPath.length > workspaceRoot.length) {
                parentUris.push(this.convertPathToUri(currentPath));

                const parentPath = path.dirname(currentPath);
                if (parentPath === currentPath) {
                    break; // Reached root directory
                }
                currentPath = parentPath;
            }
        }

        return parentUris;
    }

    /**
     * Forces a refresh of all file decorations.
     *
     * Computes changes for all workspace folders and updates decorations accordingly.
     * Uses a queuing mechanism to prevent concurrent refresh operations.
     *
     * @public - Can be called externally to force decoration updates
     */
    public async refresh(): Promise<void> {
        if (this.isCurrentlyRefreshing) {
            log.trace('[BranchCompareProvider] Refresh already in progress, queuing new refresh');
            this.isRefreshQueued = true;
            return;
        }

        log.debug('[BranchCompareProvider] Starting refresh cycle');
        this.isCurrentlyRefreshing = true;

        try {
            // Track what files were changed before this refresh
            const previouslyChangedFiles = new Set(this.lastChangedKeys);

            // Compute current changes across all workspace folders
            await this.computeAllWorkspaceChanges();

            // Determine which files have new or removed changes
            const currentlyChangedFiles = new Set(this.changedFiles.keys());
            const impactedFilePaths = new Set<string>();

            // Files that are newly changed
            for (const filePath of currentlyChangedFiles) {
                if (!previouslyChangedFiles.has(filePath)) {
                    impactedFilePaths.add(filePath);
                }
            }

            // Files that are no longer changed
            for (const filePath of previouslyChangedFiles) {
                if (!currentlyChangedFiles.has(filePath)) {
                    impactedFilePaths.add(filePath);
                }
            }

            // Convert impacted files to URIs and include parent directories for propagation
            const impactedUris: vscode.Uri[] = [];
            for (const filePath of impactedFilePaths) {
                const uri = this.convertPathToUri(filePath);
                impactedUris.push(uri);

                // Add parent directories within workspace for decoration propagation
                for (const parentUri of this.getParentDirectoriesWithinWorkspace(filePath)) {
                    impactedUris.push(parentUri);
                }
            }

            // Fire decoration change events
            if (impactedUris.length === 0 || impactedUris.length > 500) {
                log.trace('[BranchCompareProvider] No decoration changes detected');
                this._onDidChangeDecorations.fire(undefined);
            } else {
                log.debug(`[BranchCompareProvider] Firing decoration changes for ${impactedUris.length} URIs`);

                const alFilesChanged = impactedUris.filter(uri => uri.fsPath.endsWith('.al'));

                if (alFilesChanged.length !== 0) {
                    log.debug(`[BranchCompareProvider] AL file changes detected`);
                }

                this._onDidChangeDecorations.fire(impactedUris);
            }
        }
        finally {
            this.isCurrentlyRefreshing = false;

            // Process queued refresh if one was requested during this cycle
            if (this.isRefreshQueued) {
                log.trace('[BranchCompareProvider] Processing queued refresh');
                this.isRefreshQueued = false;
                this.scheduleRefresh(50); // Short delay for queued refresh
            }
        }
    }

    // ============================================================================
    // FILE DECORATION PROVIDER INTERFACE
    // ============================================================================

    /**
     * Provides file decoration for a given URI.
     *
     * This method is called by VS Code for each file that might need decoration.
     * Returns a decoration with badge, color, and tooltip based on the file's change status.
     *
     * @param uri - The URI of the file to decorate
     * @returns File decoration or undefined if no decoration is needed
     */
    async provideFileDecoration(uri: vscode.Uri): Promise<vscode.FileDecoration | undefined> {
        // Skip decoration if provider is disabled
        if (this.isProviderDisabled()) {
            return;
        }

        // Convert URI to normalized absolute path for lookup
        const normalizedPath = normFs(uri.fsPath);
        let category = this.changedFiles.get(normalizedPath);

        if (!category) {
            const hasContainingFile = [...this.changedFiles.keys()].some(f => f.startsWith(normalizedPath));
            if (!hasContainingFile) {
                return;
            }
        }
        category ??= STATUS_PRESETS[Status.INDEX_MODIFIED]; // Fallback for parent dirs
        if (!category) {
            return;
        }

        // Map change status to appropriate VS Code theme colors
        const { badge, colorKey } = CATEGORY_PRESETS[category];
        const currentBaseRef = BaseRefUtils.getCurrBaseRef();

        log.trace(`[BranchCompareProvider] Providing decoration for ${path.basename(uri.fsPath)}: ${category}`);

        return {
            badge: badge,                                  // Single-letter badge (A/M/D/R)
            tooltip: `Changes vs ${currentBaseRef}`,       // Tooltip showing comparison reference
            color: new vscode.ThemeColor(colorKey),        // Theme-appropriate color
            propagate: true                                // Propagate decoration to parent folders
        };
    }

    // ============================================================================
    // CHANGE COMPUTATION
    // ============================================================================

    /**
     * Computes file changes for all workspace folders.
     *
     * Clears existing changes and recomputes them by processing each workspace folder.
     * Updates the tracking of previously changed files for comparison in the next cycle.
     */
    private async computeAllWorkspaceChanges(): Promise<void> {
        log.debug('[BranchCompareProvider] Computing changes for all workspace folders');
        this.changedFiles.clear();

        // Exit early if provider is disabled or Git API is unavailable
        if (this.isProviderDisabled() || !this.gitApi) {
            log.debug('[BranchCompareProvider] Provider disabled or Git API unavailable, clearing changes');
            this.lastChangedKeys.clear();
            return;
        }

        const workspaceFolders = vscode.workspace.workspaceFolders ?? [];
        log.debug(`[BranchCompareProvider] Processing ${workspaceFolders.length} workspace folders`);

        // Collect unique repositories that are used by the workspace
        const reposByRoot = new Map<string, Repository>();
        for (const folder of workspaceFolders) {
            const repo = this.selectRepositoryForWorkspaceFolder(folder);
            if (repo) {
                reposByRoot.set(normFs(repo.rootUri.fsPath), repo);
            }
        }
        const uniqueRepos = [...reposByRoot.values()];
        log.debug(`[BranchCompareProvider] Processing ${uniqueRepos.length} unique repositories`);

        // Process folders in parallel for better performance
        await Promise.all(
            uniqueRepos.map(async repo => {
                await this.folderSema.acquire();
                try {
                    await this.computeChangesForRepository(repo);
                } finally {
                    this.folderSema.release();
                }
            })
        );

        // Update tracking of changed files for next comparison cycle
        this.lastChangedKeys.clear();
        for (const filePath of this.changedFiles.keys()) {
            this.lastChangedKeys.add(filePath);
        }

        log.info(`[BranchCompareProvider] Found changes in ${this.changedFiles.size} files`);
    }

    /**
     * Finds the most appropriate Git repository for a workspace folder.
     *
     * @param workspaceFolder - The workspace folder to find a repository for
     * @returns The repository or undefined if none found
     */
    private selectRepositoryForWorkspaceFolder(workspaceFolder: vscode.WorkspaceFolder): Repository | undefined {
        if (!this.gitApi) {
            return undefined;
        }

        // Prefer a repository that directly contains this folder
        const directRepository = this.gitApi.getRepository(workspaceFolder.uri);
        if (directRepository) {
            log.debug(`[BranchCompareProvider] Found direct repository for folder: ${workspaceFolder.uri.fsPath}`);
            return directRepository;
        }

        // Fallback: find a repository whose root is an ancestor of the folder (for nested/multi-root scenarios)
        const normalizedFolderPath = normFs(workspaceFolder.uri.fsPath);
        const ancestorRepository = this.gitApi.repositories.find((repository: Repository) =>
            normalizedFolderPath.startsWith(normFs(repository.rootUri.fsPath))
        );

        if (ancestorRepository) {
            log.debug(`[BranchCompareProvider] Found ancestor repository for folder: ${workspaceFolder.uri.fsPath}`);
        } else {
            log.debug(`[BranchCompareProvider] No repository found for folder: ${workspaceFolder.uri.fsPath}`);
        }

        return ancestorRepository;
    }

    /**
     * Computes file changes for a specific Git repository.
     *
     * @param repository - The Git repository to compute changes for
     * @returns
     */
    private async computeChangesForRepository(repository: Repository): Promise<void> {
        const currentBranchName = repository.state.HEAD?.name;
        if (!currentBranchName) {
            return;
        }

        let baseReference: string | null = BaseRefUtils.getCurrBaseRef();
        const upstreamReference = this.getUpstreamReference(repository);
        baseReference = await this.resolveSpecialBaseReference(baseReference, upstreamReference, repository);

        // Fetch first, so the baseline uses up-to-date refs
        await this.performAutoFetchIfNeeded(repository, baseReference);

        const finalComparisonReference = await this.getComparisonBaseline(
            repository, currentBranchName, baseReference, upstreamReference
        );

        log.debug(`[BranchCompareProvider] Computing diff: ${finalComparisonReference}..HEAD`);
        const fileChanges = await repository.diffBetween(finalComparisonReference, 'HEAD');
        for (const change of fileChanges) {
            this.processFileChange(change);
        }
    }

    // ============================================================================
    // REFERENCE RESOLUTION HELPERS
    // ============================================================================

    /**
     * Gets the upstream reference for the current branch in a repository.
     *
     * @param repository - The Git repository
     * @returns The upstream reference string or undefined if no upstream is set
     */
    private getUpstreamReference(repository: Repository): string | undefined {
        const upstreamInfo = repository.state.HEAD?.upstream;
        if (!upstreamInfo?.name) {
            return undefined;
        }

        const upstreamRef = upstreamInfo.remote ? `${upstreamInfo.remote}/${upstreamInfo.name}` : upstreamInfo.name;
        log.debug(`[BranchCompareProvider] Found upstream reference: ${upstreamRef}`);
        return upstreamRef;
    }

    /**
     * Resolves special base reference types to actual Git references.
     *
     * @param baseReference - The configured base reference (may be special)
     * @param upstreamReference - The upstream reference for the current branch
     * @param repository - The Git repository
     * @returns The resolved base reference
     */
    private async resolveSpecialBaseReference(baseReference: string | null, upstreamReference: string | undefined, repository: Repository): Promise<string | null> {
        if (baseReference === '__branch_origin__') {
            const resolved = upstreamReference ?? baseReference;
            log.debug(`[BranchCompareProvider] Resolved __branch_origin__ to: ${resolved}`);
            return resolved;
        }

        if (baseReference === '__main_origin__') {
            const mainBranch = await this.findMainDevelopmentBranch(repository);
            const resolved = mainBranch ?? 'origin/main';
            log.debug(`[BranchCompareProvider] Resolved __main_origin__ to: ${resolved}`);
            return resolved;
        }

        return baseReference;
    }

    /**
     * Gets the comparison baseline for the current branch.
     *
     * @param repository - The Git repository
     * @param currentBranchName - The name of the current branch
     * @param baseReference - The base reference for comparison
     * @param upstreamReference - The upstream reference for comparison
     * @returns The comparison baseline reference
     */
    private async getComparisonBaseline(repository: Repository, currentBranchName: string, baseReference: string | null, upstreamReference: string | undefined): Promise<string> {

        const headSha = repository.state.HEAD?.commit ?? '';
        const cacheKey = this.makeBaselineCacheKey(repository, headSha, baseReference, upstreamReference);
        const cached = this.baselineCache.get(cacheKey);
        if (cached) {
            return cached ?? 'origin/main';
        }

        // Decide baseline (your existing logic, slightly refactored)
        let comparisonBaseline: string | null | undefined;
        const isSame = this.isComparingAgainstSameBranch(baseReference, upstreamReference, currentBranchName, repository);

        if (isSame) {
            const candidates = await this.getMainBranchCandidates(repository);
            comparisonBaseline = await this.selectBestForkPointFromCandidates(repository, currentBranchName, candidates);
        } else if (typeof baseReference === 'string') {
            comparisonBaseline = await this.calculateForkPointOrMergeBase(repository, baseReference, currentBranchName);
        }

        const finalRef = (comparisonBaseline ?? baseReference ?? 'origin/main');
        this.baselineCache.set(cacheKey, finalRef);
        return finalRef;
    }


    /**
     * Determines if we're comparing against the same branch (requiring fork-point logic).
     *
     * @param baseReference - The base reference for comparison
     * @param upstreamReference - The upstream reference
     * @param currentBranchName - The current branch name
     * @param repository - The Git repository
     * @returns True if comparing against the same branch
     */
    private isComparingAgainstSameBranch(baseReference: string | null, upstreamReference: string | undefined, currentBranchName: string, repository: Repository): boolean {
        const upstreamName = repository.state.HEAD?.upstream?.name;
        const isSameBranch = baseReference === upstreamReference ||
            baseReference === currentBranchName ||
            baseReference === upstreamName;

        log.debug(`[BranchCompareProvider] Comparing against same branch: ${isSameBranch}`);
        return isSameBranch;
    }

    /**
     * Performs automatic fetch if configured and needed.
     *
     * @param repository - The Git repository
     * @param baseReference - The base reference that might need fetching
     */
    private async performAutoFetchIfNeeded(repository: Repository, baseReference: string | null): Promise<void> {
        if (!this.shouldAutoFetch || typeof baseReference !== 'string' || !baseReference.includes('/')) {
            return;
        }

        const [remoteName, ...referencePathParts] = baseReference.split('/');
        const referencePath = referencePathParts.join('/');

        if (!remoteName || !referencePath) {
            return;
        }

        const fetchKey = `${normFs(repository.rootUri.fsPath)}#${remoteName}/${referencePath}`;
        const currentTime = Date.now();
        const lastFetchTime = this.lastFetchTimestampByRepoRef.get(fetchKey) ?? 0;

        if (lastFetchTime < currentTime - this.fetchCooldownMilliseconds) {
            log.info(`[BranchCompareProvider] Auto-fetching ${remoteName}/${referencePath}`);
            try {
                await repository.fetch(remoteName, referencePath);
                this.lastFetchTimestampByRepoRef.set(fetchKey, currentTime);
                log.info(`[BranchCompareProvider] Successfully fetched ${remoteName}/${referencePath}`);
            } catch (error) {
                log.error(`[BranchCompareProvider] Failed to fetch ${remoteName}/${referencePath}:`, error);
            }
        }
    }

    /**
     * Gets main development branch candidates for fork-point detection.
     *
     * @param repository - The Git repository
     * @returns Array of potential main branch references
     */
    private async getMainBranchCandidates(repository: Repository): Promise<string[]> {
        const commonMainBranches = [
            'origin/main', 'origin/dev', 'origin/develop', 'origin/master',
            'main', 'dev', 'develop', 'master'
        ];

        try {
            const remoteBranches = await repository.getBranches({ remote: true }) as Ref[];
            const existingBranches = new Set(remoteBranches.map(branch => branch.name));

            // Keep candidates that exist in the repository, plus local branches as fallback
            const availableCandidates = commonMainBranches.filter(branchName =>
                existingBranches.has(branchName) || !branchName.startsWith('origin/')
            );

            log.debug(`[BranchCompareProvider] Main branch candidates: ${availableCandidates.join(', ')}`);
            return availableCandidates;
        } catch (error) {
            log.warn('[BranchCompareProvider] Failed to get branch list, using default candidates:', error);
            return commonMainBranches;
        }
    }

    // ============================================================================
    // GIT OPERATIONS HELPERS
    // ============================================================================

    /**
     * Gets the commit timestamp for a given SHA.
     *
     * @param repository - The Git repository
     * @param commitSha - The commit SHA to get timestamp for
     * @returns Unix timestamp or -1 if unable to retrieve
     */
    private async getCommitTimestamp(repository: Repository, commitSha: string): Promise<number> {
        const workingDirectory = repository.rootUri.fsPath;
        const gitExecutablePath = (this.gitApi as any)?.git?.path ?? 'git';

        try {
            const { stdout } = await execFileAsync(
                gitExecutablePath,
                ['show', '-s', '--format=%ct', commitSha],
                { cwd: workingDirectory }
            );

            const timestamp = Number(stdout.trim());
            const isValidTimestamp = !isNaN(timestamp);

            log.trace(`[BranchCompareProvider] Commit ${commitSha} timestamp: ${isValidTimestamp ? timestamp : 'invalid'}`);
            return isValidTimestamp ? timestamp : -1;
        } catch (error) {
            log.warn(`[BranchCompareProvider] Failed to get commit timestamp for ${commitSha}:`, error);
            return -1;
        }
    }

    /**
     * Selects the best fork point from multiple candidate base branches.
     *
     * @param repository - The Git repository
     * @param branchName - The current branch name
     * @param baseCandidates - Array of potential base branch references
     * @returns The SHA of the best fork point or null if none found
     */
    private async selectBestForkPointFromCandidates(repository: Repository, branchName: string, baseCandidates: string[]): Promise<string | null> {
        let bestCommitSha: string | null = null;
        let bestTimestamp = -1;

        log.debug(`[BranchCompareProvider] Evaluating ${baseCandidates.length} fork point candidates`);

        for (const baseCandidate of baseCandidates) {
            const forkPointSha = await this.calculateForkPointOrMergeBase(repository, baseCandidate, branchName);
            if (!forkPointSha) {
                continue;
            }

            const commitTimestamp = await this.getCommitTimestamp(repository, forkPointSha);
            if (commitTimestamp > bestTimestamp) {
                bestTimestamp = commitTimestamp;
                bestCommitSha = forkPointSha;
                log.debug(`[BranchCompareProvider] New best fork point: ${baseCandidate} -> ${forkPointSha}`);
            }
        }

        log.debug(`[BranchCompareProvider] Selected best fork point: ${bestCommitSha}`);
        return bestCommitSha;
    }

    /**
     * Calculates fork point or merge base between two references.
     *
     * @param repository - The Git repository
     * @param baseReference - The base reference
     * @param branchName - The branch name
     * @returns The SHA of the fork point/merge base or undefined if not found
     */
    private async calculateForkPointOrMergeBase(repository: Repository, baseReference: string, branchName: string): Promise<string | undefined> {
        const workingDirectory = repository.rootUri.fsPath;
        const gitExecutablePath = (this.gitApi as any)?.git?.path ?? 'git';

        // First attempt: use fork-point (more accurate for tracking branch divergence)
        try {
            const { stdout } = await execFileAsync(
                gitExecutablePath,
                ['merge-base', '--fork-point', baseReference, branchName],
                { cwd: workingDirectory }
            );

            const forkPointSha = stdout.trim();
            if (forkPointSha) {
                log.debug(`[BranchCompareProvider] Found fork point: ${baseReference}...${branchName} -> ${forkPointSha}`);
                return forkPointSha;
            }
        } catch (error) {
            log.debug(`[BranchCompareProvider] Fork point calculation failed, trying merge-base:`, error);
        }

        // Fallback: use regular merge-base
        try {
            const mergeBaseSha = await repository.getMergeBase(baseReference, branchName);
            if (!mergeBaseSha) {
                throw new Error('Merge base is null');
            }
            log.debug(`[BranchCompareProvider] Found merge base: ${baseReference}...${branchName} -> ${mergeBaseSha}`);
            return mergeBaseSha;
        } catch (error) {
            log.error(`[BranchCompareProvider] Failed to find merge base between ${baseReference} and ${branchName}:`);
            return undefined;
        }
    }

    /**
     * Finds the main development branch in the repository.
     *
     * Searches for common main branch names (dev, develop, main, master) in remote branches
     * and returns the first match found. Prioritizes 'dev' and 'develop' over 'main' and 'master'.
     *
     * @param repository - The Git repository to search
     * @returns The name of the main development branch or null if none found
     */
    private async findMainDevelopmentBranch(repository: Repository): Promise<string | null> {
        try {
            const commonMainBranchNames = ['dev', 'develop', 'main', 'master'];

            log.debug('[BranchCompareProvider] Searching for main development branch');

            // Get all remote branches
            const remoteBranches = await repository.getBranches({ remote: true }) as Ref[];
            log.debug(`[BranchCompareProvider] Found ${remoteBranches.length} remote branches`);

            // Look for origin versions of main branches in priority order
            for (const branchName of commonMainBranchNames) {
                const targetBranchName = `origin/${branchName}`;
                const foundBranch = remoteBranches.find(branch =>
                    branch.name === targetBranchName
                );

                if (foundBranch) {
                    log.info(`[BranchCompareProvider] Found main development branch: ${foundBranch.name}`);
                    return foundBranch.name!;
                }
            }

            log.debug('[BranchCompareProvider] No main development branch found');
            return null;
        } catch (error) {
            log.error('[BranchCompareProvider] Error finding main development branch:', error);
            return null;
        }
    }

    // ============================================================================
    // FILE CHANGE PROCESSING
    // ============================================================================

    /**
     * Processes a single file change and updates the changed files map.
     *
     * @param change - The file change object from Git
     */
    private processFileChange(change: Change) {
        const category = this.categoryFromStatus(change.status, change.renameUri);
        log.trace(`[BranchCompareProvider] Processing change: ${path.basename(change.uri.fsPath)} (${category})`);
        this.changedFiles.set(normFs(change.uri.fsPath), category);
        if (change.renameUri && change.originalUri !== change.renameUri) {
            this.changedFiles.set(normFs(change.renameUri.fsPath), 'renamed');
        }
    }

    /**
     * Maps Git status and rename URI to our simplified change category.
     *
     * @param status - The Git status from the change object
     * @param renameUri - The rename URI if the file was renamed
     * @returns The simplified change category for decoration
     */
    categoryFromStatus(status: Status, renameUri?: vscode.Uri): ChangeCategory {
        if (status === Status.INDEX_RENAMED && renameUri) {
            return STATUS_PRESETS[Status.INDEX_RENAMED] ?? 'renamed';
        }

        const direct = STATUS_PRESETS[status];
        if (direct) {
            return direct;
        }

        return STATUS_PRESETS[Status.INDEX_MODIFIED] ?? 'modified';
    }
}
