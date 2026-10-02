/**
 * The four D-56 framings, verbatim. Constants only: nothing in this unit submits them.
 * They enter through the normal moderation pipeline (the seed bootstrap loader, plan 11).
 * Seeds 1 and 2 have a full sentence in docs/design/flows/seed-bootstrap.md; 3 and 4 only have
 * the D-56 name until the problem graph exists, so their text is that name.
 */
export const FRAMINGS = [
  {
    seed: 1,
    name: 'Amsterdam explosions and violence',
    text: 'Amsterdam residents face recurring explosions and violent incidents that may reduce actual and perceived public safety.',
  },
  {
    seed: 2,
    name: 'Amsterdam city-centre cleanliness',
    text: 'Amsterdam city centre remains dirty despite substantial government cleaning activity and expenditure.',
  },
  {
    seed: 3,
    name: 'continuous AI capability risk',
    text: 'continuous AI capability risk',
  },
  { seed: 4, name: 'climate change', text: 'climate change' },
] as const;
