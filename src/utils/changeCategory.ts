import { Status } from '../types/git';
import type { ChangeCategory, GitDecorationColorKey } from '../types/changeCategory';

export const CATEGORY_PRESETS: Record<ChangeCategory, { badge: string; colorKey: GitDecorationColorKey }> = {
    added: { badge: 'A', colorKey: 'gitDecoration.addedResourceForeground' },
    modified: { badge: 'M', colorKey: 'gitDecoration.modifiedResourceForeground' },
    deleted: { badge: 'D', colorKey: 'gitDecoration.deletedResourceForeground' },
    renamed: { badge: 'R', colorKey: 'gitDecoration.renamedResourceForeground' },
    conflicted: { badge: 'U', colorKey: 'gitDecoration.conflictingResourceForeground' },
    untracked: { badge: '?', colorKey: 'gitDecoration.untrackedResourceForeground' },
    ignored: { badge: '!', colorKey: 'gitDecoration.ignoredResourceForeground' },
    copied: { badge: 'C', colorKey: 'gitDecoration.modifiedResourceForeground' }, // Git has no "copied" color
};

const STATUS_CATEGORIES: Partial<Record<Status, ChangeCategory>> = {
    [Status.INDEX_ADDED]: 'added',
    [Status.INDEX_MODIFIED]: 'modified',
    [Status.INDEX_DELETED]: 'deleted',
    [Status.INDEX_RENAMED]: 'renamed',
    [Status.INDEX_COPIED]: 'copied',

    [Status.MODIFIED]: 'modified',
    [Status.DELETED]: 'deleted',
    [Status.UNTRACKED]: 'untracked',
    [Status.IGNORED]: 'ignored',
    [Status.INTENT_TO_ADD]: 'untracked',
    [Status.TYPE_CHANGED]: 'modified',

    [Status.ADDED_BY_US]: 'conflicted',
    [Status.ADDED_BY_THEM]: 'conflicted',
    [Status.DELETED_BY_US]: 'conflicted',
    [Status.DELETED_BY_THEM]: 'conflicted',
    [Status.BOTH_ADDED]: 'conflicted',
    [Status.BOTH_DELETED]: 'conflicted',
    [Status.BOTH_MODIFIED]: 'conflicted',
};

export function categoryFromStatus(status: Status): ChangeCategory {
    return STATUS_CATEGORIES[status] ?? 'modified';
}
