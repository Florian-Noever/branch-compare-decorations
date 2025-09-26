import * as vscode from 'vscode';
import { BranchCompareProvider } from './models/branchCompareProvider';
import { GitBranchPicker } from './models/gitBranchPicker';
import { GitUtils } from './utils/gitUtils';
import { BaseRefUtils } from './utils/baseRefUtils';

export const EXTENSION = 'branchCompare';
export const CONFIG_BASEREFS = 'baseRefs';
export const CONFIG_AUTOFETCH = 'autoFetch';
export const COMMAND_REFRESH = 'refresh';
export const COMMAND_SETBASE = 'setBase';

let provider: BranchCompareProvider | undefined;
let picker: GitBranchPicker;

export async function activate(context: vscode.ExtensionContext) {
	// Decorations
	provider = new BranchCompareProvider();
	context.subscriptions.push(vscode.window.registerFileDecorationProvider(provider));

	// Branch picker
	picker = new GitBranchPicker();

	// Commands
	context.subscriptions.push(
		vscode.commands.registerCommand(EXTENSION + '.' + COMMAND_REFRESH, refreshDecorations),
		vscode.commands.registerCommand(EXTENSION + '.' + COMMAND_SETBASE, setBaseRepo)
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
	let currBranchName = '';
	let currBaseRef = '';

	try {
		const currBranch = GitUtils.getCurrBranch();
		currBranchName = GitUtils.getBranchName(currBranch!) ?? '';
		currBaseRef = BaseRefUtils.getCurrBaseRef();
	} catch (e) {
		vscode.window.showErrorMessage(`Branch Compare: Failed to get current repository: ${e}`);
		return;
	}

	const chosen = await picker.pickBaseRef(currBaseRef);
	if (chosen === undefined) {
		return; // cancelled
	}

	await BaseRefUtils.addOrUpdateBaseRef(currBranchName, chosen);

	if (!chosen.trim()) {
		vscode.window.showInformationMessage('Branch Compare: disabled.');
	} else {
		vscode.window.showInformationMessage(`Branch Compare: compare to '${chosen}'.`);
	}

	await provider?.refresh();
}
