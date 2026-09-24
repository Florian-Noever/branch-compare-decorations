import * as assert from 'assert';
import { Status } from '../../types/git';
import { CATEGORY_PRESETS, categoryFromStatus } from '../../utils/changeCategory';

suite('changeCategory', () => {
    test('every Git status maps to the badge of the built-in Git decorations', () => {
        const expectedBadges: [string, Status, string][] = [
            ['INDEX_MODIFIED', Status.INDEX_MODIFIED, 'M'],
            ['INDEX_ADDED', Status.INDEX_ADDED, 'A'],
            ['INDEX_DELETED', Status.INDEX_DELETED, 'D'],
            ['INDEX_RENAMED', Status.INDEX_RENAMED, 'R'],
            ['INDEX_COPIED', Status.INDEX_COPIED, 'C'],
            ['MODIFIED', Status.MODIFIED, 'M'],
            ['DELETED', Status.DELETED, 'D'],
            ['UNTRACKED', Status.UNTRACKED, '?'],
            ['IGNORED', Status.IGNORED, '!'],
            ['INTENT_TO_ADD', Status.INTENT_TO_ADD, '?'],
            ['INTENT_TO_RENAME', Status.INTENT_TO_RENAME, 'M'],
            ['TYPE_CHANGED', Status.TYPE_CHANGED, 'M'],
            ['ADDED_BY_US', Status.ADDED_BY_US, 'U'],
            ['ADDED_BY_THEM', Status.ADDED_BY_THEM, 'U'],
            ['DELETED_BY_US', Status.DELETED_BY_US, 'U'],
            ['DELETED_BY_THEM', Status.DELETED_BY_THEM, 'U'],
            ['BOTH_ADDED', Status.BOTH_ADDED, 'U'],
            ['BOTH_DELETED', Status.BOTH_DELETED, 'U'],
            ['BOTH_MODIFIED', Status.BOTH_MODIFIED, 'U'],
        ];

        for (const [name, status, badge] of expectedBadges) {
            assert.strictEqual(CATEGORY_PRESETS[categoryFromStatus(status)].badge, badge, `Status.${name}`);
        }
    });

    test('every category uses a theme color of the built-in Git decorations', () => {
        for (const { colorKey } of Object.values(CATEGORY_PRESETS)) {
            assert.ok(colorKey.startsWith('gitDecoration.'), colorKey);
        }
    });
});
