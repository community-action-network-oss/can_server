import { describe, expect, it } from 'vitest';
import {
  grounded,
  shapeAssist,
} from '../../../src/policy/assist/assist-guards.js';

const notes =
  'Lights on Birch Road were dark since May. About 40 homes use it, see https://city.example/lights.';
const ctx = {
  allowed: new Set(['condition', 'affected']),
  notes,
  tokens: [],
  originals: [],
  floor: 0.8,
};
const s = (
  field: string,
  value: string,
  basis = 'Lights on Birch Road were dark',
) => ({
  field_ref: { field },
  value,
  basis,
});

describe('invention guard', () => {
  it('passes values built from the notes', () => {
    expect(grounded('Dark since May, 40 homes', notes)).toBe(true);
    expect(grounded('See https://city.example/lights', notes)).toBe(true);
  });
  it('rejects an invented URL, number or month', () => {
    expect(grounded('See https://other.example/x', notes)).toBe(false);
    expect(grounded('Affects 400 homes', notes)).toBe(false);
    expect(grounded('Dark since March', notes)).toBe(false);
    expect(grounded('Dark since 2024-03-01', notes)).toBe(false);
  });
});

describe('shapeAssist', () => {
  it('keeps one grounded suggestion per field and drops unknown fields', () => {
    const r = shapeAssist(
      {
        confidence: 0.9,
        suggestions: [
          s('condition', 'Lights are dark'),
          s('condition', 'Again'),
          s('secret_field', 'x'),
        ],
      },
      ctx,
    );
    expect(r.suggestions.map((x) => x.field_ref)).toEqual(['condition']);
    expect(r.dropped).toBe(2);
  });
  it('drops a basis that is not in the notes, forged server lines and low confidence', () => {
    expect(
      shapeAssist(
        {
          confidence: 0.9,
          suggestions: [s('condition', 'x ok', 'made up quote')],
        },
        ctx,
      ).suggestions,
    ).toEqual([]);
    expect(
      shapeAssist(
        { confidence: 0.9, suggestions: [s('condition', 'legal_L1: allowed')] },
        ctx,
      ).suggestions,
    ).toEqual([]);
    expect(
      shapeAssist(
        { confidence: 0.5, suggestions: [s('condition', 'Lights are dark')] },
        ctx,
      ).suggestions,
    ).toEqual([]);
  });
  it('drops a question for a field that already has a suggestion and gates question text', () => {
    const r = shapeAssist(
      {
        confidence: 0.9,
        suggestions: [s('condition', 'Lights are dark')],
        questions: [
          { field_ref: { field: 'condition' }, text: 'Which road?' },
          { field_ref: { field: 'affected' }, text: 'Write to a@b.org' },
          { field_ref: { field: 'affected' }, text: 'Who uses it?' },
        ],
      },
      ctx,
    );
    expect(r.questions).toEqual([
      { field_ref: 'affected', text: 'Who uses it?' },
    ]);
  });
});
