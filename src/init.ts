import fs from 'node:fs';
import path from 'node:path';

export interface DetectedCheck {
  name: string;
  run: string;
  timeout?: number;
}

export interface Detection {
  checks: DetectedCheck[];
  stack: string[];
}

type PackageJson = {
  scripts?: Record<string, string>;
  devDependencies?: Record<string, string>;
  dependencies?: Record<string, string>;
};

function readIfExists(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function nodePackageManager(root: string): { run: (script: string) => string; exec: (cmd: string) => string; test: string } {
  if (fs.existsSync(path.join(root, 'bun.lockb')) || fs.existsSync(path.join(root, 'bun.lock'))) {
    return { run: (s) => `bun run ${s}`, exec: (c) => `bunx ${c}`, test: 'bun test' };
  }
  if (fs.existsSync(path.join(root, 'pnpm-lock.yaml'))) {
    return { run: (s) => `pnpm run ${s}`, exec: (c) => `pnpm exec ${c}`, test: 'pnpm test' };
  }
  if (fs.existsSync(path.join(root, 'yarn.lock'))) {
    return { run: (s) => `yarn ${s}`, exec: (c) => `yarn ${c}`, test: 'yarn test' };
  }
  return { run: (s) => `npm run ${s}`, exec: (c) => `npx ${c}`, test: 'npm test' };
}

const NPM_PLACEHOLDER_TEST = 'echo "Error: no test specified" && exit 1';

export function detectStack(root: string): Detection {
  const checks: DetectedCheck[] = [];
  const stack: string[] = [];
  const push = (check: DetectedCheck) => {
    if (!checks.some((c) => c.name === check.name)) checks.push(check);
  };

  // ── Node / TypeScript ──────────────────────────────────────────────────────
  const pkgRaw = readIfExists(path.join(root, 'package.json'));
  if (pkgRaw) {
    stack.push('node');
    let pkg: PackageJson = {};
    try {
      pkg = JSON.parse(pkgRaw) as PackageJson;
    } catch {
      // unparseable package.json — still node-ish, keep going
    }
    const pm = nodePackageManager(root);
    const scripts = pkg.scripts ?? {};

    if (scripts.typecheck) push({ name: 'typecheck', run: pm.run('typecheck') });
    else if (fs.existsSync(path.join(root, 'tsconfig.json'))) {
      push({ name: 'typecheck', run: pm.exec('tsc --noEmit') });
    }

    if (scripts.lint) push({ name: 'lint', run: pm.run('lint') });
    else if (
      fs.existsSync(path.join(root, 'biome.json')) ||
      fs.existsSync(path.join(root, 'biome.jsonc'))
    ) {
      push({ name: 'lint', run: pm.exec('biome check .') });
    }

    if (scripts.test && scripts.test.trim() !== NPM_PLACEHOLDER_TEST) {
      push({ name: 'tests', run: pm.test });
    }

    if (scripts.build) push({ name: 'build', run: pm.run('build'), timeout: 900 });
  }

  // ── Python ─────────────────────────────────────────────────────────────────
  const pyproject = readIfExists(path.join(root, 'pyproject.toml'));
  const hasPytestIni =
    fs.existsSync(path.join(root, 'pytest.ini')) ||
    (readIfExists(path.join(root, 'setup.cfg'))?.includes('[tool:pytest]') ?? false);
  if (pyproject || hasPytestIni) {
    stack.push('python');
    const prefix = fs.existsSync(path.join(root, 'uv.lock'))
      ? 'uv run '
      : fs.existsSync(path.join(root, 'poetry.lock'))
        ? 'poetry run '
        : '';
    const text = pyproject ?? '';

    if (text.includes('ruff') || fs.existsSync(path.join(root, 'ruff.toml'))) {
      push({ name: 'lint', run: `${prefix}ruff check .` });
    }
    if (text.includes('mypy')) {
      push({ name: 'typecheck', run: `${prefix}mypy .` });
    }
    if (text.includes('pytest') || hasPytestIni || fs.existsSync(path.join(root, 'tests'))) {
      push({ name: 'tests', run: `${prefix}pytest -q` });
    }
  }

  // ── Go ─────────────────────────────────────────────────────────────────────
  if (fs.existsSync(path.join(root, 'go.mod'))) {
    stack.push('go');
    push({ name: 'vet', run: 'go vet ./...' });
    push({ name: 'tests', run: 'go test ./...' });
  }

  // ── Rust ───────────────────────────────────────────────────────────────────
  if (fs.existsSync(path.join(root, 'Cargo.toml'))) {
    stack.push('rust');
    push({ name: 'fmt', run: 'cargo fmt --check' });
    push({ name: 'clippy', run: 'cargo clippy --quiet -- -D warnings', timeout: 900 });
    push({ name: 'tests', run: 'cargo test --quiet', timeout: 900 });
  }

  // ── Ruby ───────────────────────────────────────────────────────────────────
  const gemfile = readIfExists(path.join(root, 'Gemfile'));
  if (gemfile) {
    stack.push('ruby');
    if (gemfile.includes('rspec')) push({ name: 'tests', run: 'bundle exec rspec' });
    if (gemfile.includes('rubocop')) push({ name: 'lint', run: 'bundle exec rubocop' });
  }

  // ── Java / Kotlin (gradle, maven) ──────────────────────────────────────────
  if (fs.existsSync(path.join(root, 'gradlew')) || fs.existsSync(path.join(root, 'build.gradle')) || fs.existsSync(path.join(root, 'build.gradle.kts'))) {
    stack.push('gradle');
    const gradle = fs.existsSync(path.join(root, 'gradlew'))
      ? process.platform === 'win32'
        ? 'gradlew'
        : './gradlew'
      : 'gradle';
    push({ name: 'tests', run: `${gradle} test`, timeout: 1800 });
  } else if (fs.existsSync(path.join(root, 'pom.xml'))) {
    stack.push('maven');
    const mvn = fs.existsSync(path.join(root, 'mvnw'))
      ? process.platform === 'win32'
        ? 'mvnw'
        : './mvnw'
      : 'mvn';
    push({ name: 'tests', run: `${mvn} -q test`, timeout: 1800 });
  }

  // ── .NET ───────────────────────────────────────────────────────────────────
  let rootEntries: string[] = [];
  try {
    rootEntries = fs.readdirSync(root);
  } catch {
    // unreadable root — nothing more to detect
  }
  if (rootEntries.some((f) => f.endsWith('.sln') || f.endsWith('.csproj') || f.endsWith('.fsproj'))) {
    stack.push('dotnet');
    push({ name: 'tests', run: 'dotnet test', timeout: 1800 });
  }

  // ── Elixir ─────────────────────────────────────────────────────────────────
  if (fs.existsSync(path.join(root, 'mix.exs'))) {
    stack.push('elixir');
    push({ name: 'format', run: 'mix format --check-formatted' });
    push({ name: 'tests', run: 'mix test', timeout: 900 });
  }

  // ── PHP ────────────────────────────────────────────────────────────────────
  const composer = readIfExists(path.join(root, 'composer.json'));
  if (composer) {
    stack.push('php');
    if (composer.includes('phpunit') || fs.existsSync(path.join(root, 'phpunit.xml')) || fs.existsSync(path.join(root, 'phpunit.xml.dist'))) {
      push({ name: 'tests', run: 'vendor/bin/phpunit', timeout: 900 });
    }
    if (composer.includes('phpstan')) push({ name: 'analyse', run: 'vendor/bin/phpstan analyse' });
  }

  // ── Swift ──────────────────────────────────────────────────────────────────
  if (fs.existsSync(path.join(root, 'Package.swift'))) {
    stack.push('swift');
    push({ name: 'tests', run: 'swift test', timeout: 1800 });
  }

  // ── Deno ───────────────────────────────────────────────────────────────────
  if (fs.existsSync(path.join(root, 'deno.json')) || fs.existsSync(path.join(root, 'deno.jsonc'))) {
    stack.push('deno');
    push({ name: 'check', run: 'deno check .' });
    push({ name: 'lint', run: 'deno lint' });
    push({ name: 'tests', run: 'deno test' });
  }

  // ── Makefile / justfile fallback ───────────────────────────────────────────
  if (checks.length === 0) {
    const makefile = readIfExists(path.join(root, 'Makefile'));
    if (makefile) {
      stack.push('make');
      if (/^test:/m.test(makefile)) push({ name: 'tests', run: 'make test' });
      if (/^lint:/m.test(makefile)) push({ name: 'lint', run: 'make lint' });
    }
    const justfile = readIfExists(path.join(root, 'justfile')) ?? readIfExists(path.join(root, 'Justfile'));
    if (justfile && checks.length === 0) {
      stack.push('just');
      if (/^test\b/m.test(justfile)) push({ name: 'tests', run: 'just test' });
      if (/^lint\b/m.test(justfile)) push({ name: 'lint', run: 'just lint' });
    }
  }

  return { checks, stack };
}

function yamlEscape(value: string): string {
  // Quote when the command contains characters our YAML subset could misread.
  if (/^[A-Za-z0-9_./ @=:,&|()'"$\\{}\[\]<>;*+!?~^%#-]*$/.test(value) && !value.includes(': ') && !/\s#/.test(value) && !value.startsWith('[') && !value.startsWith('{') && !value.startsWith("'") && !value.startsWith('"')) {
    return value;
  }
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export function renderDonefile(detection: Detection): string {
  const checks =
    detection.checks.length > 0
      ? detection.checks
      : [
          {
            name: 'tests',
            run: 'echo "donegate: replace this with your real test command (DONE.md)" && exit 1',
          },
        ];

  const checkLines = checks
    .map((c) => {
      const lines = [`  - name: ${c.name}`, `    run: ${yamlEscape(c.run)}`];
      if (c.timeout) lines.push(`    timeout: ${c.timeout}`);
      return lines.join('\n');
    })
    .join('\n');

  const detectedNote =
    detection.checks.length > 0
      ? `Auto-detected from this repo (${detection.stack.join(', ')}). Edit freely — this file is yours, not your agent's.`
      : 'Nothing auto-detected. Replace the placeholder below with your real commands — a gate that passes vacuously is worse than no gate.';

  return `# Definition of Done

> Enforced by [donegate](https://github.com/intrepideai/donegate). When a coding
> agent — or a human — claims this repo's work is "done", the checks below decide
> whether that's actually true.

**Done here means:** every check passes from a real run, no tests were skipped or
deleted to get there, the linter wasn't silenced, and this file wasn't edited to
lower the bar. The guards verify all of that against a diff.

<!-- ${detectedNote} -->

\`\`\`yaml
version: 1

checks:
${checkLines}

# Tamper guards — what counts as cheating. true = fail the gate, "warn" = report
# only, false = off. These are the defaults; uncomment to change.
#
# guards:
#   no_done_edits: true        # this file was edited mid-session
#   no_deleted_tests: true     # test files deleted, or test counts dropped
#   no_new_skips: true         # .skip/.only/xfail/t.Skip added to tests
#   no_disabled_lint: true     # eslint-disable/noqa/@ts-ignore added
#   no_new_todos: warn         # TODO/FIXME introduced
#   no_debug_artifacts: warn   # console.log/debugger/pdb left behind
#
# gate:
#   max_bounces: 3             # times a stop hook re-prompts the agent before giving up
\`\`\`

## For agents

You are not done until \`donegate check\` exits 0. If the gate bounces you back,
fix the **underlying problem**. Skipping tests, deleting tests, adding lint
suppressions, or editing this file are all detected by diff-based guards and
will be reported on the receipt.
`;
}

export interface InitResult {
  path: string;
  detection: Detection;
  created: boolean;
}

export function initDonefile(root: string, force = false): InitResult {
  const target = path.join(root, 'DONE.md');
  if (fs.existsSync(target) && !force) {
    return { path: target, detection: { checks: [], stack: [] }, created: false };
  }
  const detection = detectStack(root);
  fs.writeFileSync(target, renderDonefile(detection));
  return { path: target, detection, created: true };
}
