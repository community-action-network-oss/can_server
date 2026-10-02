import { completeness } from '../../src/policy/domain/completeness.js';

const schema = {
  required: ['a', 'b', 'k'],
  properties: {
    a: { type: 'string', minLength: 10, maxLength: 60 },
    b: { type: 'string', 'x-guidance': { min_chars: 5, max_chars: 30 } },
    k: { type: 'string', enum: ['x', 'y'] },
    u: { type: 'string', 'x-ui': { widget: 'url' } },
    l: { type: 'array', minItems: 1, maxItems: 2 },
  },
};
const good = {
  a: 'Streetlights on the market road fail often',
  b: 'Nobody reports it quickly',
  k: 'x',
};
const codes = (body: object) =>
  completeness(schema, { ...good, ...body }).map(
    (f) => `${f.field_ref}:${f.code}`,
  );

describe('completeness (DP-COMPLETENESS deterministic layer)', () => {
  const cases: [string, object, string[]][] = [
    ['clean body has no findings', {}, []],
    ['required missing', { a: undefined }, ['/a:required_missing']],
    ['required blank', { b: '   ' }, ['/b:required_missing']],
    ['required null', { k: null }, ['/k:required_missing']],
    ['enum invalid', { k: 'z' }, ['/k:enum_invalid']],
    ['enum valid', { k: 'y' }, []],
    ['too short from minLength', { a: 'Too short' }, ['/a:too_short']],
    ['min_chars from guidance', { b: 'abc' }, ['/b:too_short']],
    ['too long from maxLength', { a: 'q'.repeat(61) }, ['/a:too_long']],
    ['max_chars from guidance', { b: 'word '.repeat(7) }, ['/b:too_long']],
    ['length counts code points', { b: '\u{1F600}'.repeat(5) + ' go' }, []],
    ['url valid', { u: 'https://example.org/page' }, []],
    ['url without scheme', { u: 'example.org' }, ['/u:url_invalid']],
    ['url with other scheme', { u: 'javascript:alert(1)' }, ['/u:url_invalid']],
    ['url blank is just absent', { u: '' }, []],
    ['list ok', { l: [1] }, []],
    ['list too long', { l: [1, 2, 3] }, ['/l:list_too_long']],
    ['optional empty list is absent', { l: [] }, []],
    ['lorem', { a: 'Lorem ipsum dolor sit amet here' }, ['/a:filler_lorem']],
    ['punctuation only', { b: '??????!!!' }, ['/b:filler_punctuation']],
    ['stopwords only', { b: 'it is what it is' }, ['/b:filler_stopwords']],
    ['stopwords only 2', { b: 'to be or not to be' }, ['/b:filler_stopwords']],
    ['short real answer is not filler', { b: 'Pothole outside school' }, []],
    [
      'same string in every text field',
      {
        a: 'Same answer given everywhere',
        b: 'same   answer given everywhere',
      },
      ['/a:filler_same_everywhere', '/b:filler_same_everywhere'],
    ],
    [
      'repeated sentence across fields',
      {
        a: 'The light is broken. Nobody fixes it for months.',
        b: 'Nobody fixes it for months!',
      },
      ['/a:repeated_sentence', '/b:repeated_sentence'],
    ],
    [
      'repeated short phrase is ignored',
      {
        a: 'Lights fail. It is really bad here.',
        b: 'Lights fail. Nobody reports.',
      },
      [],
    ],
    [
      'repeat inside one field is not across fields',
      { a: 'It fails often. It fails often. Really it does.' },
      [],
    ],
  ];
  it.each(cases)('%s', (_n, body, want) => {
    expect(codes(body).sort()).toEqual([...want].sort());
  });

  it('keys with a slash are escaped in field_ref', () => {
    const s = { required: ['a/b'], properties: { 'a/b': { type: 'string' } } };
    expect(completeness(s, {})).toEqual([
      { field_ref: '/a~1b', code: 'required_missing' },
    ]);
  });
  it('a schema without properties yields nothing', () => {
    expect(completeness({}, { x: 1 })).toEqual([]);
  });
  it('ignores body keys the schema does not declare', () => {
    expect(completeness(schema, { ...good, zzz: 'lorem ipsum' })).toEqual([]);
  });
});
