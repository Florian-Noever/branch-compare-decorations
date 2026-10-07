import pkg from '../package.json';

export const MANIFEST = pkg;

export const COMMAND_SET_BASE = pkg.contributes.commands[0].command;
export const COMMAND_REFRESH = pkg.contributes.commands[1].command;

export const CONFIG_SECTION = 'branchCompareDecorations';
export const CONFIG_BASE_REFS = 'baseRefs';
export const CONFIG_AUTO_FETCH = 'autoFetch';

/** Base ref sentinel: all changes since the current branch was created */
export const BRANCH_ORIGIN_REF = '__branch_origin__';
/** Base ref sentinel: all changes since branching from the main development branch */
export const MAIN_ORIGIN_REF = '__main_origin__';

/** Main development branch names, in detection priority */
export const MAIN_BRANCH_NAMES = ['dev', 'develop', 'main', 'master'];

export const REFRESH_DEBOUNCE_MS = 150;
export const FETCH_COOLDOWN_MS = 30_000;
export const MAX_CONCURRENT_REPOSITORIES = 3;
/** Above this many URIs a single "everything changed" event is cheaper than listing them */
export const MAX_DECORATION_EVENT_URIS = 500;
