import { GoogleGenAI, Type, FunctionDeclaration } from '@google/genai';
import { readFile, writeFile } from './fs';

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

export const tools: FunctionDeclaration[] = [
  {
    name: 'read_file',
    description: "Read the contents of a text-based file from the user's local workspace folder.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        filename: { type: Type.STRING, description: 'The name of the file to read (e.g., data.txt)' }
      },
      required: ['filename']
    }
  },
  {
    name: 'write_file',
    description: "Write text content to a file in the user's local workspace folder.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        filename: { type: Type.STRING, description: 'The name of the file to write' },
        content: { type: Type.STRING, description: 'The text content to write to the file' }
      },
      required: ['filename', 'content']
    }
  },
  {
    name: 'propose_python_script',
    description: 'Propose a Python script to automate a task, process data, or edit complex files (Excel, Word, PDF). The script will be shown to the user for review before execution. The script can use `await read_file(filename)` and `await write_file(filename, content)` to interact with the workspace. It can also use `await micropip.install("package_name")` to install packages like openpyxl, python-docx, etc.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        script: { type: Type.STRING, description: 'The Python code to execute.' },
        explanation: { type: Type.STRING, description: 'Explanation of what the script does.' }
      },
      required: ['script', 'explanation']
    }
  }
];

export async function processChatTurn(
  prompt: string,
  chatHistory: any[],
  dirHandle: FileSystemDirectoryHandle | null,
  onProposeScript: (script: string, explanation: string) => void,
  onLog: (msg: string) => void
) {
  const chat = ai.chats.create({
    model: 'gemini-3.1-pro-preview',
    config: {
      systemInstruction: `You are a powerful Local AI Assistant. You have access to a local folder on the user's computer.
You can read and write files directly using tools.
If the user asks you to process complex files (Excel, Word, PDF, PowerPoint, Images), you MUST write a Python script to do it, because you cannot read binary files directly through your text tools.
Propose Python scripts using the 'propose_python_script' tool. The user will review and run them.
In your Python scripts, you can install packages using micropip (e.g., \`await micropip.install('openpyxl')\`).
You can read/write files in Python using the provided async helpers: \`content = await read_file('file.txt')\` and \`await write_file('file.txt', content)\`. Note that these helpers currently handle text. For binary files, you might need to use standard Python file I/O if the environment supports it, but Pyodide's virtual FS is mapped to the local FS via JS. Actually, standard Python \`open('filename', 'rb')\` will NOT work directly on the local FS in this web sandbox. You must rely on the JS helpers for file access, so stick to text/csv/json processing for now, or write scripts that generate new files.`,
      tools: [{ functionDeclarations: tools }],
      temperature: 0.2,
    }
  });

  // Replay history (simplified for prototype)
  for (const msg of chatHistory) {
    if (msg.role === 'user') {
      await chat.sendMessage({ message: msg.content });
    }
  }

  onLog("AI is thinking...");
  let response = await chat.sendMessage({ message: prompt });
  
  // Handle function calls
  while (response.functionCalls && response.functionCalls.length > 0) {
    const call = response.functionCalls[0];
    onLog(`AI called tool: ${call.name}`);
    
    if (call.name === 'read_file') {
      if (!dirHandle) throw new Error("No directory selected.");
      try {
        const content = await readFile(dirHandle, call.args.filename as string);
        response = await chat.sendMessage({ message: `Tool read_file result: ${content.substring(0, 2000)}${content.length > 2000 ? '... (truncated)' : ''}` });
      } catch (e: any) {
        response = await chat.sendMessage({ message: `Tool read_file failed: ${e.message}` });
      }
    } 
    else if (call.name === 'write_file') {
      if (!dirHandle) throw new Error("No directory selected.");
      try {
        await writeFile(dirHandle, call.args.filename as string, call.args.content as string);
        response = await chat.sendMessage({ message: `Tool write_file succeeded.` });
      } catch (e: any) {
        response = await chat.sendMessage({ message: `Tool write_file failed: ${e.message}` });
      }
    }
    else if (call.name === 'propose_python_script') {
      onProposeScript(call.args.script as string, call.args.explanation as string);
      return { role: 'assistant', content: `I have proposed a Python script: ${call.args.explanation}. Please review and run it in the code panel.` };
    }
  }

  return { role: 'assistant', content: response.text };
}
