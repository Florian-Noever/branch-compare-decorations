import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';

export interface FixtureWorkspace {
    rootPath: string;
    workspaceFile: string;
}

/**
 * Creates a multi-root workspace with two repositories:
 * - repoA: pushed to a local bare "origin"; branch `feature` (with upstream) adds, modifies, deletes
 *   and renames files compared to `main`. `src/foobar.txt` changes next to an unchanged `src/foo/`.
 * - repoB: no remote; branch `topic` modifies and adds a file compared to `main`.
 */
export function createFixtureWorkspace(): FixtureWorkspace {
    const rootPath = fs.mkdtempSync(path.join(os.tmpdir(), 'branch-compare-decorations-'));
    // Isolate git from the user's global and system configuration (hooks, signing, default branch)
    const emptyConfig = path.join(rootPath, '.gitconfig');
    fs.writeFileSync(emptyConfig, '');
    const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=Branch Compare Decorations Tests', '-c', 'user.email=tests@example.com', ...args], {
        cwd,
        env: { ...process.env, GIT_CONFIG_GLOBAL: emptyConfig, GIT_CONFIG_NOSYSTEM: '1' },
        stdio: 'pipe',
    });

    const originA = path.join(rootPath, 'originA.git');
    const repoA = path.join(rootPath, 'repoA');
    git(rootPath, 'init', '--bare', '-b', 'main', originA);
    git(rootPath, 'init', '-b', 'main', repoA);
    writeFiles(repoA, {
        'modified.txt': 'original\n',
        'deleted.txt': 'deleted on feature\n',
        'renamed-before.txt': 'renamed on feature, content unchanged\n',
        'unchanged.txt': 'unchanged\n',
        'src/foo/x.txt': 'unchanged\n',
        'src/foobar.txt': 'original\n',
        'lib/deep/nested/file.txt': 'original\n',
    });
    git(repoA, 'add', '-A');
    git(repoA, 'commit', '-m', 'Initial commit');
    git(repoA, 'remote', 'add', 'origin', originA);
    git(repoA, 'push', '-u', 'origin', 'main');

    git(repoA, 'checkout', '-b', 'feature');
    writeFiles(repoA, {
        'modified.txt': 'changed on feature\n',
        'added.txt': 'added on feature\n',
        'src/foobar.txt': 'changed on feature\n',
        'lib/deep/nested/file.txt': 'changed on feature\n',
    });
    git(repoA, 'rm', '-q', 'deleted.txt');
    git(repoA, 'mv', 'renamed-before.txt', 'renamed-after.txt');
    git(repoA, 'add', '-A');
    git(repoA, 'commit', '-m', 'Feature work');
    git(repoA, 'push', '-u', 'origin', 'feature');

    const repoB = path.join(rootPath, 'repoB');
    git(rootPath, 'init', '-b', 'main', repoB);
    writeFiles(repoB, { 'b.txt': 'original\n' });
    git(repoB, 'add', '-A');
    git(repoB, 'commit', '-m', 'Initial commit');
    git(repoB, 'checkout', '-b', 'topic');
    writeFiles(repoB, {
        'b.txt': 'changed on topic\n',
        'topic.txt': 'added on topic\n',
    });
    git(repoB, 'add', '-A');
    git(repoB, 'commit', '-m', 'Topic work');

    const workspaceFile = path.join(rootPath, 'fixture.code-workspace');
    fs.writeFileSync(workspaceFile, JSON.stringify({
        folders: [{ path: 'repoA' }, { path: 'repoB' }],
        settings: {
            'git.autofetch': false,
            'git.openRepositoryInParentFolders': 'never',
        },
    }, undefined, 4));

    return { rootPath, workspaceFile };
}

function writeFiles(repositoryPath: string, files: Record<string, string>): void {
    for (const [relativePath, content] of Object.entries(files)) {
        const filePath = path.join(repositoryPath, relativePath);
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, content);
    }
}
