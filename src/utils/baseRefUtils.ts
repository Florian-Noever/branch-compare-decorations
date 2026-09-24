import * as vscode from 'vscode';
import type { API as GitAPI } from '../types/git';
import { CONFIG_BASE_REFS, CONFIG_SECTION } from '../constants';
import { getActiveRepository } from './gitUtils';

function getBaseRefs(): Record<string, string> {
    return vscode.workspace.getConfiguration(CONFIG_SECTION).get<Record<string, string>>(CONFIG_BASE_REFS, {});
}

export function getBaseRefForBranch(branchName: string): string {
    return getBaseRefs()[branchName] ?? '';
}

/** Base ref configured for the current branch of the active repository */
export function getCurrentBaseRef(gitApi: GitAPI): string {
    const branchName = getActiveRepository(gitApi)?.state.HEAD?.name;
    return branchName ? getBaseRefForBranch(branchName) : '';
}

export async function setBaseRefForBranch(branchName: string, baseRef: string): Promise<void> {
    const baseRefs = { ...getBaseRefs(), [branchName]: baseRef };
    await vscode.workspace.getConfiguration(CONFIG_SECTION).update(CONFIG_BASE_REFS, baseRefs, vscode.ConfigurationTarget.Global);
}
