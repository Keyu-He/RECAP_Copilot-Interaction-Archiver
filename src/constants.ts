
export const SNAPSHOT_BLACKLIST_PATTERNS = [
    'node_modules',
    '.git',
    '.DS_Store',
    '.env',
    '__pycache__',
    'dist',
    'out',
    'build',
    'coverage',
    '.vscode',
    '.idea',
    '.vs'
];

// If a file matches the blacklist patterns (folder or filename), it is excluded FIRST.
// Then, if it passes blacklist, it must have an extension in the whitelist.

export const SNAPSHOT_WHITELIST_EXTENSIONS = [
    // Web / JS
    '.ts', '.tsx', '.js', '.jsx', '.json', '.html', '.css', '.scss', '.less',
    // Python
    '.py', '.ipynb',
    // C/C++
    '.c', '.cpp', '.h', '.hpp', '.cc',
    // Java/Kotlin
    '.java', '.kt',
    // Go
    '.go',
    // Rust
    '.rs',
    // Ruby
    '.rb',
    // PHP
    '.php',
    // Shell
    '.sh', '.bash', '.zsh',
    // Config/Data
    '.xml', '.yaml', '.yml', '.toml', '.ini', '.md', '.txt',
    // C#
    '.cs'
];
