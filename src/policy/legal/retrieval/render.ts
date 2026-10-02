import type { LegalRetrieval } from './retrieve.js';

const HOMOGLYPHS: Record<string, string> = {
  // Cyrillic and Greek letters that pass for latin ones in "legal_stack" / "topic_ban".
  а: 'a',
  е: 'e',
  о: 'o',
  р: 'p',
  с: 'c',
  у: 'y',
  х: 'x',
  і: 'i',
  ѕ: 's',
  ӏ: 'l',
  ј: 'j',
  ο: 'o',
  α: 'a',
  ε: 'e',
  ι: 'i',
  ρ: 'p',
  ѵ: 'v',
  ԁ: 'd',
  ɡ: 'g',
  ǀ: 'l',
  ⅼ: 'l',
};

/** Lowercase, NFKC, no whitespace, control, format or combining characters, homoglyphs folded. */
const canon = (line: string) =>
  line
    .normalize('NFKC')
    .replace(/[\s\p{Cc}\p{Cf}\p{M}]/gu, '')
    .toLowerCase()
    .replace(/[^\u0000-\u007f]/g, (c) => HOMOGLYPHS[c] ?? c);

const FORGED = /^legal(?:[_\-.:]|stack|l[1-6])|^<<<data|^data>>>/;

/**
 * Neutralise user field text before it enters the data block: any line that, after stripping leading whitespace,
 * invisible and look-alike characters, starts like a server legal line (`legal_L1`..`legal_L6`, `legal_stack`)
 * or like a DATA marker gets a "[user text] " prefix, so a forged line never looks server-inserted. Line breaks
 * of every kind (CR, LF, NEL, LS, PS, VT, FF) split lines. Marker triples are also defused anywhere in a line.
 */
export function neutraliseLegalForgery(text: string): string {
  return text
    .split(/\r\n|[\r\n\v\f\u0085\u2028\u2029]/)
    .map((l) => {
      const safe = l.replace(/<<<|>>>/g, (m) => (m === '<<<' ? '<<' : '>>'));
      return FORGED.test(canon(l)) ? `[user text] ${safe}` : safe;
    })
    .join('\n');
}

/** Article text on one line so it can never open a new line of the block. */
const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();

/**
 * The server-inserted legal lines of the data block, exactly as the DP prompts read them:
 * `legal_Ln: <id@semver+hash12> | <article id> | topic_ban yes|no | <text>` (articles joined by " || "),
 * `legal_Ln: <version> | no applicable article found`, `legal_Ln: not_applicable`, and
 * `legal_stack: not_applicable` only when every layer is not applicable.
 */
export function renderLegalLines(r: LegalRetrieval): string[] {
  if (r.layers.length && r.layers.every((l) => l.notApplicable))
    return ['legal_stack: not_applicable'];
  return r.layers.map((l) => {
    if (l.notApplicable) return `legal_${l.layer}: not_applicable`;
    const body = l.articles.length
      ? l.articles
          .map(
            (a) =>
              `${a.article_id} | topic_ban ${a.topic_ban ? 'yes' : 'no'} | ${oneLine(a.text)}`,
          )
          .join(' || ')
      : 'no applicable article found';
    return `legal_${l.layer}: ${l.corpus_version} | ${body}`;
  });
}
