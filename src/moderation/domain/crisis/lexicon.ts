export type CrisisLevel = 'none' | 'possible' | 'clear' | 'imminent';
export type CrisisCategory =
  'self_harm' | 'violence' | 'medical' | 'abuse' | 'fire' | 'distress';
export type LegalKind =
  | 'subpoena'
  | 'court_order'
  | 'law_enforcement'
  | 'named_person_request'
  | 'takedown';

/** Phrase: lowercase words; a trailing `*` on a word means any suffix. */
export interface CrisisEntry {
  category: CrisisCategory;
  level: Exclude<CrisisLevel, 'none'>;
  phrases: string[];
}
export interface LegalEntry {
  kind: LegalKind;
  phrases: string[];
}

// TEMPORARY fictional minimal test data (en + nl). Real terms come from the pack
// (passed as `extra` to detectCrisis). Extend fixtures first.
export const CRISIS_LEXICON: CrisisEntry[] = [
  {
    category: 'self_harm',
    level: 'imminent',
    phrases: [
      'going to kill myself',
      'about to kill myself',
      'kill myself tonight',
      'taking all the pills',
      'ga mezelf doden',
      'ga me van kant maken',
      'vanavond zelfmoord',
    ],
  },
  {
    category: 'violence',
    level: 'imminent',
    phrases: [
      'he has a gun',
      'she has a gun',
      'about to hit me',
      'is going to kill me',
      'hij heeft een wapen',
      'gaat me vermoorden',
    ],
  },
  {
    category: 'self_harm',
    level: 'clear',
    phrases: [
      'suicid*',
      'kill myself',
      'end my life',
      'want to die',
      'hurt myself',
      'cut myself',
      'overdos*',
      'zelfmoord',
      'zelfdoding',
      'wil dood',
      'mezelf pijn doen',
    ],
  },
  {
    category: 'violence',
    level: 'clear',
    phrases: [
      'being attacked',
      'under attack',
      'being beaten',
      'threatened to kill',
      'word aangevallen',
      'bedreigd met de dood',
    ],
  },
  {
    category: 'abuse',
    level: 'clear',
    phrases: [
      'abuses me',
      'hits me',
      'raped me',
      'mishandelt mij',
      'slaat mij',
      'verkracht',
    ],
  },
  {
    category: 'fire',
    level: 'clear',
    phrases: ['on fire', 'fire right now', 'brand nu', 'het brandt'],
  },
  {
    category: 'medical',
    level: 'clear',
    phrases: [
      'bleeding',
      "can't breathe",
      'cannot breathe',
      'bloedt',
      'kan niet ademen',
    ],
  },
  {
    category: 'distress',
    level: 'possible',
    phrases: [
      'help me',
      'i need help',
      'in danger',
      'hopeless',
      "can't go on",
      'no way out',
      'scared for my life',
      'help mij',
      'ik heb hulp nodig',
      'in gevaar',
      'hopeloos',
      'ik kan niet meer',
    ],
  },
];

export const LEGAL_LEXICON: LegalEntry[] = [
  { kind: 'subpoena', phrases: ['subpoena*', 'dagvaarding', 'summons'] },
  {
    kind: 'court_order',
    phrases: [
      'court order',
      'injunction',
      'restraining order',
      'rechterlijk bevel',
      'vonnis',
      'gerechtelijk bevel',
    ],
  },
  {
    kind: 'law_enforcement',
    phrases: [
      'law enforcement',
      'police request',
      'police officer',
      'search warrant',
      'warrant for',
      'detective',
      'politie verzoek',
      'politieverzoek',
      'huiszoekingsbevel',
      'officier van justitie',
    ],
  },
  {
    kind: 'takedown',
    phrases: [
      'takedown',
      'take down notice',
      'dmca',
      'cease and desist',
      'verwijderverzoek',
    ],
  },
  {
    kind: 'named_person_request',
    phrases: [
      'request for information about *',
      'request for data on *',
      'disclose the identity',
      'identify the user',
      'who is behind',
      'identity of the author',
      'wie zit erachter',
    ],
  },
];
