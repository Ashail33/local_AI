/**
 * Tests for file-path sanitisation — verifies that the AI cannot write files
 * outside the workspace via path manipulation.
 *
 * The sanitizePath function is the gateway for all file I/O; any bypass would
 * allow an LLM to write arbitrary files on the user's machine.
 */

import { describe, it, expect } from 'vitest';
import { sanitizePath } from './fs';

describe('sanitizePath — file write safety', () => {
  it('passes through a simple relative path unchanged', () => {
    expect(sanitizePath('report.txt')).toBe('report.txt');
  });

  it('passes through a nested relative path unchanged', () => {
    expect(sanitizePath('reports/2024/summary.md')).toBe('reports/2024/summary.md');
  });

  it('strips Windows drive letters', () => {
    expect(sanitizePath('C:/Users/john/report.txt')).toBe('Users/john/report.txt');
    expect(sanitizePath('D:\\data\\file.csv')).toBe('data/file.csv');
  });

  it('strips leading slashes (absolute Unix paths)', () => {
    expect(sanitizePath('/etc/passwd')).toBe('etc/passwd');
    expect(sanitizePath('///tmp/evil.sh')).toBe('tmp/evil.sh');
  });

  it('strips common OS folder prefixes (Desktop, Documents, Downloads)', () => {
    expect(sanitizePath('Users/alice/Desktop/secret.txt')).toBe('secret.txt');
    expect(sanitizePath('Users/bob/Documents/work.docx')).toBe('work.docx');
    expect(sanitizePath('home/user/Downloads/data.zip')).toBe('data.zip');
    expect(sanitizePath('Users/charlie/OneDrive/notes.txt')).toBe('notes.txt');
  });

  it('removes ".." traversal segments', () => {
    expect(sanitizePath('../../etc/passwd')).toBe('etc/passwd');
    expect(sanitizePath('reports/../../../secret')).toBe('reports/secret');
  });

  it('removes "." current-directory segments', () => {
    expect(sanitizePath('./report.txt')).toBe('report.txt');
    expect(sanitizePath('a/./b/./c.txt')).toBe('a/b/c.txt');
  });

  it('normalises backslashes to forward slashes', () => {
    expect(sanitizePath('reports\\2024\\q1\\data.csv')).toBe('reports/2024/q1/data.csv');
  });

  it('handles a complex combined attack path', () => {
    // Drive letter + OS folder + traversal + backslashes
    const evil = 'C:\\Users\\attacker\\Desktop\\..\\..\\..\\..\\etc\\passwd';
    const safe = sanitizePath(evil);
    // Should NOT contain ".." and should be a safe relative path
    expect(safe).not.toContain('..');
    expect(safe).not.toMatch(/^[A-Za-z]:/);
    expect(safe).not.toMatch(/^\//);
  });

  it('returns empty string for empty input', () => {
    expect(sanitizePath('')).toBe('');
  });
});
