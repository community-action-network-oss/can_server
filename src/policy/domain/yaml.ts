// Minimal YAML subset for policy packs: block maps, block lists, inline [a, b], scalars, # comments.
// ponytail: no anchors, multiline scalars or flow maps; swap for a real parser if packs need them.
type Line = { indent: number; text: string };
export type Yaml =
  string | number | boolean | null | Yaml[] | { [k: string]: Yaml };

function stripComment(s: string): string {
  let q = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === q) q = '';
    } else if (c === '"' || c === "'") q = c;
    else if (c === '#' && (i === 0 || /\s/.test(s[i - 1])))
      return s.slice(0, i);
  }
  return s;
}

function scalar(raw: string): Yaml {
  const s = raw.trim();
  if (s === '' || s === 'null' || s === '~') return null;
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (s.startsWith('"')) return JSON.parse(s) as string;
  if (s.startsWith("'")) return s.slice(1, -1).replace(/''/g, "'");
  if (s === '[]') return [];
  if (s === '{}') return {};
  if (s.startsWith('[') && s.endsWith(']'))
    return s
      .slice(1, -1)
      .split(',')
      .map((x) => scalar(x));
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  return s;
}

const KEY = /^([^\s"'[{#-][^:]*|"[^"]*"):(\s+(.*))?$/;

function block(lines: Line[], pos: { i: number }, indent: number): Yaml {
  const first = lines[pos.i].text;
  if (first === '-' || first.startsWith('- ')) {
    const out: Yaml[] = [];
    while (
      pos.i < lines.length &&
      lines[pos.i].indent === indent &&
      /^-( |$)/.test(lines[pos.i].text)
    ) {
      const rest = lines[pos.i].text.slice(1).trim();
      if (rest === '') {
        pos.i++;
        out.push(
          pos.i < lines.length && lines[pos.i].indent > indent
            ? block(lines, pos, lines[pos.i].indent)
            : null,
        );
      } else if (KEY.test(rest)) {
        lines[pos.i] = { indent: indent + 2, text: rest };
        out.push(block(lines, pos, indent + 2));
      } else {
        pos.i++;
        out.push(scalar(rest));
      }
    }
    return out;
  }
  const obj: { [k: string]: Yaml } = {};
  while (pos.i < lines.length && lines[pos.i].indent === indent) {
    const m = KEY.exec(lines[pos.i].text);
    if (!m) throw new Error(`yaml: cannot parse line "${lines[pos.i].text}"`);
    const key = m[1].startsWith('"')
      ? (JSON.parse(m[1]) as string)
      : m[1].trim();
    const val = (m[3] ?? '').trim();
    pos.i++;
    if (val !== '') obj[key] = scalar(val);
    else if (pos.i < lines.length && lines[pos.i].indent > indent)
      obj[key] = block(lines, pos, lines[pos.i].indent);
    else if (
      pos.i < lines.length &&
      lines[pos.i].indent === indent &&
      /^-( |$)/.test(lines[pos.i].text)
    )
      obj[key] = block(lines, pos, indent);
    else obj[key] = null;
  }
  return obj;
}

export function parseYaml(src: string): Yaml {
  const lines: Line[] = src
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((l) => stripComment(l).replace(/\s+$/, ''))
    .filter((l) => l.trim() !== '')
    .map((l) => ({
      indent: l.length - l.trimStart().length,
      text: l.trimStart(),
    }));
  if (lines.length === 0) return null;
  const pos = { i: 0 };
  const v = block(lines, pos, lines[0].indent);
  if (pos.i < lines.length)
    throw new Error(`yaml: unexpected line "${lines[pos.i].text}"`);
  return v;
}
