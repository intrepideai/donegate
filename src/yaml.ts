/**
 * A small, dependency-free parser for the YAML subset used by DONE.md.
 *
 * Supported on purpose:
 *   - nested maps (2+ space indentation, no tabs)
 *   - sequences of scalars or maps (`- name: tests`)
 *   - plain / single-quoted / double-quoted scalars
 *   - booleans, numbers, null
 *   - `#` comments
 *   - literal block scalars (`|`, `|-`, `>`, `>-`)
 *   - inline sequences of scalars (`[a, b, c]`)
 *
 * Not supported (and not needed by the DONE.md spec): anchors, aliases, tags,
 * flow maps, multi-document streams. The parser fails loudly with line numbers
 * instead of guessing.
 */

export class YamlError extends Error {
  readonly line: number;
  constructor(message: string, line: number) {
    super(`${message} (line ${line})`);
    this.name = 'YamlError';
    this.line = line;
  }
}

interface Line {
  raw: string;
  indent: number;
  content: string;
  num: number;
  structural: boolean;
}

const KEY_RE = /^([A-Za-z0-9_.\/-]+):(.*)$/;

function prepare(source: string): Line[] {
  return source.split(/\r?\n/).map((raw, idx) => {
    const num = idx + 1;
    const leading = raw.match(/^[ \t]*/)![0];
    if (leading.includes('\t')) {
      throw new YamlError('tabs are not allowed in indentation — use spaces', num);
    }
    const indent = leading.length;
    const content = raw.slice(indent);
    const structural = content.length > 0 && !content.startsWith('#');
    return { raw, indent, content, num, structural };
  });
}

/** Cut a trailing comment: `#` at start or preceded by whitespace, outside quotes. */
function stripComment(text: string): string {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === '"' && !inSingle && text[i - 1] !== '\\') inDouble = !inDouble;
    else if (ch === '#' && !inSingle && !inDouble) {
      if (i === 0 || text[i - 1] === ' ' || text[i - 1] === '\t') {
        return text.slice(0, i).trimEnd();
      }
    }
  }
  return text.trimEnd();
}

function unquoteDouble(body: string, num: number): string {
  let out = '';
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === '\\') {
      const next = body[++i];
      if (next === undefined) throw new YamlError('dangling escape in string', num);
      const map: Record<string, string> = { n: '\n', t: '\t', r: '\r', '"': '"', '\\': '\\', '0': '\0' };
      out += map[next] ?? next;
    } else {
      out += ch;
    }
  }
  return out;
}

function parseScalar(text: string, num: number): unknown {
  const t = text.trim();
  if (t === '') return null;

  if (t.startsWith('[')) {
    if (!t.endsWith(']')) throw new YamlError('inline sequence must close with "]" on the same line', num);
    const body = t.slice(1, -1).trim();
    if (body === '') return [];
    if (body.includes('[') || body.includes('{')) {
      throw new YamlError('nested inline collections are not supported', num);
    }
    return splitTopLevel(body, num).map((part) => parseScalar(part, num));
  }
  if (t.startsWith('{')) {
    throw new YamlError('inline maps are not supported — use indented "key: value" lines', num);
  }

  if (t.startsWith('"')) {
    if (t.length < 2 || !t.endsWith('"')) throw new YamlError('unterminated double-quoted string', num);
    return unquoteDouble(t.slice(1, -1), num);
  }
  if (t.startsWith("'")) {
    if (t.length < 2 || !t.endsWith("'")) throw new YamlError('unterminated single-quoted string', num);
    return t.slice(1, -1).replace(/''/g, "'");
  }

  if (t === 'true') return true;
  if (t === 'false') return false;
  if (t === 'null' || t === '~') return null;
  if (/^-?\d+$/.test(t)) return parseInt(t, 10);
  if (/^-?\d+\.\d+$/.test(t)) return parseFloat(t);
  return t;
}

/** Split `a, "b, c", d` on commas outside quotes. */
function splitTopLevel(body: string, num: number): string[] {
  const parts: string[] = [];
  let cur = '';
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!;
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === '"' && !inSingle && body[i - 1] !== '\\') inDouble = !inDouble;
    if (ch === ',' && !inSingle && !inDouble) {
      parts.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  if (inSingle || inDouble) throw new YamlError('unterminated string in inline sequence', num);
  parts.push(cur);
  return parts.map((p) => p.trim()).filter((p) => p.length > 0);
}

type Parsed = [value: unknown, nextIndex: number];

class Parser {
  constructor(private lines: Line[]) {}

  private nextStructural(i: number): number {
    while (i < this.lines.length && !this.lines[i]!.structural) i++;
    return i;
  }

  parse(): unknown {
    const start = this.nextStructural(0);
    if (start >= this.lines.length) return null;
    const [value, next] = this.parseNode(start, this.lines[start]!.indent);
    const after = this.nextStructural(next);
    if (after < this.lines.length) {
      throw new YamlError(
        `unexpected content at indentation ${this.lines[after]!.indent}`,
        this.lines[after]!.num,
      );
    }
    return value;
  }

  private parseNode(i: number, indent: number): Parsed {
    const line = this.lines[i]!;
    if (line.content === '-' || line.content.startsWith('- ')) {
      return this.parseSeq(i, indent);
    }
    return this.parseMap(i, indent);
  }

  private parseSeq(start: number, indent: number): Parsed {
    const out: unknown[] = [];
    let i = start;
    while (true) {
      i = this.nextStructural(i);
      if (i >= this.lines.length) break;
      const line = this.lines[i]!;
      if (line.indent < indent) break;
      if (line.indent > indent) {
        throw new YamlError('bad indentation in sequence', line.num);
      }
      if (line.content !== '-' && !line.content.startsWith('- ')) break;

      const rest = line.content === '-' ? '' : line.content.slice(2);
      const restTrimmed = stripComment(rest).trim();
      const itemIndent = indent + (line.content.length - rest.length);

      if (restTrimmed === '') {
        // Item value is nested on the following lines.
        const j = this.nextStructural(i + 1);
        if (j >= this.lines.length || this.lines[j]!.indent <= indent) {
          out.push(null);
          i = i + 1;
        } else {
          const [value, next] = this.parseNode(j, this.lines[j]!.indent);
          out.push(value);
          i = next;
        }
        continue;
      }

      const kv = matchKeyValue(restTrimmed);
      if (kv) {
        // `- name: tests` — a map whose first pair is inline.
        const [value, next] = this.parseMap(i + 1, itemIndent, {
          key: kv.key,
          rawValue: kv.rawValue,
          num: line.num,
        });
        out.push(value);
        i = next;
      } else {
        out.push(parseScalar(restTrimmed, line.num));
        i = i + 1;
      }
    }
    return [out, i];
  }

  private parseMap(
    start: number,
    indent: number,
    inject?: { key: string; rawValue: string; num: number },
  ): Parsed {
    const out: Record<string, unknown> = {};
    let i = start;

    if (inject) {
      const [value, next] = this.parseEntryValue(inject.rawValue, start, indent, inject.num);
      out[inject.key] = value;
      i = next;
    }

    while (true) {
      i = this.nextStructural(i);
      if (i >= this.lines.length) break;
      const line = this.lines[i]!;
      if (line.indent < indent) break;
      if (line.indent > indent) {
        throw new YamlError('bad indentation — does not match the enclosing block', line.num);
      }
      if (line.content === '-' || line.content.startsWith('- ')) break;

      const kv = matchKeyValue(stripComment(line.content));
      if (!kv) {
        throw new YamlError(`expected "key: value", got "${line.content.slice(0, 40)}"`, line.num);
      }
      if (Object.prototype.hasOwnProperty.call(out, kv.key)) {
        throw new YamlError(`duplicate key "${kv.key}"`, line.num);
      }
      const [value, next] = this.parseEntryValue(kv.rawValue, i + 1, indent, line.num);
      out[kv.key] = value;
      i = next;
    }
    return [out, i];
  }

  /** Parse the value side of `key: <rawValue>`; nested blocks start at `nextLine`. */
  private parseEntryValue(rawValue: string, nextLine: number, indent: number, num: number): Parsed {
    const trimmed = rawValue.trim();

    if (trimmed === '|' || trimmed === '|-' || trimmed === '>' || trimmed === '>-') {
      return this.parseBlockScalar(nextLine, indent, trimmed, num);
    }

    if (trimmed === '') {
      const j = this.nextStructural(nextLine);
      if (j < this.lines.length && this.lines[j]!.indent > indent) {
        return this.parseNode(j, this.lines[j]!.indent);
      }
      return [null, nextLine];
    }

    return [parseScalar(trimmed, num), nextLine];
  }

  private parseBlockScalar(start: number, indent: number, marker: string, num: number): Parsed {
    const collected: Line[] = [];
    let i = start;
    while (i < this.lines.length) {
      const line = this.lines[i]!;
      if (line.raw.trim() === '') {
        collected.push(line);
        i++;
        continue;
      }
      if (line.indent <= indent) break;
      collected.push(line);
      i++;
    }
    // Drop trailing blank lines from collection bookkeeping.
    while (collected.length > 0 && collected[collected.length - 1]!.raw.trim() === '') {
      collected.pop();
    }
    if (collected.length === 0) {
      throw new YamlError('block scalar has no content', num);
    }
    const nonBlank = collected.filter((l) => l.raw.trim() !== '');
    const dedent = Math.min(...nonBlank.map((l) => l.indent));
    const lines = collected.map((l) => (l.raw.trim() === '' ? '' : l.raw.slice(dedent)));

    let text: string;
    if (marker.startsWith('>')) {
      text = lines.join(' ').replace(/\s+/g, ' ').trim();
    } else {
      text = lines.join('\n');
    }
    if (!marker.endsWith('-') && marker.startsWith('|')) text += '\n';
    return [text, i];
  }
}

function matchKeyValue(text: string): { key: string; rawValue: string } | null {
  const m = text.match(KEY_RE);
  if (!m) return null;
  const rawValue = m[2]!;
  // Require a space after the colon (or nothing) so URLs like `https://x` stay scalars.
  if (rawValue !== '' && !rawValue.startsWith(' ') && !rawValue.startsWith('\t')) return null;
  return { key: m[1]!, rawValue };
}

export function parseYaml(source: string): unknown {
  return new Parser(prepare(source)).parse();
}
