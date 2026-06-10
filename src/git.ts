import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export interface GitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

export function git(args: string[], cwd: string): Promise<GitResult> {
  return new Promise((resolve) => {
    execFile(
      'git',
      args,
      { cwd, maxBuffer: 32 * 1024 * 1024, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } },
      (error, stdout, stderr) => {
        resolve({ ok: !error, stdout: stdout ?? '', stderr: stderr ?? '' });
      },
    );
  });
}

export async function isGitRepo(cwd: string): Promise<boolean> {
  const r = await git(['rev-parse', '--is-inside-work-tree'], cwd);
  return r.ok && r.stdout.trim() === 'true';
}

export async function head(cwd: string): Promise<string | null> {
  const r = await git(['rev-parse', 'HEAD'], cwd);
  return r.ok ? r.stdout.trim() : null;
}

export async function branch(cwd: string): Promise<string | null> {
  const r = await git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
  if (!r.ok) return null;
  const name = r.stdout.trim();
  return name === 'HEAD' ? null : name;
}

export async function isDirty(cwd: string): Promise<boolean> {
  const r = await git(['status', '--porcelain'], cwd);
  return r.ok && r.stdout.trim().length > 0;
}

export async function refExists(ref: string, cwd: string): Promise<boolean> {
  const r = await git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], cwd);
  return r.ok;
}

/** Best-effort merge-base of HEAD with the default branch. */
export async function defaultBranchBase(cwd: string): Promise<string | null> {
  let target: string | null = null;
  const originHead = await git(['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'], cwd);
  if (originHead.ok) {
    target = originHead.stdout.trim().replace('refs/remotes/', '');
  } else {
    for (const candidate of ['origin/main', 'origin/master', 'main', 'master']) {
      if (await refExists(candidate, cwd)) {
        target = candidate;
        break;
      }
    }
  }
  if (!target) return null;
  const base = await git(['merge-base', 'HEAD', target], cwd);
  if (!base.ok) return null;
  const sha = base.stdout.trim();
  const headSha = await head(cwd);
  if (!sha || sha === headSha) return null;
  return sha;
}

export interface ChangedFile {
  /** A=added, M=modified, D=deleted, R=renamed, ?=untracked */
  status: string;
  path: string;
}

/** Files changed between `base` and the working tree, including untracked files. */
export async function changedFiles(base: string, cwd: string): Promise<ChangedFile[]> {
  const out: ChangedFile[] = [];
  const diff = await git(['diff', '--name-status', '--no-renames', '-z', base, '--'], cwd);
  if (diff.ok) {
    const parts = diff.stdout.split('\0').filter((p) => p.length > 0);
    for (let i = 0; i + 1 < parts.length; i += 2) {
      out.push({ status: parts[i]![0] ?? 'M', path: parts[i + 1]! });
    }
  }
  const untracked = await git(['ls-files', '--others', '--exclude-standard', '-z'], cwd);
  if (untracked.ok) {
    for (const p of untracked.stdout.split('\0').filter((p) => p.length > 0)) {
      out.push({ status: '?', path: p });
    }
  }
  return out;
}

export interface AddedLine {
  line: number;
  text: string;
}

const MAX_SCAN_BYTES = 1024 * 1024;

function looksBinary(buf: Buffer): boolean {
  const slice = buf.subarray(0, 8000);
  return slice.includes(0);
}

/**
 * Lines added between `base` and the working tree, per file.
 * Untracked files count as fully added.
 */
export async function addedLines(base: string, cwd: string): Promise<Map<string, AddedLine[]>> {
  const result = new Map<string, AddedLine[]>();
  const diff = await git(['diff', '--no-color', '--unified=0', '--no-renames', base, '--'], cwd);
  if (diff.ok) {
    let current: string | null = null;
    let lineNo = 0;
    for (const raw of diff.stdout.split('\n')) {
      if (raw.startsWith('+++ ')) {
        const p = raw.slice(4).trim();
        current = p === '/dev/null' ? null : p.replace(/^b\//, '');
        continue;
      }
      const hunk = raw.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (hunk) {
        lineNo = parseInt(hunk[1]!, 10);
        continue;
      }
      if (current && raw.startsWith('+') && !raw.startsWith('+++')) {
        const list = result.get(current) ?? [];
        list.push({ line: lineNo, text: raw.slice(1) });
        result.set(current, list);
        lineNo++;
      }
    }
  }
  const untracked = await git(['ls-files', '--others', '--exclude-standard', '-z'], cwd);
  if (untracked.ok) {
    for (const p of untracked.stdout.split('\0').filter((p) => p.length > 0)) {
      try {
        const full = path.join(cwd, p);
        const stat = fs.statSync(full);
        if (!stat.isFile() || stat.size > MAX_SCAN_BYTES) continue;
        const buf = fs.readFileSync(full);
        if (looksBinary(buf)) continue;
        const lines = buf.toString('utf8').split('\n');
        result.set(
          p,
          lines.map((text, i) => ({ line: i + 1, text })),
        );
      } catch {
        // unreadable file — skip
      }
    }
  }
  return result;
}

/** File content at a ref, or null if it didn't exist there. */
export async function fileAt(base: string, relPath: string, cwd: string): Promise<string | null> {
  const r = await git(['show', `${base}:${relPath.split(path.sep).join('/')}`], cwd);
  return r.ok ? r.stdout : null;
}

export async function diffStat(
  base: string,
  cwd: string,
): Promise<{ files_changed: number; insertions: number; deletions: number } | null> {
  const r = await git(['diff', '--shortstat', base, '--'], cwd);
  if (!r.ok) return null;
  const s = r.stdout.trim();
  if (s === '') return { files_changed: 0, insertions: 0, deletions: 0 };
  const files = s.match(/(\d+) files? changed/);
  const ins = s.match(/(\d+) insertions?/);
  const del = s.match(/(\d+) deletions?/);
  return {
    files_changed: files ? parseInt(files[1]!, 10) : 0,
    insertions: ins ? parseInt(ins[1]!, 10) : 0,
    deletions: del ? parseInt(del[1]!, 10) : 0,
  };
}
