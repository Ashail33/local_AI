// @ts-nocheck
import { readFile, writeFile, writeBinaryFile, createFolder } from './fs';

export async function initPython(dirHandle: FileSystemDirectoryHandle, logCallback: (msg: string) => void) {
  if (typeof window.loadPyodide !== 'function') {
    throw new Error('Pyodide is still loading or unavailable. Please wait a moment and try again. If the problem persists, check your internet connection and reload the app.');
  }

  if (!window.pyodide) {
    logCallback("System: Initializing Python environment (Pyodide)... This may take a moment.");
    window.pyodide = await window.loadPyodide({
      stdout: (text) => logCallback(`[Python stdout] ${text}`),
      stderr: (text) => logCallback(`[Python stderr] ${text}`),
    });
    logCallback("System: Loading micropip for package management...");
    await window.pyodide.loadPackage("micropip");
    logCallback("System: Python environment ready.");
  }

  const pyodide = window.pyodide;

  // Expose JS File System functions to Python
  pyodide.globals.set("read_file_js", async (filename: string) => {
    return await readFile(dirHandle, filename);
  });

  pyodide.globals.set("write_file_js", async (filename: string, content: string) => {
    await writeFile(dirHandle, filename, content);
  });

  /** Write binary data encoded as a base64 string to a workspace file. */
  pyodide.globals.set("write_binary_file_js", async (filename: string, b64content: string) => {
    const binary = atob(b64content);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    await writeBinaryFile(dirHandle, filename, bytes);
  });

  /** Create a subfolder (or nested path) inside the workspace. */
  pyodide.globals.set("create_folder_js", async (folderPath: string) => {
    await createFolder(dirHandle, folderPath);
  });

  // Setup Python helper functions
  await pyodide.runPythonAsync(`
import js
import asyncio
import sys

async def read_file(filename):
    """Reads a text file from the mounted local workspace."""
    return await js.read_file_js(filename)

async def write_file(filename, content):
    """Writes a text file to the mounted local workspace. Supports subfolder paths."""
    await js.write_file_js(filename, content)

async def write_binary_file(filename, content_bytes):
    """Writes binary data to the workspace. content_bytes should be a bytes object."""
    import base64
    b64 = base64.b64encode(bytes(content_bytes)).decode('ascii')
    await js.write_binary_file_js(filename, b64)

async def create_folder(folder_path):
    """Creates a subfolder (or nested path) inside the workspace."""
    await js.create_folder_js(folder_path)
  `);

  return pyodide;
}

export async function runPythonScript(script: string, pyodide: any, logCallback: (msg: string) => void) {
  logCallback("System: Executing script...");
  try {
    // We wrap the user script in an async function so they can use top-level await
    // for our async read_file/write_file helpers.
    const wrappedScript = `
import asyncio
import micropip

async def __main__():
${script.split('\n').map(line => '    ' + line).join('\n')}

await __main__()
`;
    await pyodide.runPythonAsync(wrappedScript);
    logCallback("System: Script execution completed successfully.");
  } catch (err) {
    logCallback(`System Error: ${err}`);
    throw err;
  }
}

export async function runPythonScript(script: string, pyodide: any, logCallback: (msg: string) => void) {
  logCallback("System: Executing script...");
  try {
    // We wrap the user script in an async function so they can use top-level await
    // for our async read_file/write_file helpers.
    const wrappedScript = `
import asyncio
import micropip

async def __main__():
${script.split('\n').map(line => '    ' + line).join('\n')}

await __main__()
`;
    await pyodide.runPythonAsync(wrappedScript);
    logCallback("System: Script execution completed successfully.");
  } catch (err) {
    logCallback(`System Error: ${err}`);
    throw err;
  }
}
