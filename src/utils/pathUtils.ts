import * as path from 'path';

const IS_WINDOWS = process.platform === 'win32';

/** Absolute path usable as a map key: lower-cased on Windows, whose file system is case-insensitive */
export function normalizeFsPath(fsPath: string): string {
    const absolutePath = path.resolve(fsPath);
    return IS_WINDOWS ? absolutePath.toLowerCase() : absolutePath;
}

/** Whether `descendantPath` equals `ancestorPath` or lies below it. Both must be normalized. */
export function isPathInside(ancestorPath: string, descendantPath: string): boolean {
    if (descendantPath === ancestorPath) {
        return true;
    }
    const ancestorWithSeparator = ancestorPath.endsWith(path.sep) ? ancestorPath : ancestorPath + path.sep;
    return descendantPath.startsWith(ancestorWithSeparator);
}

/** Folders from the parent of `filePath` up to the outermost root containing it. Paths must be normalized. */
export function getAncestorDirs(filePath: string, rootPaths: readonly string[]): string[] {
    const dirPaths: string[] = [];
    let dirPath = path.dirname(filePath);
    while (rootPaths.some(rootPath => isPathInside(rootPath, dirPath))) {
        dirPaths.push(dirPath);
        const parentPath = path.dirname(dirPath);
        if (parentPath === dirPath) {
            break;
        }
        dirPath = parentPath;
    }
    return dirPaths;
}
