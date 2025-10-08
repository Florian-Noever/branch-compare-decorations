import * as vscode from 'vscode';
import type { API, Repository } from '../types/git';

export class GitUtils {
    static getGitApi(): API | undefined {
        const gitExt = vscode.extensions.getExtension<any>('vscode.git')?.exports;
        return gitExt?.getAPI(1);
    }

    static getCurrBranch(): Repository | undefined {
        const api = GitUtils.getGitApi();
        if (!api) {
            return undefined;
        }

        const repos = api.repositories;
        if (repos.length === 0) {
            return undefined;
        }
        if (repos.length === 1) {
            return repos[0];
        }

        const activeUri = vscode.window.activeTextEditor?.document.uri;
        const activeRepo = activeUri && api.getRepository(activeUri);
        return activeRepo ?? undefined;
    }

    static getBranchName(repo: Repository): string | undefined {
        return repo.state.HEAD?.name;
    }
}