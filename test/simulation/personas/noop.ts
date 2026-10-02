import type { ApiClient } from '../api/client.ts';

export interface Persona {
  id: string;
  run(api: ApiClient): Promise<void>;
}

/** Scripted persona that only reads the public problem list. */
export const noopPersona: Persona = {
  id: 'noop',
  async run(api) {
    api.step = 'list-problems';
    await api.request('GET', '/v1/problems');
  },
};
