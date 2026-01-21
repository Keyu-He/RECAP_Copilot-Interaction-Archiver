
export const SNAPSHOT_BLACKLIST_PATTERNS = [
    'node_modules', '__pycache__', // Dependencies
    '.git', '.DS_Store', '.env', '.vscode', '.vs', '.idea', // IDE & Git
    '.gitignore', '.gitattributes', // Git config files (shadow has its own)
    '.archiver_shadow', '.snapshots', // System folders
    'dist', 'out', 'build', 'coverage', // Build outputs

    // Large binary / model weights extensions
    '.pth', '.pt', '.bin', '.ckpt', '.safetensors',
    '.h5', '.onnx', '.tflite', '.keras',
    '.tar', '.gz', '.zip', '.7z', '.rar',
    '.iso', '.dmg', '.exe', '.dll', '.so', '.dylib',
    '.mp4', '.mov', '.avi', '.mkv',
    '.mp3', '.wav', '.flac',
    '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.tiff', '.ico', '.svg', // Images can be large or numerous
    '.pdf', '.doc', '.docx', '.ppt', '.pptx', '.xls', '.xlsx',
    '.db', '.sqlite', '.sqlite3', '.db-journal',
    '.log', '.lock', '.tmp', '.cache', '.pid',
    '.bundle', // to prevent recursion loop
    '.csv', '.tsv', '.json', '.jsonl', // Large data files
    '_data', 'data_' // Wildcard data folders
];

export const MAX_FILE_SIZE_BYTES = 5 * 1024 * 1024; // 5MB
