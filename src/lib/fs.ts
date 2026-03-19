export async function pickDirectory(): Promise<FileSystemDirectoryHandle> {
  try {
    // @ts-ignore - File System Access API
    const dirHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
    return dirHandle;
  } catch (err) {
    console.error("Error picking directory:", err);
    throw err;
  }
}

/** Navigate (and optionally create) nested directories given a slash-separated path. */
async function getOrCreateDir(
  root: FileSystemDirectoryHandle,
  parts: string[],
): Promise<FileSystemDirectoryHandle> {
  let dir = root;
  for (const part of parts) {
    // @ts-ignore
    dir = await dir.getDirectoryHandle(part, { create: true });
  }
  return dir;
}

/** Split a file path into { dirParts, filename }. */
function splitPath(filePath: string): { dirParts: string[]; filename: string } {
  const parts = filePath.split('/').filter(Boolean);
  const filename = parts.pop() ?? filePath;
  return { dirParts: parts, filename };
}

/**
 * Create a subfolder (or nested path) inside the workspace.
 * e.g., createFolder(dirHandle, "reports/2024")
 */
export async function createFolder(
  dirHandle: FileSystemDirectoryHandle,
  folderPath: string,
): Promise<void> {
  const parts = folderPath.split('/').filter(Boolean);
  if (parts.length === 0) throw new Error('Folder path must not be empty.');
  await getOrCreateDir(dirHandle, parts);
}

/**
 * List files recursively under the workspace root.
 * Returns paths relative to the root, e.g. ["file.txt", "reports/summary.md"].
 */
export async function listFiles(dirHandle: FileSystemDirectoryHandle, prefix = ''): Promise<string[]> {
  const files: string[] = [];
  // @ts-ignore
  for await (const entry of dirHandle.values()) {
    const entryPath = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.kind === 'file') {
      files.push(entryPath);
    } else if (entry.kind === 'directory') {
      const subFiles = await listFiles(entry as FileSystemDirectoryHandle, entryPath);
      files.push(...subFiles);
    }
  }
  return files;
}

/**
 * Read a file from the workspace. Supports subfolder paths like "reports/data.csv".
 */
export async function readFile(dirHandle: FileSystemDirectoryHandle, filePath: string): Promise<string> {
  const { dirParts, filename } = splitPath(filePath);
  try {
    const dir = dirParts.length > 0 ? await getOrCreateDir(dirHandle, dirParts) : dirHandle;
    const fileHandle = await dir.getFileHandle(filename);
    const file = await fileHandle.getFile();
    return await file.text();
  } catch (err) {
    console.error(`Error reading file ${filePath}:`, err);
    throw new Error(`Could not read file ${filePath}. It might not exist or permission was denied.`);
  }
}

/**
 * Write a text file to the workspace. Supports subfolder paths like "reports/summary.txt".
 * Intermediate directories are created automatically.
 */
export async function writeFile(
  dirHandle: FileSystemDirectoryHandle,
  filePath: string,
  content: string,
): Promise<void> {
  const { dirParts, filename } = splitPath(filePath);
  try {
    const dir = dirParts.length > 0 ? await getOrCreateDir(dirHandle, dirParts) : dirHandle;
    const fileHandle = await dir.getFileHandle(filename, { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(content);
    await writable.close();
  } catch (err) {
    console.error(`Error writing file ${filePath}:`, err);
    throw new Error(`Could not write file ${filePath}.`);
  }
}

/**
 * Write binary data (Uint8Array) to a file in the workspace.
 * Supports subfolder paths. Used for .docx, .pdf, and other binary formats.
 */
export async function writeBinaryFile(
  dirHandle: FileSystemDirectoryHandle,
  filePath: string,
  data: Uint8Array,
): Promise<void> {
  const { dirParts, filename } = splitPath(filePath);
  try {
    const dir = dirParts.length > 0 ? await getOrCreateDir(dirHandle, dirParts) : dirHandle;
    const fileHandle = await dir.getFileHandle(filename, { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(data);
    await writable.close();
  } catch (err) {
    console.error(`Error writing binary file ${filePath}:`, err);
    throw new Error(`Could not write binary file ${filePath}.`);
  }
}
