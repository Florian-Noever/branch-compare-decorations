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
