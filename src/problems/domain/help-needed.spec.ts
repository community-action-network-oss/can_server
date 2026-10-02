import { validateHelpNeeded } from './help-needed.js';

describe('validateHelpNeeded', () => {
  it('keeps valid tags sorted and deduped', () => {
    const r = validateHelpNeeded({
      skill_groups: ['transport', 'care_and_health', 'transport'],
      languages: ['pl', 'en-GB'],
      coarse_place: 'region_x',
      topics: ['housing'],
    });
    expect(r.issues).toEqual([]);
    expect(r.value.skill_groups).toEqual(['care_and_health', 'transport']);
  });
  it('drops unknown tags with an issue, never throws', () => {
    const r = validateHelpNeeded({
      skill_groups: ['surgeon'],
      coarse_place: '12 High Street',
    });
    expect(r.value.skill_groups).toEqual([]);
    expect(r.value.coarse_place).toBeNull();
    expect(r.issues).toHaveLength(2);
  });
  it('pack groups extend the vocabulary', () => {
    expect(
      validateHelpNeeded({ skill_groups: ['fishing'] }, ['fishing']).value
        .skill_groups,
    ).toEqual(['fishing']);
  });
  it('tolerates junk input', () => {
    expect(validateHelpNeeded(null).value.topics).toEqual([]);
  });
});
