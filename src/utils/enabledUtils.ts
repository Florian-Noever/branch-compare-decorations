import * as vscode from 'vscode';
import { CONFIG_ENABLED, CONFIG_SECTION } from '../constants';

export function areDecorationsEnabled(): boolean {
    return vscode.workspace.getConfiguration(CONFIG_SECTION).get<boolean>(CONFIG_ENABLED, true);
}

export async function setDecorationsEnabled(enabled: boolean): Promise<void> {
    await vscode.workspace.getConfiguration(CONFIG_SECTION).update(CONFIG_ENABLED, enabled, vscode.ConfigurationTarget.Global);
}
