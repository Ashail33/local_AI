// @ts-nocheck
import { readFile, writeFile } from './fs';

export async function initPython(dirHandle: FileSystemDirectoryHandle, logCallback: (msg: string) => void) {
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

  // Setup Python helper functions
  await pyodide.runPythonAsync(`
import js
import asyncio
import sys

async def read_file(filename):
    """Reads a file from the mounted local workspace."""
    return await js.read_file_js(filename)

async def write_file(filename, content):
    """Writes a file to the mounted local workspace."""
    await js.write_file_js(filename, content)

# Redirect print to stdout properly if needed, though Pyodide handles this mostly.
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
