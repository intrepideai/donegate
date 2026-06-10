import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function tmpdir(prefix = 'donegate-test-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function write(root: string, rel: string, content: string): void {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

export function read(root: string, rel: string): string {
  return fs.readFileSync(path.join(root, rel), 'utf8');
}

export function rm(root: string, rel: string): void {
  fs.rmSync(path.join(root, rel), { force: true });
}

export function gitInit(root: string): void {
  const run = (...args: string[]) =>
    execFileSync('git', args, { cwd: root, stdio: 'pipe' });
  run('init', '-q', '-b', 'main');
  run('config', 'user.email', 'test@donegate.dev');
  run('config', 'user.name', 'donegate tests');
  run('config', 'commit.gpgsign', 'false');
}

export function gitCommitAll(root: string, message = 'commit'): void {
  execFileSync('git', ['add', '-A'], { cwd: root, stdio: 'pipe' });
  execFileSync('git', ['commit', '-q', '-m', message], { cwd: root, stdio: 'pipe' });
}

export function gitHead(root: string): string {
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, stdio: 'pipe' }).toString().trim();
}

export const BASIC_DONEFILE = `# Definition of Done

\`\`\`yaml
version: 1
checks:
  - name: ok
    run: node -e "process.exit(0)"
\`\`\`
`;

export function cleanup(root: string): void {
  fs.rmSync(root, { recursive: true, force: true });
}
