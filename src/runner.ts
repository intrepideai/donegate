import { spawn } from 'node:child_process';
import type { CheckDef, CheckResult } from './types.js';
import { stripAnsi } from './ui.js';

const TAIL_BYTES = 16 * 1024;

function shellFor(command: string): { cmd: string; args: string[] } {
  if (process.platform === 'win32') {
    return { cmd: process.env.ComSpec ?? 'cmd.exe', args: ['/d', '/s', '/c', command] };
  }
  return { cmd: '/bin/sh', args: ['-c', command] };
}

/** Run one check command, capturing combined output (tail-capped). */
export function runCheck(check: CheckDef, cwd: string): Promise<CheckResult> {
  return new Promise((resolve) => {
    const started = Date.now();
    const { cmd, args } = shellFor(check.run);

    let tail = Buffer.alloc(0);
    const append = (chunk: Buffer) => {
      tail = Buffer.concat([tail, chunk]);
      if (tail.length > TAIL_BYTES) tail = tail.subarray(tail.length - TAIL_BYTES);
    };

    let timedOut = false;
    let settled = false;

    const child = spawn(cmd, args, {
      cwd,
      env: { ...process.env, DONEGATE: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });

    child.stdout.on('data', append);
    child.stderr.on('data', append);

    const killTree = (signal: NodeJS.Signals) => {
      try {
        if (process.platform !== 'win32' && child.pid) {
          process.kill(-child.pid, signal);
        } else {
          child.kill(signal);
        }
      } catch {
        // already gone
      }
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killTree('SIGTERM');
      setTimeout(() => killTree('SIGKILL'), 5000).unref();
    }, check.timeout * 1000);

    const finish = (status: CheckResult['status'], exitCode: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        name: check.name,
        run: check.run,
        status,
        exitCode,
        durationMs: Date.now() - started,
        outputTail: stripAnsi(tail.toString('utf8')),
      });
    };

    child.on('error', (err) => {
      append(Buffer.from(`donegate: failed to spawn check: ${err.message}\n`));
      finish('error', null);
    });

    child.on('close', (code) => {
      if (timedOut) return finish('timeout', code);
      finish(code === 0 ? 'pass' : 'fail', code);
    });
  });
}

export async function runChecks(
  checks: CheckDef[],
  cwd: string,
  onResult?: (result: CheckResult, index: number) => void,
  only?: string[],
): Promise<CheckResult[]> {
  const selected = only && only.length > 0 ? checks.filter((c) => only.includes(c.name)) : checks;
  const results: CheckResult[] = [];
  for (const [i, check] of selected.entries()) {
    const result = await runCheck(check, cwd);
    results.push(result);
    onResult?.(result, i);
  }
  return results;
}
