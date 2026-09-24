export type ChangeCategory =
    | 'added'
    | 'modified'
    | 'deleted'
    | 'renamed'
    | 'conflicted'
    | 'untracked'
    | 'ignored'
    | 'copied';

export type GitDecorationColorKey =
    | 'gitDecoration.addedResourceForeground'
    | 'gitDecoration.modifiedResourceForeground'
    | 'gitDecoration.deletedResourceForeground'
    | 'gitDecoration.renamedResourceForeground'
    | 'gitDecoration.conflictingResourceForeground'
    | 'gitDecoration.untrackedResourceForeground'
    | 'gitDecoration.ignoredResourceForeground';
