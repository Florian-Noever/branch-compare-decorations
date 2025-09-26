import * as vscode from 'vscode';
import type { API as GitAPI, Repository, Ref } from '../git';
import path from 'path';
import { GitUtils } from '../utils/gitUtils';

/**
 * Provides user interface for selecting Git branch references for comparison.
 *
 * This class creates VS Code Quick Pick dialogs to help users select:
 * - Special comparison types (branch origin, main development branch)
 * - Remote branches from the repository
 * - Custom manual branch references
 * - Option to disable decorations
 *
 * The picker intelligently handles multiple repositories, filters relevant branches,
 * and provides user-friendly descriptions for different comparison options.
 *
 * Key features:
 * - Multi-repository support with automatic selection logic
 * - Special comparison modes for common use cases
 * - Remote branch filtering and sorting
 * - Manual branch entry with validation
 * - Intuitive UI with icons and descriptions
 *
 * @example
 * ```typescript
 * const picker = new GitBranchPicker();
 * const baseRef = await picker.pickBaseReference();
 * if (baseRef) {
 *   // Use the selected reference for comparison
 * }
 * ```
 */
export class GitBranchPicker {
    // ============================================================================
    // PRIVATE PROPERTIES
    // ============================================================================

    /** Reference to VS Code's Git API for repository operations */
    private readonly gitApi?: GitAPI;

    // ============================================================================
    // CONSTRUCTOR
    // ============================================================================

    /**
     * Initializes the GitBranchPicker with Git API integration.
     *
     * Connects to VS Code's built-in Git API to access repository information
     * and branch data for the picker interface.
     */
    constructor() {
        console.log('[GitBranchPicker] Initializing branch picker');

        this.gitApi = GitUtils.getGitApi();
        if (!this.gitApi) {
            console.warn('[GitBranchPicker] Git API not available - picker functionality will be limited');
        } else {
            console.log('[GitBranchPicker] Git API connected successfully');
        }
    }

    // ============================================================================
    // PUBLIC INTERFACE
    // ============================================================================

    /**
     * Shows a Quick Pick dialog for selecting a base reference for branch comparison.
     *
     * Presents users with special comparison options, remote branches, and manual entry.
     * The selection determines what the current branch will be compared against for
     * file decorations in the VS Code explorer.
     *
     * @param currentSelection - The currently selected base reference (for pre-selection)
     * @returns The chosen base reference, empty string to disable, or undefined if cancelled
     *
     * @example
     * ```typescript
     * const baseRef = await picker.pickBaseReference('origin/main');
     * if (baseRef === '') {
     *   // User chose to disable decorations
     * } else if (baseRef) {
     *   // User selected a valid reference
     * } else {
     *   // User cancelled the selection
     * }
     * ```
     */
    async pickBaseReference(currentSelection?: string): Promise<string | undefined> {
        console.log(`[GitBranchPicker] Starting base reference selection, current: ${currentSelection || 'none'}`);

        const selectedRepository = await this.selectRepository();
        console.log(`[GitBranchPicker] Selected repository: ${selectedRepository?.rootUri.fsPath || 'none'}`);

        // Build special comparison options
        const specialComparisonItems = this.createSpecialComparisonItems(selectedRepository);
        console.log(`[GitBranchPicker] Created ${specialComparisonItems.length} special comparison items`);

        // Build remote branch options
        const remoteBranchItems = await this.createRemoteBranchItems(selectedRepository);
        console.log(`[GitBranchPicker] Created ${remoteBranchItems.length} remote branch items`);

        // Combine all picker items
        const allPickerItems: (vscode.QuickPickItem & { value: string })[] = [
            ...specialComparisonItems,
            { label: '', kind: vscode.QuickPickItemKind.Separator, value: '' },
            { label: 'Remote Branches', kind: vscode.QuickPickItemKind.Separator, value: '' },
            ...remoteBranchItems,
            { label: '', kind: vscode.QuickPickItemKind.Separator, value: '' },
            {
                label: '$(pencil) Enter manually…',
                description: 'Custom remote branch (e.g., origin/feature-branch)',
                value: '__manual__'
            },
            {
                label: '$(circle-slash) Disable',
                description: 'Show no custom decorations',
                value: ''
            }
        ];

        console.log(`[GitBranchPicker] Showing picker with ${allPickerItems.length} total items`);

        const selectedItem = await vscode.window.showQuickPick(allPickerItems, {
            placeHolder: selectedRepository
                ? 'Pick a remote branch or special comparison for Explorer decorations'
                : 'No Git repository detected. Enter a base ref or disable.',
            matchOnDescription: true
        });

        if (!selectedItem) {
            console.log('[GitBranchPicker] User cancelled selection');
            return undefined;
        }

        console.log(`[GitBranchPicker] User selected: ${selectedItem.label} (value: ${selectedItem.value})`);

        // Handle manual entry
        if (selectedItem.value === '__manual__') {
            return await this.handleManualReferenceEntry(currentSelection);
        }

        console.log(`[GitBranchPicker] Returning selected value: ${selectedItem.value}`);
        return selectedItem.value;
    }

    // ============================================================================
    // BRANCH ITEM CREATION
    // ============================================================================

    /**
     * Creates picker items for remote branches.
     *
     * Fetches all remote branches from the repository, filters for origin branches,
     * and creates properly formatted picker items with icons and descriptions.
     *
     * @param repository - The repository to get branches from
     * @returns Array of remote branch picker items
     */
    private async createRemoteBranchItems(repository?: Repository): Promise<(vscode.QuickPickItem & { value: string })[]> {
        if (!repository) {
            console.log('[GitBranchPicker] No repository provided for remote branch items');
            return [];
        }

        try {
            console.log('[GitBranchPicker] Fetching remote branches');
            const remoteBranches = await repository.getBranches({ remote: true }) as Ref[];
            console.log(`[GitBranchPicker] Found ${remoteBranches.length} remote branches`);

            const filteredAndMappedBranches = remoteBranches
                .filter(branch => branch.name && branch.name.startsWith('origin/'))
                .map(branch => ({
                    label: `$(git-branch) ${branch.name!}`,
                    description: 'remote',
                    value: branch.name!
                }))
                .sort((branchA, branchB) => {
                    // Sort origin branches first, then alphabetically
                    const aIsOriginBranch = branchA.value.startsWith('origin/');
                    const bIsOriginBranch = branchB.value.startsWith('origin/');

                    if (aIsOriginBranch && !bIsOriginBranch) {
                        return -1;
                    }
                    if (!aIsOriginBranch && bIsOriginBranch) {
                        return 1;
                    }

                    return branchA.value.localeCompare(branchB.value);
                });

            console.log(`[GitBranchPicker] Created ${filteredAndMappedBranches.length} remote branch items`);
            return filteredAndMappedBranches;

        } catch (error) {
            console.warn('[GitBranchPicker] Failed to fetch remote branches:', error);
            return [];
        }
    }

    // ============================================================================
    // REPOSITORY SELECTION
    // ============================================================================

    /**
     * Selects the appropriate Git repository for branch operations.
     *
     * Uses intelligent selection logic:
     * 1. If only one repository exists, uses it automatically
     * 2. If single workspace folder exists, prefers matching repository
     * 3. Otherwise prompts user to choose from available repositories
     *
     * @returns The selected repository or undefined if none available/selected
     */
    private async selectRepository(): Promise<Repository | undefined> {
        if (!this.gitApi || this.gitApi.repositories.length === 0) {
            console.log('[GitBranchPicker] No Git repositories available');
            return undefined;
        }

        console.log(`[GitBranchPicker] Found ${this.gitApi.repositories.length} Git repositories`);

        // Single repository - use it automatically
        if (this.gitApi.repositories.length === 1) {
            const repository = this.gitApi.repositories[0];
            console.log(`[GitBranchPicker] Auto-selecting single repository: ${repository.rootUri.fsPath}`);
            return repository;
        }

        // Multiple repositories - try to match with workspace folder
        const workspaceFolders = vscode.workspace.workspaceFolders ?? [];
        if (workspaceFolders.length === 1) {
            const workspacePath = this.normalizeFileSystemPath(workspaceFolders[0].uri.fsPath);
            console.log(`[GitBranchPicker] Looking for repository matching workspace: ${workspacePath}`);

            const matchingRepository = this.gitApi.repositories.find((repository: Repository) => {
                const repositoryPath = this.normalizeFileSystemPath(repository.rootUri.fsPath);
                return this.isPathInside(repositoryPath, workspacePath) ||
                    this.isPathInside(workspacePath, repositoryPath);
            });

            if (matchingRepository) {
                console.log(`[GitBranchPicker] Found matching repository: ${matchingRepository.rootUri.fsPath}`);
                return matchingRepository;
            }
        }

        // Multiple repositories - prompt user to choose
        console.log('[GitBranchPicker] Prompting user to select repository');
        const repositoryPickerItems = this.gitApi.repositories.map((repository: Repository) => ({
            label: vscode.workspace.asRelativePath(repository.rootUri, false),
            description: repository.rootUri.fsPath,
            repository: repository
        }));

        const selectedItem = await vscode.window.showQuickPick(repositoryPickerItems, {
            placeHolder: 'Select a Git repository'
        });

        if (selectedItem) {
            console.log(`[GitBranchPicker] User selected repository: ${selectedItem.repository.rootUri.fsPath}`);
        } else {
            console.log('[GitBranchPicker] User cancelled repository selection');
        }

        return selectedItem?.repository;
    }

    // ============================================================================
    // UTILITY METHODS
    // ============================================================================

    /**
     * Normalizes a file system path for consistent comparison across platforms.
     *
     * @param filePath - The file system path to normalize
     * @returns Normalized absolute path (lowercase on Windows)
     */
    private normalizeFileSystemPath(filePath: string): string {
        const absolutePath = path.resolve(filePath);
        return process.platform === 'win32' ? absolutePath.toLowerCase() : absolutePath;
    }

    /**
     * Checks if one path is inside another path.
     *
     * @param ancestorPath - The potential parent/ancestor path
     * @param descendantPath - The potential child/descendant path
     * @returns True if descendant is inside ancestor
     */
    private isPathInside(ancestorPath: string, descendantPath: string): boolean {
        if (descendantPath === ancestorPath) {
            return true;
        }

        const pathSeparator = path.sep;
        const normalizedAncestor = ancestorPath.endsWith(pathSeparator) ? ancestorPath : ancestorPath + pathSeparator;

        return descendantPath.startsWith(normalizedAncestor);
    }

    /**
     * Creates special comparison items for the picker.
     *
     * @param repository - The selected repository (may be undefined)
     * @returns Array of special comparison picker items
     */
    private createSpecialComparisonItems(repository?: Repository): (vscode.QuickPickItem & { value: string })[] {
        const specialItems: (vscode.QuickPickItem & { value: string })[] = [];

        if (repository) {
            const currentBranch = repository.state.HEAD;
            if (currentBranch?.name) {
                console.log(`[GitBranchPicker] Adding branch origin option for: ${currentBranch.name}`);
                specialItems.push({
                    label: `$(git-branch) Current Branch Origin`,
                    description: `Show all changes since '${currentBranch.name}' was created`,
                    value: '__branch_origin__'
                });
            }

            console.log('[GitBranchPicker] Adding main development branch option');
            specialItems.push({
                label: `$(git-merge) Main Development Branch`,
                description: `Show changes since branching from main/master/dev/develop`,
                value: '__main_origin__'
            });
        }

        return specialItems;
    }

    /**
     * Handles manual reference entry when user selects the manual option.
     *
     * @param currentSelection - The current selection for pre-filling
     * @returns The manually entered reference or undefined if cancelled
     */
    private async handleManualReferenceEntry(currentSelection?: string): Promise<string | undefined> {
        console.log('[GitBranchPicker] Handling manual reference entry');

        const defaultValue = currentSelection?.startsWith('origin/') ? currentSelection : 'origin/';
        const selectionRange: [number, number] = currentSelection?.startsWith('origin/')
            ? [0, currentSelection.length]
            : [7, 7];

        const manualEntry = await vscode.window.showInputBox({
            prompt: 'Enter remote branch (e.g., origin/feature-branch). Empty disables.',
            value: defaultValue,
            valueSelection: selectionRange
        });

        if (manualEntry !== undefined) {
            console.log(`[GitBranchPicker] User entered manual reference: ${manualEntry || '(empty - disable)'}`);
        } else {
            console.log('[GitBranchPicker] User cancelled manual entry');
        }

        return manualEntry;
    }
}
