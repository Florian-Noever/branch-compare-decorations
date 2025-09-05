import * as vscode from 'vscode';
import { BranchCompareProvider } from './branchCompareProvider';
import { GitBranchPicker } from './gitBranchPicker';

let provider: BranchCompareProvider | undefined;
let picker: GitBranchPicker;

export async function activate(context: vscode.ExtensionContext) {
	// Git API
	const gitExt = vscode.extensions.getExtension<any>('vscode.git')?.exports;
	const git = gitExt?.getAPI(1);

	// Decorations
	provider = new BranchCompareProvider();
	context.subscriptions.push(vscode.window.registerFileDecorationProvider(provider));

	// Branch picker
	picker = new GitBranchPicker(git);

	// Commands
	context.subscriptions.push(
		vscode.commands.registerCommand('branchCompare.refresh', refreshDecorations),
		vscode.commands.registerCommand('branchCompare.setBase', setBaseRepo) //todo Bug: Uses old Ref for update
	);

	// Initial compute
	await provider.refresh();
}

export function deactivate() { }

async function refreshDecorations() {
	try {
		await provider!.refresh();
		vscode.window.showInformationMessage('Branch Compare: Decorations refreshed');
	} catch (e: any) {
		vscode.window.showErrorMessage(`Branch Compare: Failed to refresh decorations: ${e.message}`);
	}
}

async function setBaseRepo(): Promise<void> {
	const cfg = vscode.workspace.getConfiguration('branchCompare');
	const current = cfg.get<string>('baseRef', 'origin/dev');

	const chosen = await picker.pickBaseRef(current);
	if (chosen === undefined) {
		return; // cancelled
	}

	await cfg.update('baseRef', chosen, vscode.ConfigurationTarget.Workspace);
	if (!chosen.trim()) {
		vscode.window.showInformationMessage('Branch Compare: disabled.');
	} else {
		vscode.window.showInformationMessage(`Branch Compare: compare to '${chosen}'.`);
	}

	await provider?.refresh();
}
