import * as vscode from 'vscode';
import { execFile } from 'child_process';
import { promisify } from 'util';
import type { API as GitAPI, GitExtension, Repository } from '../types/git';
import { MAIN_BRANCH_NAMES } from '../constants';
import { errorMessage } from './errors';
import { Logger } from './logger';

const execFileAsync = promisify(execFile);

export function getGitApi(): GitAPI | undefined {
    const gitExtension = vscode.extensions.getExtension<GitExtension>('vscode.git')?.exports;
    // getAPI throws while Git is turned off with the `git.enabled` setting
    return gitExtension?.enabled ? gitExtension.getAPI(1) : undefined;
}

/**
 * Splits `remote/branch` when the prefix is one of `remoteNames`. Local branches such as
 * `feature/login` yield undefined.
 */
export function parseRemoteRef(ref: string, remoteNames: readonly string[]): { remote: string; branch: string } | undefined {
    // Longest name first: remote names may contain slashes themselves
    const remote = [...remoteNames]
        .sort((a, b) => b.length - a.length)
        .find(name => ref.startsWith(`${name}/`) && ref.length > name.length + 1);
    return remote ? { remote, branch: ref.slice(remote.length + 1) } : undefined;
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
        return await repository.getMergeBase(baseRef, branchName);
    } catch (e) {
        Logger.debug(`No merge base of ${branchName} and ${baseRef}: ${errorMessage(e)}`);
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

/** The remote of HEAD's upstream, otherwise `origin`, otherwise the first remote */
export function getPreferredRemote(repository: Repository): string | undefined {
    const remoteNames = repository.state.remotes.map(remote => remote.name);
    const upstreamRemote = repository.state.HEAD?.upstream?.remote;
    if (upstreamRemote && remoteNames.includes(upstreamRemote)) {
        return upstreamRemote;
    }
    return remoteNames.includes('origin') ? 'origin' : remoteNames[0];
}

/**
 * The existing main development branches in MAIN_BRANCH_NAMES priority, those of the preferred
 * remote before local ones.
 */
export async function getMainBranches(repository: Repository): Promise<string[]> {
    const branchNames = new Set((await repository.getBranches({ remote: true })).map(branch => branch.name));
    const remote = getPreferredRemote(repository);
    const remoteNames = remote ? MAIN_BRANCH_NAMES.map(name => `${remote}/${name}`) : [];
    return [...remoteNames, ...MAIN_BRANCH_NAMES].filter(name => branchNames.has(name));
}
