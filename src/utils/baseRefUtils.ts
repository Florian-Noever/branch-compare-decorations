import * as vscode from 'vscode';
import { CONFIG_BASE_REFS, CONFIG_SECTION } from '../constants';

function getBaseRefs(): Record<string, string> {
    return vscode.workspace.getConfiguration(CONFIG_SECTION).get<Record<string, string>>(CONFIG_BASE_REFS, {});
}

export function getBaseRefForBranch(branchName: string): string {
    return getBaseRefs()[branchName] ?? '';
}

export async function setBaseRefForBranch(branchName: string, baseRef: string): Promise<void> {
    const baseRefs = { ...getBaseRefs(), [branchName]: baseRef };
    await vscode.workspace.getConfiguration(CONFIG_SECTION).update(CONFIG_BASE_REFS, baseRefs, vscode.ConfigurationTarget.Global);
}
