import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { v7 } from 'uuid';

export type Mode = 'deterministic' | 'live' | 'replay';

export interface Manifest {
  run_id: string;
  mode: Mode;
  seed: number;
  base_url: string;
  pack: string;
  schema_version: string;
  scenarios: string;
  harness_git_sha: string;
  started_at: string;
  ended_at: string | null;
}

export interface SimEvent {
  persona: string;
  step: string;
  method: string;
  path: string;
  status: number;
  body_sha256: string;
  ms: number;
}

/** Run id: UUIDv7, or `<prefix>-<counter>` when a test injects a clock. */
export const makeRunId = (next: () => string = v7): string => next();

export class RunStore {
  constructor(
    readonly dir: string,
    private manifest: Manifest,
    private now: () => Date = () => new Date(),
  ) {
    mkdirSync(join(dir, 'transcripts'), { recursive: true });
    this.writeManifest();
  }

  private writeManifest(): void {
    writeFileSync(join(this.dir, 'manifest.json'), JSON.stringify(this.manifest, null, 2) + '\n');
  }

  event(e: SimEvent): void {
    appendFileSync(join(this.dir, 'events.jsonl'), JSON.stringify(e) + '\n');
  }

  finish(): void {
    this.manifest = { ...this.manifest, ended_at: this.now().toISOString() };
    this.writeManifest();
  }
}
