import type { HasPublishedContent } from '../app/ports.js';

// ponytail: always false until the problem schema unit binds the real check.
export class NoPublishedContent implements HasPublishedContent {
  async check(): Promise<boolean> {
    return false;
  }
}
