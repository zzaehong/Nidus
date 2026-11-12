// Text tasks: where a Worker does a task that needs no VM. It reads the Vault's committed files
// (the same state a VM workspace would start from) through git on the Mac, read only, and
// produces a text deliverable. No shell, no internet, no browser, nothing written to the Vault:
// what it makes reaches the user in the Task Board and later Tasks, not as file changes.
import { execFile } from 'node:child_process';
import type { ToolCallBlock, ToolSpec } from '../gateway/contract.js';
import type { ToolOutcome } from '../workspace/tools.js';
import type { WorkerToolSet } from '../workspace/worker.js';

/** Read-only access to the repository's committed files. */
export interface TextSource {
  list(path: string): Promise<string[]>;
  /** The file's text, or null if there is no such file; binary files are refused. */
  read(path: string): Promise<string | null>;
  search(pattern: string, path: string): Promise<string>;
}

const MAX_READ = 30_000;
const MAX_LISTED = 500;
const MAX_DELIVERABLE = 60_000;
const object = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false });
const str = (description: string) => ({ type: 'string', description });

export const TEXT_TOOLS: ToolSpec[] = [
  { name: 'list_files', description: 'List files in the user\'s repository (committed state), optionally under a directory.', inputSchema: object({ path: str('Directory, default the whole repository') }) },
  { name: 'read_file', description: `Read a text file of the repository. Returns up to ${MAX_READ} characters from offset.`, inputSchema: object({ path: str('Path relative to the repository root'), offset: { type: 'integer', description: 'Character offset, default 0' } }, ['path']) },
  { name: 'search_files', description: 'Search the repository\'s text files for a regular expression (case-insensitive). Returns matching lines with file and line number.', inputSchema: object({ pattern: str('Regular expression'), path: str('Directory or file to search, default everything') }, ['pattern']) },
  { name: 'write_deliverable', description: `Write the task's deliverable (the text the user and later tasks receive), in Markdown. Up to ${MAX_DELIVERABLE} characters in all; for a long one write the first part, then call again with append=true.`, inputSchema: object({ content: str('Deliverable text'), append: { type: 'boolean', description: 'Append instead of replacing' } }, ['content']) },
  { name: 'finish', description: 'End the task with a short summary for the user in their language. Give the deliverable here (or write it before with write_deliverable).', inputSchema: object({ summary: str('Summary: what the deliverable is, what is left open'), deliverable: str('The full deliverable; replaces what write_deliverable wrote') }, ['summary']) },
];

/** A repository path as git wants it: relative, inside the repository, no options. */
function repoPath(value: unknown, field = 'path'): string {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value !== 'string') throw new Error(`${field} must be a string`);
  const path = value.trim().replace(/^\/workspace\/?/, '').replace(/^\.\//, '').replace(/\/+$/, '');
  if (path.startsWith('/') || path.startsWith('-') || path.split('/').includes('..') || path.includes('\0')) throw new Error(`${field}: a path inside the repository`);
  return path === '.' ? '' : path;
}

const clip = (text: string, limit: number) => text.length > limit ? `${text.slice(0, limit)}\n… (${text.length - limit} more characters cut)` : text;

export class TextTools implements WorkerToolSet {
  /** The deliverable so far; undefined until the Worker writes one. */
  deliverable: string | undefined;

  constructor(private readonly source: TextSource) {}

  get specs(): ToolSpec[] { return TEXT_TOOLS; }

  async run(call: ToolCallBlock): Promise<ToolOutcome> {
    if (call.inputError) return { content: `Invalid call: ${call.inputError}`, isError: true };
    const input = (call.input ?? {}) as Record<string, any>;
    try {
      switch (call.name) {
        case 'list_files': {
          const files = await this.source.list(repoPath(input.path));
          if (!files.length) return { content: 'No files there.', isError: false };
          return { content: `${files.slice(0, MAX_LISTED).join('\n')}${files.length > MAX_LISTED ? `\n… ${files.length - MAX_LISTED} more; list a subdirectory` : ''}`, isError: false };
        }
        case 'read_file': {
          const path = repoPath(input.path);
          if (!path) throw new Error('path is required');
          const text = await this.source.read(path);
          if (text === null) return { content: `No file ${path} in the repository's committed state.`, isError: true };
          const offset = Math.max(0, Number.isInteger(input.offset) ? input.offset : 0);
          const part = text.slice(offset, offset + MAX_READ);
          const end = offset + part.length;
          return { content: `[${path}: characters ${offset}-${end} of ${text.length}${end < text.length ? `; more with offset=${end}` : ''}]\n${part}`, isError: false };
        }
        case 'search_files': {
          if (typeof input.pattern !== 'string' || !input.pattern.trim()) throw new Error('pattern is required');
          const found = await this.source.search(input.pattern, repoPath(input.path));
          return { content: found ? clip(found, 12_000) : 'No matches.', isError: false };
        }
        case 'write_deliverable': {
          if (typeof input.content !== 'string') throw new Error('content must be a string');
          const next = input.append ? `${this.deliverable ?? ''}${input.content}` : input.content;
          if (next.length > MAX_DELIVERABLE) throw new Error(`the deliverable may be at most ${MAX_DELIVERABLE} characters`);
          this.deliverable = next;
          return { content: `Deliverable is now ${next.length} characters.`, isError: false };
        }
        case 'finish': {
          if (typeof input.summary !== 'string' || !input.summary.trim()) throw new Error('summary is required');
          if (typeof input.deliverable === 'string' && input.deliverable.trim()) this.deliverable = input.deliverable.slice(0, MAX_DELIVERABLE);
          return { content: 'Task finished.', isError: false, finish: input.summary };
        }
        default:
          return { content: `Unknown tool ${call.name}. A text task has only: ${TEXT_TOOLS.map(t => t.name).join(', ')}.`, isError: true };
      }
    } catch (error: any) {
      return { content: `Error: ${String(error?.message ?? error)}`, isError: true };
    }
  }
}

/** The Vault's committed files through git, read only. */
export function gitSource(root: string): TextSource {
  const git = (args: string[], maxBuffer = 32 * 1024 * 1024) => new Promise<{ code: number; stdout: Buffer }>((resolve, reject) => {
    execFile('git', ['-c', 'core.quotepath=off', ...args], { cwd: root, encoding: 'buffer', maxBuffer }, (error, stdout) => {
      const code = (error as any)?.code;
      if (error && typeof code !== 'number') reject(error); else resolve({ code: code ?? 0, stdout });
    });
  });
  return {
    async list(path) {
      const { stdout } = await git(['ls-tree', '-r', '--name-only', 'HEAD', '--', ...(path ? [path] : [])]);
      return stdout.toString('utf8').split('\n').filter(Boolean);
    },
    async read(path) {
      const { code, stdout } = await git(['show', `HEAD:${path}`]);
      if (code !== 0) return null;
      if (stdout.subarray(0, 8000).includes(0)) throw new Error(`${path} is a binary file`);
      return stdout.toString('utf8');
    },
    async search(pattern, path) {
      const { code, stdout } = await git(['grep', '-n', '-I', '-i', '-E', '--max-count=20', '-e', pattern, 'HEAD', '--', ...(path ? [path] : [])], 4 * 1024 * 1024);
      if (code > 1) throw new Error('the search failed (check the pattern)');
      return stdout.toString('utf8').replace(/^HEAD:/gm, '');
    },
  };
}
