
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
    '.vs',
    // Large binary / model weights extensions
    '.pth', '.pt', '.bin', '.ckpt', '.safetensors',
    '.h5', '.onnx', '.tflite', '.keras',
    '.tar', '.gz', '.zip', '.7z', '.rar',
    '.iso', '.dmg', '.exe', '.dll', '.so', '.dylib',
    '.mp4', '.mov', '.avi', '.mkv',
    '.mp3', '.wav', '.flac',
    '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.tiff', '.ico', '.svg', // Images can be large or numerous
    '.pdf', '.doc', '.docx', '.ppt', '.pptx', '.xls', '.xlsx',
    '.db', '.sqlite', '.sqlite3'
];

export const MAX_FILE_SIZE_BYTES = 5 * 1024 * 1024; // 5MB
