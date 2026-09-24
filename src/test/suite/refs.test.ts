import * as assert from 'assert';
import { BRANCH_ORIGIN_REF, MAIN_ORIGIN_REF } from '../../constants';
import { describeBaseRef } from '../../utils/baselineResolver';
import { parseRemoteRef } from '../../utils/gitUtils';

suite('parseRemoteRef', () => {
    test('splits a ref of a known remote', () => {
        assert.deepStrictEqual(parseRemoteRef('origin/main', ['origin']), { remote: 'origin', branch: 'main' });
    });

    test('keeps slashes in the branch name', () => {
        assert.deepStrictEqual(parseRemoteRef('upstream/feature/login', ['origin', 'upstream']), { remote: 'upstream', branch: 'feature/login' });
    });

    test('ignores local branches containing a slash', () => {
        assert.strictEqual(parseRemoteRef('feature/login', ['origin']), undefined);
    });

    test('prefers the longest matching remote name', () => {
        assert.deepStrictEqual(parseRemoteRef('team/core/main', ['team', 'team/core']), { remote: 'team/core', branch: 'main' });
    });

    test('requires a branch after the remote', () => {
        assert.strictEqual(parseRemoteRef('origin/', ['origin']), undefined);
        assert.strictEqual(parseRemoteRef('origin', ['origin']), undefined);
    });
});

suite('describeBaseRef', () => {
    test('describes the special base refs instead of showing their sentinel values', () => {
        assert.strictEqual(describeBaseRef(BRANCH_ORIGIN_REF, 'origin/feature'), 'Changes since this branch was created');
        assert.strictEqual(describeBaseRef(MAIN_ORIGIN_REF, 'origin/develop'), 'Changes since branching from origin/develop');
    });

    test('names a configured ref', () => {
        assert.strictEqual(describeBaseRef('origin/main', 'origin/main'), 'Changes vs origin/main');
    });
});
