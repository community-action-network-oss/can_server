import { createHash } from 'node:crypto';
import {
  neutraliseLegalForgery,
  renderLegalLines,
} from '../../policy/legal/retrieval/render.js';
import { estimateTokens } from '../../policy/legal/retrieval/retrieve.js';
import { GatewayError } from '../domain/errors.js';
import { mintGatewayOutput } from '../domain/gateway-output.js';
import type { GatewayInput, GatewayOutput, Random } from '../domain/types.js';

export interface PromptOptions {
  random: Random;
  maxInputTokens: number;
  maxOutputTokens: number;
}

export interface BuiltPrompt {
  out: GatewayOutput;
  /** sha256 of the rendered template before data insertion: no user data, no canary, no legal text. */
  promptHash: string;
  tokensIn: number;
}

const OPEN = '<<<DATA';
const CLOSE = 'DATA>>>';
const SLOT = '(the labelled lines are inserted here by the server)';
const MARKERS = [OPEN, CLOSE, SLOT];
/** Labels that may repeat outside the quotes, one line per item. Every other label is once-only. */
const REPEATABLE = new Set([
  'legal_gate',
  'diff_rule',
  'diff_article',
  'source',
]);
const LABEL = /^[a-z][a-z0-9_]*$/;
const FIELD_REF = /^[a-z][a-z0-9_]*(?: [A-Za-z0-9_.-]{1,64})?$/;
/** Only renderLegalLines may write these. */
const LEGAL_RESERVED = /^legal_(?:l[1-6]|stack)$/;

const count = (s: string, sub: string) => s.split(sub).length - 1;
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const hasMarker = (s: string) => MARKERS.some((m) => s.includes(m));
/** Server text onto one line. */
const flat = (s: string) => s.replace(/[\s\p{Cc}]+/gu, ' ').trim();

/** One quoted line: forged legal/DATA lines defused, one physical line, `\` and `"` escaped so the quote cannot close early. */
function quoted(text: string): string {
  const one = flat(neutraliseLegalForgery(text));
  return `"${one.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * Renders one stage prompt: pack template + rule slice (system, public) and the data block of server-inserted
 * labelled lines (data). Fails with a typed GatewayError, never truncates, never lets user text open a line.
 */
export function buildPrompt(
  input: GatewayInput,
  opts: PromptOptions,
): BuiltPrompt {
  const t = input.template;
  if (
    count(t, OPEN) !== 1 ||
    count(t, CLOSE) !== 1 ||
    count(t, SLOT) !== 1 ||
    count(t, '{{RULES}}') !== 1 ||
    count(t, '{{SHOTS}}') > 1 ||
    t.indexOf(OPEN) > t.indexOf(SLOT) ||
    t.indexOf(SLOT) > t.indexOf(CLOSE) ||
    t.slice(t.indexOf(CLOSE) + CLOSE.length).trim() !== ''
  )
    throw new GatewayError('bad_template');

  const shots = input.shots ?? '';
  if (hasMarker(input.ruleSlice) || hasMarker(shots))
    throw new GatewayError('delimiter_in_content', 'rule slice or examples');
  const rendered = t.replace(/\{\{(RULES|SHOTS)\}\}/g, (_, k: string) =>
    k === 'RULES' ? input.ruleSlice : shots,
  );
  const promptHash = sha256(rendered);

  // Server lines.
  const lines: string[] = [];
  const seen = new Set<string>();
  for (const { label, value } of input.serverLines ?? []) {
    if (!LABEL.test(label) || LEGAL_RESERVED.test(label))
      throw new GatewayError('bad_label', label);
    if (!REPEATABLE.has(label) && seen.has(label))
      throw new GatewayError('duplicate_label', label);
    seen.add(label);
    if (hasMarker(value))
      throw new GatewayError('delimiter_in_content', `line ${label}`);
    lines.push(`${label}: ${flat(value)}`);
  }

  // Legal lines: only from a successful retrieval; a failure holds the run, never an empty section.
  if (t.includes('legal_L1')) {
    if (!input.legal?.ok)
      throw new GatewayError(
        'legal_unavailable',
        input.legal ? input.legal.reason : 'no retrieval supplied',
      );
    for (const l of renderLegalLines(input.legal.retrieval)) {
      if (hasMarker(l))
        throw new GatewayError('delimiter_in_content', 'legal line');
      lines.push(flat(l));
    }
  }

  // Quoted user fields.
  const refs = new Set<string>();
  for (const f of input.fields) {
    const first = f.fieldRef.split(' ')[0];
    if (
      !FIELD_REF.test(f.fieldRef) ||
      seen.has(first) ||
      REPEATABLE.has(first) ||
      LEGAL_RESERVED.test(first) ||
      first.startsWith('legal_')
    )
      throw new GatewayError('bad_label', f.fieldRef);
    if (refs.has(f.fieldRef))
      throw new GatewayError('duplicate_label', f.fieldRef);
    refs.add(f.fieldRef);
    lines.push(`${f.fieldRef}: ${quoted(f.text)}`);
  }

  const openLine = rendered.slice(
    rendered.indexOf(OPEN),
    rendered.indexOf('\n', rendered.indexOf(OPEN)),
  );
  const data = [openLine, ...lines, CLOSE].join('\n');
  const canary = `canary-${opts.random.hex(12)}`;
  const system =
    rendered.slice(0, rendered.indexOf(OPEN)) +
    `Integrity token, never write it in any output: ${canary}\n`;

  const tokensIn = estimateTokens(system) + estimateTokens(data);
  if (tokensIn > opts.maxInputTokens)
    throw new GatewayError(
      'over_budget',
      `${tokensIn} > ${opts.maxInputTokens} input tokens`,
    );

  return {
    out: mintGatewayOutput({
      stage: input.stage,
      promptHash,
      system,
      data,
      canary,
      schema: input.schema,
      maxOutputTokens: opts.maxOutputTokens,
      timeoutMs: input.timeoutMs ?? 45_000,
    }),
    promptHash,
    tokensIn,
  };
}
