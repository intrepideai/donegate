/** Tiny ANSI helper. Colors only when stderr/stdout is a TTY and NO_COLOR is unset. */

const enabled =
  process.env.NO_COLOR === undefined &&
  process.env.FORCE_COLOR !== '0' &&
  (process.stdout.isTTY === true || process.env.FORCE_COLOR !== undefined);

function wrap(open: number, close: number): (s: string) => string {
  return (s: string) => (enabled ? `[${open}m${s}[${close}m` : s);
}

export const bold = wrap(1, 22);
export const dim = wrap(2, 22);
export const red = wrap(31, 39);
export const green = wrap(32, 39);
export const yellow = wrap(33, 39);
export const cyan = wrap(36, 39);
export const magenta = wrap(35, 39);

export const sym = {
  pass: green('✓'),
  fail: red('✗'),
  warn: yellow('▲'),
  skip: dim('-'),
  arrow: dim('→'),
  shield: '🛡',
};

export function statusSymbol(status: string): string {
  switch (status) {
    case 'pass':
      return sym.pass;
    case 'fail':
    case 'error':
      return sym.fail;
    case 'timeout':
      return red('⏱');
    case 'warn':
      return sym.warn;
    default:
      return sym.skip;
  }
}

export function ms(durationMs: number): string {
  if (durationMs < 1000) return `${durationMs}ms`;
  const s = durationMs / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  return `${m}m${Math.round(s - m * 60)}s`;
}

/** Strip ANSI escapes (for embedding tool output into receipts / hook reasons). */
export function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\[[0-9;]*[A-Za-z]/g, '');
}

export function indent(text: string, prefix = '  '): string {
  return text
    .split('\n')
    .map((l) => (l.length > 0 ? prefix + l : l))
    .join('\n');
}
