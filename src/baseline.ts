import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Baseline, BaselineFileEntry, DoneConfig } from './types.js';
import { head } from './git.js';

export const DONEGATE_DIR = '.donegate';

const SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  'out',
  'coverage',
  'vendor',
  'target',
  '.venv',
  'venv',
  '.tox',
  '__pycache__',
  '.next',
  '.nuxt',
  '.cache',
  '.donegate',
  '.idea',
  '.vscode',
]);

const MAX_FILES = 20000;
const MAX_DEPTH = 12;

/** Translate a glob (supporting `**`, `*`, `?`) into a RegExp over `/`-separated paths. */
export function globToRegex(glob: string): RegExp {
  let out = '';
  let i = 0;
  while (i < glob.length) {
    const ch = glob[i]!;
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        // `**/` matches zero or more path segments; trailing `**` matches anything.
        if (glob[i + 2] === '/') {
          out += '(?:[^/]+/)*';
          i += 3;
        } else {
          out += '.*';
          i += 2;
        }
      } else {
        out += '[^/]*';
        i += 1;
      }
    } else if (ch === '?') {
      out += '[^/]';
      i += 1;
    } else {
      out += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
      i += 1;
    }
  }
  return new RegExp(`^${out}$`);
}

export function makeTestFileMatcher(globs: string[]): (relPath: string) => boolean {
  const regexes = globs.map(globToRegex);
  return (relPath: string) => {
    const normalized = relPath.split(path.sep).join('/');
    return regexes.some((re) => re.test(normalized));
  };
}

interface Counts {
  tests: number;
  skips: number;
}

const COUNTERS: Array<{ ext: RegExp; tests: RegExp; skips: RegExp }> = [
  {
    ext: /\.(?:m?[jt]sx?|cjs)$/,
    tests: /\b(?:it|test)\s*\(|\b(?:it|test)\.each\b/g,
    skips: /\b(?:it|test|describe)\.(?:skip|todo|only|failing)\b|\bx(?:it|describe|test)\s*\(/g,
  },
  {
    ext: /\.py$/,
    tests: /^\s*(?:async\s+)?def test_/gm,
    skips: /@pytest\.mark\.(?:skip|skipif|xfail)\b|\bunittest\.skip\b|\bpytest\.skip\(/g,
  },
  {
    ext: /\.go$/,
    tests: /^func (?:Test|Fuzz)[A-Z_0-9]/gm,
    skips: /\bt\.Skip(?:f|Now)?\(/g,
  },
  {
    ext: /\.rs$/,
    tests: /#\[(?:\w+::)*test\]/g,
    skips: /#\[ignore\b/g,
  },
  {
    ext: /\.(?:java|kt|kts)$/,
    tests: /@(?:Test|ParameterizedTest)\b/g,
    skips: /@(?:Disabled|Ignore)\b/g,
  },
  {
    ext: /\.rb$/,
    tests: /^\s*(?:it|test|scenario)\s+['"]/gm,
    skips: /^\s*(?:xit|xdescribe|xspecify)\s+['"]|,\s*skip(?::|\s*=>)/gm,
  },
  {
    ext: /\.exs$/,
    tests: /^\s*test\s+["']/gm,
    skips: /@(?:module)?tag\s+:skip\b/g,
  },
  {
    ext: /\.cs$/,
    tests: /\[\s*(?:Fact|Theory|Test|TestMethod)\b/g,
    skips: /\[\s*(?:Fact|Theory)\s*\(\s*Skip\s*=|\[\s*Ignore\b/g,
  },
  {
    ext: /\.php$/,
    tests: /function\s+test[A-Z_0-9]|#\[Test\]|@test\b/g,
    skips: /markTestSkipped|markTestIncomplete/g,
  },
  {
    ext: /\.swift$/,
    tests: /func\s+test[A-Z_0-9]|@Test\b/g,
    skips: /XCTSkip(?:If|Unless)?\(/g,
  },
];

export function countTests(relPath: string, content: string): Counts {
  for (const counter of COUNTERS) {
    if (counter.ext.test(relPath)) {
      const tests = content.match(counter.tests)?.length ?? 0;
      const skips = content.match(counter.skips)?.length ?? 0;
      return { tests, skips };
    }
  }
  return { tests: 0, skips: 0 };
}

export function sha256(content: string | Buffer): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

function walk(root: string, matcher: (rel: string) => boolean): string[] {
  const found: string[] = [];
  let fileCount = 0;

  function visit(dir: string, depth: number) {
    if (depth > MAX_DEPTH || fileCount > MAX_FILES) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (fileCount > MAX_FILES) return;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith('.git')) {
          visit(full, depth + 1);
        }
      } else if (entry.isFile()) {
        fileCount++;
        const rel = path.relative(root, full);
        if (matcher(rel)) found.push(rel);
      }
    }
  }

  visit(root, 0);
  return found.sort();
}

export async function createBaseline(config: DoneConfig): Promise<Baseline> {
  const matcher = makeTestFileMatcher(config.guards.test_globs);
  const testFiles = walk(config.root, matcher);

  const entries: Record<string, BaselineFileEntry> = {};
  for (const rel of testFiles) {
    try {
      const buf = fs.readFileSync(path.join(config.root, rel));
      if (buf.length > 1024 * 1024) continue;
      const content = buf.toString('utf8');
      const counts = countTests(rel, content);
      entries[rel.split(path.sep).join('/')] = {
        sha: sha256(buf),
        tests: counts.tests,
        skips: counts.skips,
      };
    } catch {
      // unreadable — skip
    }
  }

  const donefileBuf = fs.readFileSync(config.sourcePath);
  const baseline: Baseline = {
    version: 1,
    created_at: new Date().toISOString(),
    head: await head(config.root),
    donefile_sha: sha256(donefileBuf),
    donefile_path: path.relative(config.root, config.sourcePath).split(path.sep).join('/'),
    test_files: entries,
  };
  return baseline;
}

export function baselinePath(root: string): string {
  return path.join(root, DONEGATE_DIR, 'baseline.json');
}

export async function writeBaseline(config: DoneConfig): Promise<Baseline> {
  const baseline = await createBaseline(config);
  const dir = path.join(config.root, DONEGATE_DIR);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(baselinePath(config.root), JSON.stringify(baseline, null, 2) + '\n');
  return baseline;
}

export function loadBaseline(root: string): Baseline | null {
  try {
    const raw = fs.readFileSync(baselinePath(root), 'utf8');
    const data = JSON.parse(raw) as Baseline;
    if (data.version !== 1 || typeof data.test_files !== 'object') return null;
    return data;
  } catch {
    return null;
  }
}
