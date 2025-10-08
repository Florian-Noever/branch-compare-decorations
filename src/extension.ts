import * as vscode from 'vscode';
import { BranchCompareProvider } from './models/branchCompareProvider';
import { GitBranchPicker } from './models/gitBranchPicker';
import { GitUtils } from './utils/gitUtils';
import { BaseRefUtils } from './utils/baseRefUtils';

export const EXTENSION = 'branchCompare';
export const EXTENSION_NAME = 'Branch Compare';
export const CONFIG_BASEREFS = 'baseRefs';
export const CONFIG_AUTOFETCH = 'autoFetch';
export const COMMAND_REFRESH = 'refresh';
export const COMMAND_SETBASE = 'setBase';

let provider: BranchCompareProvider | undefined;
let picker: GitBranchPicker;

export let log: vscode.LogOutputChannel;

export async function activate(context: vscode.ExtensionContext) {
	// Output channel
	log = vscode.window.createOutputChannel(EXTENSION_NAME, { log: true });
	context.subscriptions.push(log);

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
}

export function deactivate() { }

async function refreshDecorations() {
	try {
		await provider!.refresh();
		vscode.window.showInformationMessage(`${EXTENSION_NAME}: Decorations refreshed`);
	} catch (e: any) {
		vscode.window.showErrorMessage(`${EXTENSION_NAME}: Failed to refresh decorations: ${e.message}`);
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
		vscode.window.showErrorMessage(`${EXTENSION_NAME}: Failed to get current repository: ${e}`);
		return;
	}

	const chosen = await picker.pickBaseReference(currBaseRef);
	if (chosen === undefined) {
		return; // cancelled
	}

	await BaseRefUtils.addOrUpdateBaseRef(currBranchName, chosen);

	if (!chosen.trim()) {
		vscode.window.showInformationMessage(`${EXTENSION_NAME}: disabled.`);
	} else {
		vscode.window.showInformationMessage(`${EXTENSION_NAME}: compare to '${chosen}'.`);
	}

	await provider?.refresh();
}
