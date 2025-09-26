import * as vscode from 'vscode';
import { CONFIG_BASEREFS, EXTENSION } from '../extension';
import { GitUtils } from './gitUtils';

export class BaseRefUtils {
    static get baseRefs(): Record<string, string> {
        const cfg = vscode.workspace.getConfiguration(EXTENSION);
        const current = cfg.get<Record<string, string>>(CONFIG_BASEREFS, {});
        return current;
    }
    static set baseRefs(current: Record<string, string>) {
        const cfg = vscode.workspace.getConfiguration(EXTENSION);
        void cfg.update(CONFIG_BASEREFS, current, vscode.ConfigurationTarget.Global);
    }

    static getCurrBaseRef(): string {
        const currBranch = GitUtils.getCurrBranch();
        if (!currBranch) {
            return '';
        }
        const currBranchName = GitUtils.getBranchName(currBranch) ?? '';

        const cfg = vscode.workspace.getConfiguration(EXTENSION);

        const current = cfg.get<Record<string, string>>(CONFIG_BASEREFS, {});
        return current[currBranchName] ?? '';
    }

    static addOrUpdateBaseRef(repoName: string, baseRef: string) {
        return this.addOrUpdateBaseRefAsync(repoName, baseRef);
    }

    static async addOrUpdateBaseRefAsync(repoName: string, baseRef: string) {
        const current = this.baseRefs;
        current[repoName] = baseRef;

        const cfg = vscode.workspace.getConfiguration(EXTENSION);
        await cfg.update(CONFIG_BASEREFS, current, vscode.ConfigurationTarget.Global);
    }
}