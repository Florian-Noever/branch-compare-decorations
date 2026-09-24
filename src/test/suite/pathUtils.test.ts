import * as assert from 'assert';
import * as os from 'os';
import * as path from 'path';
import { getAncestorDirs, isPathInside, normalizeFsPath } from '../../utils/pathUtils';

suite('pathUtils', () => {
    const root = normalizeFsPath(path.join(os.tmpdir(), 'workspace'));

    test('isPathInside accepts the path itself and its descendants', () => {
        assert.ok(isPathInside(root, root));
        assert.ok(isPathInside(root, path.join(root, 'src', 'a.ts')));
    });

    test('isPathInside respects path boundaries', () => {
        assert.ok(!isPathInside(path.join(root, 'src', 'foo'), path.join(root, 'src', 'foobar.ts')));
        assert.ok(!isPathInside(path.join(root, 'src'), root));
    });

    test('isPathInside handles a file system root', () => {
        assert.ok(isPathInside(path.parse(root).root, root));
    });

    test('getAncestorDirs lists the folders up to and including the root', () => {
        assert.deepStrictEqual(
            getAncestorDirs(path.join(root, 'a', 'b', 'file.txt'), [root]),
            [path.join(root, 'a', 'b'), path.join(root, 'a'), root]
        );
    });

    test('getAncestorDirs ignores files outside the roots', () => {
        assert.deepStrictEqual(getAncestorDirs(path.join(`${root}-other`, 'file.txt'), [root]), []);
    });

    test('getAncestorDirs continues into an enclosing root', () => {
        const nestedRoot = path.join(root, 'nested');
        assert.deepStrictEqual(getAncestorDirs(path.join(nestedRoot, 'file.txt'), [nestedRoot, root]), [nestedRoot, root]);
    });

    test('normalizeFsPath ignores case on Windows only', () => {
        const upper = path.join(os.tmpdir(), 'Repo', 'File.TXT');
        const lower = path.join(os.tmpdir(), 'repo', 'file.txt');
        assert.strictEqual(normalizeFsPath(upper) === normalizeFsPath(lower), process.platform === 'win32');
    });
});
