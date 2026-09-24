import * as vscode from 'vscode';
import { execFile } from 'child_process';
import { promisify } from 'util';
import type { API as GitAPI, GitExtension, Repository } from '../types/git';
import { MAIN_BRANCH_NAMES } from '../constants';
import { errorMessage } from './errors';
import { Logger } from './logger';

const execFileAsync = promisify(execFile);

export function getGitApi(): GitAPI | undefined {
    return vscode.extensions.getExtension<GitExtension>('vscode.git')?.exports?.getAPI(1);
}

/** The only open repository, or the one containing the active editor */
export function getActiveRepository(gitApi: GitAPI): Repository | undefined {
    if (gitApi.repositories.length <= 1) {
        return gitApi.repositories[0];
    }
    const activeUri = vscode.window.activeTextEditor?.document.uri;
    return (activeUri && gitApi.getRepository(activeUri)) ?? undefined;
}

async function runGit(gitApi: GitAPI, repository: Repository, args: string[]): Promise<string> {
    const { stdout } = await execFileAsync(gitApi.git.path, args, { cwd: repository.rootUri.fsPath });
    return stdout.trim();
}

/**
 * The commit `branchName` forked from `baseRef`. `--fork-point` also consults the reflog of `baseRef`,
 * so it stays correct after `baseRef` was rebased; a plain merge-base is the fallback.
 */
export async function getForkPointOrMergeBase(gitApi: GitAPI, repository: Repository, baseRef: string, branchName: string): Promise<string | undefined> {
    try {
        const forkPoint = await runGit(gitApi, repository, ['merge-base', '--fork-point', baseRef, branchName]);
        if (forkPoint) {
            return forkPoint;
        }
    } catch (e) {
        Logger.debug(`No fork point of ${branchName} from ${baseRef}, trying merge-base: ${errorMessage(e)}`);
    }

    try {
        const mergeBase = await repository.getMergeBase(baseRef, branchName);
        if (!mergeBase) {
            throw new Error('Merge base is null');
        }
        return mergeBase;
    } catch {
        Logger.error(`Failed to find merge base between ${baseRef} and ${branchName}`);
        return undefined;
    }
}

/** Unix commit timestamp, or -1 if it can't be read */
export async function getCommitTimestamp(gitApi: GitAPI, repository: Repository, commit: string): Promise<number> {
    try {
        const timestamp = Number(await runGit(gitApi, repository, ['show', '-s', '--format=%ct', commit]));
        return isNaN(timestamp) ? -1 : timestamp;
    } catch (e) {
        Logger.warn(`Failed to read the timestamp of commit ${commit}: ${errorMessage(e)}`);
        return -1;
    }
}

/** The first `origin/<name>` of MAIN_BRANCH_NAMES that exists */
export async function findMainBranch(repository: Repository): Promise<string | undefined> {
    try {
        const branchNames = new Set((await repository.getBranches({ remote: true })).map(branch => branch.name));
        return MAIN_BRANCH_NAMES.map(name => `origin/${name}`).find(name => branchNames.has(name));
    } catch (e) {
        Logger.error(`Failed to find the main development branch: ${errorMessage(e)}`);
        return undefined;
    }
}

/** Remote main development branches that exist, plus the local names as a fallback */
export async function getMainBranchCandidates(repository: Repository): Promise<string[]> {
    const remoteCandidates = MAIN_BRANCH_NAMES.map(name => `origin/${name}`);
    try {
        const branchNames = new Set((await repository.getBranches({ remote: true })).map(branch => branch.name));
        return [...remoteCandidates.filter(name => branchNames.has(name)), ...MAIN_BRANCH_NAMES];
    } catch (e) {
        Logger.warn(`Failed to list branches, using the default candidates: ${errorMessage(e)}`);
        return [...remoteCandidates, ...MAIN_BRANCH_NAMES];
    }
}
