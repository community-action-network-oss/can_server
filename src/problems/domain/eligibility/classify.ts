import { normalise } from '../privacy/detect.js';

export type IneligibilityCode =
  | 'individual_case' | 'medical' | 'legal_advice' | 'therapy' | 'commercial' | 'emergency';

export type Classification =
  | { ok: true }
  | {
      ok: false;
      ineligibilityCode: IneligibilityCode;
      ruleId: 'SCOPE-1' | 'CRISIS-STATIC-1';
      hint: string;
    };

// Rule ids only; rule text lives in docs/spec/constitution/rules.md.
// First match wins, so emergency is checked before everything else.
// ponytail: phrase lists, not NLP; extend rows in test/fixtures/eligibility.json first.
const RULES: { code: IneligibilityCode; re: RegExp; hint: string }[] = [
  {
    code: 'emergency',
    re: /\b(?:help me|i need help|in danger|bleeding|being attacked|under attack|suicid\w*|kill myself|overdos\w*|fire (?:now|right now)|on fire|can'?t breathe|do(?:n'?t| not) want to (?:be here|live|go on|be alive)|end(?:ing)? it all|(?:hurt|harm)(?:ing)? myself|self[- ]?harm|no reason to live|want to die|took (?:his|her|their|my) own life)\b/,
    hint: 'If someone is in danger, contact local emergency services now. Your draft is kept; nothing is rejected.',
  },
  {
    code: 'commercial',
    re: /\b(?:for sale|on sale|discount|promo code|coupon|buy now|referral (?:link|code)|limited offer)\b/,
    hint: 'Adverts and sales cannot be public problems. Describe the shared condition instead.',
  },
  {
    code: 'medical',
    re: /\b(?:my (?:diagnosis|doctor|medication|prescription|symptoms|treatment)|i have (?:cancer|diabetes|asthma)|prescribe me)\b/,
    hint: 'Medical questions belong with a clinician. Describe the shared condition without personal health details.',
  },
  {
    code: 'legal_advice',
    re: /\b(?:legal advice|should i sue|can i sue|my lawyer|my divorce|my custody)\b/,
    hint: 'Legal advice is outside scope. A legal aid service can help with a single case.',
  },
  {
    code: 'therapy',
    re: /\b(?:my therapist|my trauma|i feel (?:depressed|anxious|hopeless)|need therapy|my counsell?or)\b/,
    hint: 'Personal support belongs with a counselling service. Describe the shared condition if there is one.',
  },
  {
    code: 'individual_case',
    re: /\b(?:my (?:landlord|employer|boss|neighbou?r|ex|husband|wife|manager)|i was (?:fired|evicted|dismissed))\b/,
    hint: 'This reads as one person\'s case. Rewrite it as a condition many people share, without naming anyone.',
  },
];

export function classifyStatement(text: string): Classification {
  const t = normalise(text).text.toLowerCase().replace(/[’]/g, "'").replace(/\s+/g, ' ');
  for (const r of RULES) {
    if (r.re.test(t)) {
      return {
        ok: false,
        ineligibilityCode: r.code,
        ruleId: r.code === 'emergency' ? 'CRISIS-STATIC-1' : 'SCOPE-1',
        hint: r.hint,
      };
    }
  }
  return { ok: true };
}
