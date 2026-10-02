import { describe, expect, it } from 'vitest';
import { PrivacyGatewayError } from './errors.js';
import { expand, redact } from './redact.js';

const out = (text: string, more: string[] = []) =>
  redact([text, ...more].map((t, i) => ({ fieldRef: `f${i}`, text: t })))
    .fields[0]!.text;

describe('privacy review gaps (fix-privacy)', () => {
  const gone: [string, string, string][] = [
    ['lowercase name', 'please ask priya sharma about it', 'priya'],
    ['lowercase name 2', 'my neighbour dave okoro keeps dumping', 'okoro'],
    ['percent-encoded email', 'mail john%2Esmith%40gmail%2Ecom today', 'gmail'],
    ['base64 email', 'ref am9obi5zbWl0aEBnbWFpbC5jb20gcGxlYXNl', 'am9obi'],
    ['NI number', 'NI is QQ123456C ok', '123456'],
    ['UK postcode alone', 'he lives near LS1 4AB now', '4AB'],
    ['dob', 'born 12/03/1984 in leeds', '1984'],
    ['DOB label', 'DOB: 3 March 1990', '1990'],
    ['handle at', 'see @jsmith on there', 'jsmith'],
    ['handle cue', 'the account is john_smith_77 online', 'smith_77'],
    ['what3words', 'bin at ///filled.count.soap by the gate', 'soap'],
    ['spelled digits', 'call seven seven zero nine soon', 'seven'],
    ['IBAN', 'pay GB82 WEST 1234 5698 7654 32 now', '7654'],
    ['card', 'card 4111 1111 1111 1111 expired', '1111'],
    ['space coords', 'at 51.5074 -0.1278 near it', '0.1278'],
    ['long number', 'case 123 456 789 012 filed', '789'],
  ];
  for (const [name, text, leak] of gone)
    it(`redacts ${name}`, () => {
      const r = out(text);
      expect(r).not.toContain(leak);
      expect(r).toMatch(/\[[A-Z]+_\d+\]/);
    });

  it('classes spaced coordinates as COORD', () => {
    const r = redact([{ fieldRef: 'a', text: 'at 51.5074 -0.1278 now' }]);
    expect(r.fields[0]!.spans.map((s) => s.kind)).toEqual(['COORD']);
  });

  it('masks health terms only when a person is present', () => {
    expect(out('Priya Sharma has diabetes and no bins')).not.toContain(
      'diabetes',
    );
    expect(out('the clinic closed for diabetes day')).toContain('diabetes');
    // person in another field
    expect(out('she has asthma', ['Priya Sharma wrote this'])).not.toContain(
      'asthma',
    );
  });

  it('keeps over-redaction low on ordinary civic text', () => {
    for (const t of [
      'The pothole on the main road has been there for two months.',
      'I spoke with the council and they said from next week it is fixed.',
      'Please contact the ward office about the broken street lights.',
      'Call the water company, they told us about the leak.',
    ])
      expect(redact([{ fieldRef: 'a', text: t }]).redactionCount, t).toBe(0);
  });

  it('never lets a token-shaped input string expand into someone else', () => {
    const r = redact([
      { fieldRef: 'a', text: 'write [PERSON_1] and Dan Okoro' },
    ]);
    const map = new Map(r.entries.map((e) => [e.token, e.original]));
    expect(r.fields[0]!.text).not.toContain('write [PERSON_1]');
    expect(expand(r.fields[0]!.text, map)).toBe(
      'write [PERSON_1] and Dan Okoro',
    );
  });

  it('seeds counters so a second call never reuses a token', () => {
    const r = redact(
      [{ fieldRef: 'a', text: 'Dan Okoro 020 7946 0958' }],
      new Map([
        ['PERSON', 1],
        ['PHONE', 1],
      ]),
    );
    expect(r.entries.map((e) => e.token).sort()).toEqual([
      '[PERSON_2]',
      '[PHONE_2]',
    ]);
  });

  it('fails closed type is PrivacyGatewayError', () => {
    expect(() => redact([{ fieldRef: 'a', text: 'x'.repeat(20_001) }])).toThrow(
      PrivacyGatewayError,
    );
  });
});
