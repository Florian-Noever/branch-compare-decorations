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

type ChangeStatus = 'A' | 'M' | 'D' | 'R' | 'C' | 'U' | 'T' | 'X' | '?';

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

    /** Map of file paths to their change status (A/M/D/R) */
    private readonly changedFiles = new Map<string, ChangeStatus>();

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
            this.scheduleRefresh();
        });

        if (stateSubscription) {
            subscriptions.push(stateSubscription);
        }

        // Subscribe to checkout events (branch switches)
        const checkoutSubscription = repository.onDidCheckout?.(() => {
            log.debug(`[BranchCompareProvider] Repository checkout detected: ${repository.rootUri.fsPath}`);
            this.scheduleRefresh();
        });
        if (checkoutSubscription) {
            subscriptions.push(checkoutSubscription);
        }

        // Subscribe to commit events
        const commitSubscription = repository.onDidCommit?.(() => {
            log.debug(`[BranchCompareProvider] Repository commit detected: ${repository.rootUri.fsPath}`);
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
                impactedUris.push(this.convertPathToUri(filePath));

                // Add parent directories within workspace for decoration propagation
                for (const parentUri of this.getParentDirectoriesWithinWorkspace(filePath)) {
                    impactedUris.push(parentUri);
                }
            }

            // Fire decoration change events
            if (impactedUris.length === 0) {
                log.trace('[BranchCompareProvider] No decoration changes detected');
                this._onDidChangeDecorations.fire(undefined);
            } else {
                log.debug(`[BranchCompareProvider] Firing decoration changes for ${impactedUris.length} URIs`);
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
            return undefined;
        }

        // Convert URI to normalized absolute path for lookup
        const normalizedPath = normFs(uri.fsPath);
        const changeStatus = this.changedFiles.get(normalizedPath);

        if (!changeStatus) {
            return undefined;
        }

        // Map change status to appropriate VS Code theme colors
        const themeColorKey = this.getThemeColorForChangeStatus(changeStatus);
        const currentBaseRef = BaseRefUtils.getCurrBaseRef();

        log.trace(`[BranchCompareProvider] Providing decoration for ${path.basename(uri.fsPath) }: ${changeStatus}`);

        return {
            badge: changeStatus,                                   // Single-letter badge (A/M/D/R)
            tooltip: `Changes vs ${currentBaseRef}`,               // Tooltip showing comparison reference
            color: new vscode.ThemeColor(themeColorKey),           // Theme-appropriate color
            propagate: true                                        // Propagate decoration to parent folders
        };
    }

    /**
     * Maps a change status to the appropriate VS Code theme color key.
     *
     * @param status - The change status (A/M/D/R)
     * @returns Theme color key for the status
     */
    private getThemeColorForChangeStatus(status: ChangeStatus): string {
        switch (status) {
            case 'A':
                return 'gitDecoration.addedResourceForeground';
            case 'D':
                return 'gitDecoration.deletedResourceForeground';
            case 'R':
                return 'gitDecoration.renamedResourceForeground';
            default:
                return 'gitDecoration.modifiedResourceForeground';
        }
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

        // Process folders in parallel for better performance
        await Promise.all(
            workspaceFolders.map(async folder => {
                await this.folderSema.acquire();
                try {
                    await this.computeChangesForWorkspaceFolder(folder);
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
     * Computes file changes for a specific workspace folder.
     *
     * Determines the appropriate base reference, handles special reference types,
     * performs automatic fetching if enabled, and computes the diff between base and HEAD.
     *
     * @param workspaceFolder - The workspace folder to process
     */
    private async computeChangesForWorkspaceFolder(workspaceFolder: vscode.WorkspaceFolder): Promise<void> {
        const repository = this.selectRepositoryForWorkspaceFolder(workspaceFolder);
        if (!repository) {
            log.debug(`[BranchCompareProvider] No repository found for folder: ${workspaceFolder.uri.fsPath}`);
            return;
        }

        try {
            const currentBranchName = repository.state.HEAD?.name;
            if (!currentBranchName) {
                log.warn(`[BranchCompareProvider] No HEAD branch found in repository: ${repository.rootUri.fsPath}`);
                return;
            }

            log.debug(`[BranchCompareProvider] Processing repository: ${repository.rootUri.fsPath}, branch: ${currentBranchName}`);

            // Get the configured base reference
            let baseReference: string | null = BaseRefUtils.getCurrBaseRef();
            const upstreamReference = this.getUpstreamReference(repository);

            // Handle special base reference types
            baseReference = await this.resolveSpecialBaseReference(baseReference, upstreamReference, repository);

            // Determine if we're comparing against the same branch (requires fork-point logic)
            const isComparingAgainstSameBranch = this.isComparingAgainstSameBranch(
                baseReference, upstreamReference, currentBranchName, repository
            );

            let comparisonBaseline: string | undefined | null;

            if (isComparingAgainstSameBranch) {
                // Find the fork point using main development branches
                const mainBranchCandidates = await this.getMainBranchCandidates(repository);
                comparisonBaseline = await this.selectBestForkPointFromCandidates(repository, currentBranchName, mainBranchCandidates);
                log.debug(`[BranchCompareProvider] Using fork-point comparison, baseline: ${comparisonBaseline}`);
            } else if (typeof baseReference === 'string') {
                // Direct comparison against specified reference
                comparisonBaseline = await this.calculateForkPointOrMergeBase(repository, baseReference, currentBranchName);
                log.debug(`[BranchCompareProvider] Using direct comparison against: ${baseReference}, baseline: ${comparisonBaseline}`);
            }

            const finalComparisonReference = comparisonBaseline ?? baseReference ?? 'origin/main';

            // Perform automatic fetch if configured and needed
            await this.performAutoFetchIfNeeded(repository, baseReference);

            // Compute file changes between baseline and current HEAD
            log.debug(`[BranchCompareProvider] Computing diff: ${finalComparisonReference}..HEAD`);
            const fileChanges = await repository.diffBetween(finalComparisonReference, 'HEAD');

            log.debug(`[BranchCompareProvider] Found ${fileChanges.length} changed files`);
            await Promise.all(fileChanges.map((change: Change) => this.processFileChange(change)));

        } catch (error) {
            log.error(`[BranchCompareProvider] Error processing repository ${repository.rootUri.fsPath}:`, error);
            // Continue processing other repositories even if one fails
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
    private async resolveSpecialBaseReference(
        baseReference: string | null,
        upstreamReference: string | undefined,
        repository: Repository
    ): Promise<string | null> {
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
     * Determines if we're comparing against the same branch (requiring fork-point logic).
     *
     * @param baseReference - The base reference for comparison
     * @param upstreamReference - The upstream reference
     * @param currentBranchName - The current branch name
     * @param repository - The Git repository
     * @returns True if comparing against the same branch
     */
    private isComparingAgainstSameBranch(
        baseReference: string | null,
        upstreamReference: string | undefined,
        currentBranchName: string,
        repository: Repository
    ): boolean {
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
    private async selectBestForkPointFromCandidates(
        repository: Repository,
        branchName: string,
        baseCandidates: string[]
    ): Promise<string | null> {
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
    private async calculateForkPointOrMergeBase(
        repository: Repository,
        baseReference: string,
        branchName: string
    ): Promise<string | undefined> {
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
            log.error(`[BranchCompareProvider] Failed to find merge base between ${baseReference} and ${branchName}:`, error);
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
     * Processes a single file change and updates the decoration map.
     *
     * Handles different change types including renames, additions, deletions, and modifications.
     * For renames, both the old and new file paths are marked with 'R' status.
     *
     * @param fileChange - The file change object from Git diff
     */
    private async processFileChange(fileChange: Change): Promise<void> {
        // Handle renames: mark both old and new file paths
        if (fileChange.status === Status.INDEX_RENAMED && fileChange.renameUri) {
            const newFilePath = normFs(fileChange.uri.fsPath);
            const oldFilePath = normFs(fileChange.renameUri.fsPath);

            log.trace(`[BranchCompareProvider] Processing rename: ${oldFilePath} -> ${newFilePath}`);

            this.changedFiles.set(newFilePath, 'R');
            this.changedFiles.set(oldFilePath, 'R');
            return;
        }

        // Map Git status to our change status badge
        const changeStatus = this.mapGitStatusToChangeStatus(fileChange.status);
        const normalizedFilePath = normFs(fileChange.uri.fsPath);

        log.trace(`[BranchCompareProvider] Processing change: ${path.basename(fileChange.uri.fsPath)} (${changeStatus})`);
        this.changedFiles.set(normalizedFilePath, changeStatus);
    }

    /**
     * Maps Git file status to our simplified change status.
     *
     * @param gitStatus - The Git status from the change object
     * @returns The simplified change status for decoration
     */
    private mapGitStatusToChangeStatus(gitStatus: Status): ChangeStatus {
        if (gitStatus === Status.DELETED || gitStatus === Status.INDEX_DELETED) {
            return 'D';
        }

        if (gitStatus === Status.ADDED_BY_US ||
            gitStatus === Status.INDEX_ADDED ||
            gitStatus === Status.UNTRACKED ||
            gitStatus === Status.INTENT_TO_ADD) {
            return 'A';
        }

        // All other statuses are treated as modifications
        return 'M';
    }
}
