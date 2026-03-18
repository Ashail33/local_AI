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

export async function listFiles(dirHandle: FileSystemDirectoryHandle): Promise<string[]> {
  const files: string[] = [];
  // @ts-ignore
  for await (const entry of dirHandle.values()) {
    if (entry.kind === 'file') {
      files.push(entry.name);
    }
  }
  return files;
}

export async function readFile(dirHandle: FileSystemDirectoryHandle, filename: string): Promise<string> {
  try {
    const fileHandle = await dirHandle.getFileHandle(filename);
    const file = await fileHandle.getFile();
    return await file.text();
  } catch (err) {
    console.error(`Error reading file ${filename}:`, err);
    throw new Error(`Could not read file ${filename}. It might not exist or permission was denied.`);
  }
}

export async function writeFile(dirHandle: FileSystemDirectoryHandle, filename: string, content: string): Promise<void> {
  try {
    const fileHandle = await dirHandle.getFileHandle(filename, { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(content);
    await writable.close();
  } catch (err) {
    console.error(`Error writing file ${filename}:`, err);
    throw new Error(`Could not write file ${filename}.`);
  }
}
