import * as path from 'path';
import { SNAPSHOT_BLACKLIST_PATTERNS, MAX_FILE_SIZE_BYTES } from './constants';
import * as fs from 'fs';

/**
 * Pure function to determine if a file should be tracked.
 * @param fsPath Absolute path of the file (used to check file size)
 * @param relativePath Path relative to the workspace root (used to check blacklist)
 * @returns boolean
 */
export function shouldTrackFile(fsPath: string, relativePath: string): boolean {
    // 1. Extension check
    const ext = path.extname(fsPath).toLowerCase();
    if (SNAPSHOT_BLACKLIST_PATTERNS.includes(ext)) return false;

    // 2. Directory/file name check
    const normalizedRelativePath = relativePath.split(path.sep).join('/');
    const segments = normalizedRelativePath.split('/');
    const isBlacklisted = segments.some(segment => SNAPSHOT_BLACKLIST_PATTERNS.includes(segment));
    if (isBlacklisted) return false;

    // 3. Size Check
    try {
        const stats = fs.statSync(fsPath);
        if (stats.size > MAX_FILE_SIZE_BYTES) {
            return false;
        }
    } catch (e) {
        return false;
    }

    return true;
}
