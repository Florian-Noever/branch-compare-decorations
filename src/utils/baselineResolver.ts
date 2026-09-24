import type { API as GitAPI, Repository } from '../types/git';
import { BRANCH_ORIGIN_REF, MAIN_BRANCH_NAMES, MAIN_ORIGIN_REF } from '../constants';
import { getCommitTimestamp, getForkPointOrMergeBase, getMainBranches } from './gitUtils';

export function getUpstreamRef(repository: Repository): string | undefined {
    const upstream = repository.state.HEAD?.upstream;
    if (!upstream?.name) {
        return undefined;
    }
    return upstream.remote ? `${upstream.remote}/${upstream.name}` : upstream.name;
}

/** Replaces the special base ref sentinels with a real ref */
export async function resolveSpecialBaseRef(repository: Repository, baseRef: string, upstreamRef: string | undefined): Promise<string> {
    if (baseRef === BRANCH_ORIGIN_REF) {
        // The branch itself (or its upstream) makes computeBaseline use the latest fork point from a
        // main development branch, which also works for branches that were never pushed
        return upstreamRef ?? repository.state.HEAD?.name ?? baseRef;
    }
    if (baseRef === MAIN_ORIGIN_REF) {
        const [mainBranch] = await getMainBranches(repository);
        if (!mainBranch) {
            throw new Error(`No main development branch (${MAIN_BRANCH_NAMES.join(', ')}) found`);
        }
        return mainBranch;
    }
    return baseRef;
}

/** Decoration tooltip for a configured base ref and the ref it resolved to */
export function describeBaseRef(configuredRef: string, resolvedRef: string): string {
    switch (configuredRef) {
        case BRANCH_ORIGIN_REF:
            return 'Changes since this branch was created';
        case MAIN_ORIGIN_REF:
            return `Changes since branching from ${resolvedRef}`;
        default:
            return `Changes vs ${configuredRef}`;
    }
}

/**
 * The commit to diff HEAD against. Comparing a branch with itself or its own upstream would show
 * nothing, so then the most recent fork point from any other main development branch is used instead.
 */
export async function computeBaseline(gitApi: GitAPI, repository: Repository, branchName: string, baseRef: string, upstreamRef: string | undefined): Promise<string> {
    let baseline: string | undefined;
    if (isSameBranch(repository, branchName, baseRef, upstreamRef)) {
        const candidates = (await getMainBranches(repository)).filter(name => name !== branchName && name !== upstreamRef);
        baseline = await selectLatestForkPoint(gitApi, repository, branchName, candidates);
    } else {
        baseline = await getForkPointOrMergeBase(gitApi, repository, baseRef, branchName);
    }
    return baseline ?? baseRef;
}

function isSameBranch(repository: Repository, branchName: string, baseRef: string, upstreamRef: string | undefined): boolean {
    return baseRef === upstreamRef || baseRef === branchName || baseRef === repository.state.HEAD?.upstream?.name;
}

async function selectLatestForkPoint(gitApi: GitAPI, repository: Repository, branchName: string, candidates: string[]): Promise<string | undefined> {
    let latestForkPoint: string | undefined;
    let latestTimestamp = -1;

    for (const candidate of candidates) {
        const forkPoint = await getForkPointOrMergeBase(gitApi, repository, candidate, branchName);
        if (!forkPoint) {
            continue;
        }
        const timestamp = await getCommitTimestamp(gitApi, repository, forkPoint);
        if (timestamp > latestTimestamp) {
            latestTimestamp = timestamp;
            latestForkPoint = forkPoint;
        }
    }

    return latestForkPoint;
}
