import { noopPersona, type Persona } from '../personas/noop.ts';

const sets: Record<string, Persona[]> = { smoke: [noopPersona] };

export const loadScenarioSet = (name: string): Persona[] => {
  const s = sets[name];
  if (!s) throw new Error(`unknown scenario set: ${name}`);
  return s;
};
