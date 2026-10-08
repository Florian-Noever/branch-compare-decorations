import * as assert from 'assert';
import * as path from 'path';
import * as vscode from 'vscode';
import type { API as GitAPI, GitExtension } from '../../types/git';
import { BRANCH_ORIGIN_REF, COMMAND_ACTIVATE, COMMAND_DEACTIVATE, CONFIG_BASE_REFS, CONFIG_ENABLED, CONFIG_SECTION, MAIN_ORIGIN_REF } from '../../constants';
import { BranchCompareProvider } from '../../utils/branchCompareProvider';
import { areDecorationsEnabled, setDecorationsEnabled } from '../../utils/enabledUtils';
import { normalizeFsPath } from '../../utils/pathUtils';

suite('Branch Compare Decorations integration', () => {
    let gitApi: GitAPI;
    let provider: BranchCompareProvider;
    let repoA: string;
    let repoB: string;

    suiteSetup(async () => {
        const gitExtension = vscode.extensions.getExtension<GitExtension>('vscode.git');
        assert.ok(gitExtension, 'The built-in Git extension is missing');
        gitApi = (await gitExtension.activate()).getAPI(1);

        repoA = getWorkspaceFolderPath('repoA');
        repoB = getWorkspaceFolderPath('repoB');
        await waitFor(
            () => [repoA, repoB].every(root => gitApi.getRepository(vscode.Uri.file(root))?.state.HEAD?.name),
            'Git did not open both fixture repositories'
        );

        await vscode.commands.executeCommand('workbench.action.closeAllEditors');
        provider = new BranchCompareProvider(gitApi);
    });

    suiteTeardown(async () => {
        provider?.dispose();
        await vscode.workspace.getConfiguration(CONFIG_SECTION).update(CONFIG_BASE_REFS, undefined, vscode.ConfigurationTarget.Global);
        await vscode.workspace.getConfiguration(CONFIG_SECTION).update(CONFIG_ENABLED, undefined, vscode.ConfigurationTarget.Global);
    });

    test('decorates the changes of the feature branch against origin/main', async () => {
        await setBaseRefs({ feature: 'origin/main' });

        assert.strictEqual(badge(repoA, 'modified.txt'), 'M');
        assert.strictEqual(badge(repoA, 'added.txt'), 'A');
        assert.strictEqual(badge(repoA, 'deleted.txt'), 'D');
        assert.strictEqual(badge(repoA, 'renamed-after.txt'), 'R');
        assert.strictEqual(badge(repoA, 'src/foobar.txt'), 'M');
        assert.strictEqual(badge(repoA, 'unchanged.txt'), undefined);
        assert.strictEqual(badge(repoA, 'src/foo/x.txt'), undefined);
        assert.strictEqual(decoration(repoA, 'modified.txt')?.tooltip, 'Changes vs origin/main');
    });

    test('decorates every folder containing changes', async () => {
        await setBaseRefs({ feature: 'origin/main' });

        for (const folder of ['lib/deep/nested', 'lib/deep', 'lib', 'src', '']) {
            assert.strictEqual(badge(repoA, folder), 'M', `folder '${folder}'`);
        }
    });

    test('does not decorate a folder that only shares a name prefix with a changed file', async () => {
        await setBaseRefs({ feature: 'origin/main' });

        assert.strictEqual(badge(repoA, 'src/foo'), undefined);
    });

    test('an empty base ref disables the decorations', async () => {
        await setBaseRefs({ feature: '' });

        assert.strictEqual(badge(repoA, 'modified.txt'), undefined);
        assert.strictEqual(badge(repoA, 'src'), undefined);
    });

    test('Current Branch Origin compares against the fork point from main', async () => {
        await setBaseRefs({ feature: BRANCH_ORIGIN_REF });

        assert.strictEqual(badge(repoA, 'modified.txt'), 'M');
        assert.strictEqual(badge(repoA, 'unchanged.txt'), undefined);
        assert.strictEqual(decoration(repoA, 'modified.txt')?.tooltip, 'Changes since this branch was created');
    });

    test('Current Branch Origin works for a branch that was never pushed', async () => {
        await setBaseRefs({ topic: BRANCH_ORIGIN_REF });

        assert.strictEqual(badge(repoB, 'b.txt'), 'M');
        assert.strictEqual(badge(repoB, 'topic.txt'), 'A');
    });

    test('Main Development Branch resolves to the main branch of the remote', async () => {
        await setBaseRefs({ feature: MAIN_ORIGIN_REF });

        assert.strictEqual(badge(repoA, 'modified.txt'), 'M');
        assert.strictEqual(decoration(repoA, 'modified.txt')?.tooltip, 'Changes since branching from origin/main');
    });

    test('each repository uses the base ref of its own branch, whichever editor is active', async () => {
        await setBaseRefs({ feature: 'origin/main', topic: 'main' });
        assertBothRepositoriesDecorated();

        await vscode.window.showTextDocument(vscode.Uri.file(path.join(repoB, 'b.txt')));
        await provider.refresh();
        assertBothRepositoriesDecorated();
        await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    });

    test('an invalid base ref only affects its own repository', async () => {
        await setBaseRefs({});
        await setBaseRefs({ feature: 'origin/main', topic: 'does-not-exist' });

        assert.strictEqual(badge(repoA, 'modified.txt'), 'M');
        assert.strictEqual(badge(repoB, 'b.txt'), undefined);
    });

    test('fires decoration events only for paths whose decoration changed', async () => {
        await setBaseRefs({});
        const events: (vscode.Uri[] | undefined)[] = [];
        const subscription = provider.onDidChangeFileDecorations(uris => events.push(uris));
        try {
            await setBaseRefs({ feature: 'origin/main' });
            assert.ok(events.length > 0 && events.every(uris => uris !== undefined), 'Expected events listing the changed paths');
            const changedPaths = events.flatMap(uris => uris ?? []).map(uri => normalizeFsPath(uri.fsPath));
            assert.ok(changedPaths.includes(normalizeFsPath(path.join(repoA, 'modified.txt'))));
            assert.ok(changedPaths.includes(normalizeFsPath(path.join(repoA, 'lib'))));
            assert.ok(!changedPaths.includes(normalizeFsPath(path.join(repoA, 'unchanged.txt'))));

            events.length = 0;
            await provider.refresh();
            assert.deepStrictEqual(events, [], 'A refresh without changes must not fire events');
        } finally {
            subscription.dispose();
        }
    });

    test('deactivating removes every decoration and activating restores them', async () => {
        await setBaseRefs({ feature: 'origin/main', topic: 'main' });
        assertBothRepositoriesDecorated();
        const events: (vscode.Uri[] | undefined)[] = [];
        const subscription = provider.onDidChangeFileDecorations(uris => events.push(uris));
        try {
            await setEnabled(false);
            assert.strictEqual(badge(repoA, 'modified.txt'), undefined);
            assert.strictEqual(badge(repoA, 'lib'), undefined);
            assert.strictEqual(badge(repoB, 'b.txt'), undefined);
            const changedPaths = events.flatMap(uris => uris ?? []).map(uri => normalizeFsPath(uri.fsPath));
            assert.ok(events.includes(undefined) || changedPaths.includes(normalizeFsPath(path.join(repoA, 'modified.txt'))), 'Expected events for the previously decorated paths');
        } finally {
            subscription.dispose();
            await setEnabled(true);
        }
        assertBothRepositoriesDecorated();
    });

    test('the Deactivate and Activate commands switch the setting', async () => {
        try {
            await vscode.commands.executeCommand(COMMAND_DEACTIVATE);
            await waitFor(() => !areDecorationsEnabled(), 'Deactivate did not turn the decorations off');

            await vscode.commands.executeCommand(COMMAND_ACTIVATE);
            await waitFor(() => areDecorationsEnabled(), 'Activate did not turn the decorations on');
        } finally {
            await setEnabled(true);
        }
    });

    function assertBothRepositoriesDecorated(): void {
        assert.strictEqual(badge(repoA, 'modified.txt'), 'M');
        assert.strictEqual(badge(repoB, 'b.txt'), 'M');
        assert.strictEqual(badge(repoB, 'topic.txt'), 'A');
        assert.strictEqual(decoration(repoB, 'b.txt')?.tooltip, 'Changes vs main');
    }

    async function setBaseRefs(baseRefs: Record<string, string>): Promise<void> {
        await vscode.workspace.getConfiguration(CONFIG_SECTION).update(CONFIG_BASE_REFS, baseRefs, vscode.ConfigurationTarget.Global);
        await waitFor(
            () => JSON.stringify(vscode.workspace.getConfiguration(CONFIG_SECTION).get(CONFIG_BASE_REFS)) === JSON.stringify(baseRefs),
            'The base refs setting was not applied'
        );
        await provider.refresh();
    }

    async function setEnabled(enabled: boolean): Promise<void> {
        await setDecorationsEnabled(enabled);
        await waitFor(() => areDecorationsEnabled() === enabled, 'The enabled setting was not applied');
        await provider.refresh();
    }

    function decoration(root: string, relativePath: string): vscode.FileDecoration | undefined {
        return provider.provideFileDecoration(vscode.Uri.file(path.join(root, relativePath)));
    }

    function badge(root: string, relativePath: string): string | undefined {
        return decoration(root, relativePath)?.badge;
    }
});

function getWorkspaceFolderPath(name: string): string {
    const folder = vscode.workspace.workspaceFolders?.find(candidate => candidate.name === name);
    assert.ok(folder, `Workspace folder '${name}' is missing`);
    return folder.uri.fsPath;
}

async function waitFor(condition: () => unknown, message: string, timeoutMs = 30_000): Promise<void> {
    const start = Date.now();
    while (!condition()) {
        if (Date.now() - start > timeoutMs) {
            throw new Error(message);
        }
        await new Promise(resolve => setTimeout(resolve, 100));
    }
}
