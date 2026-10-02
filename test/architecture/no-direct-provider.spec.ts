import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const GATEWAY = 'src/ai-gateway/';
/** Provider SDKs and endpoints. Only the gateway may touch them (PRIV-GATEWAY-1). */
const SDK =
  /^(?:@anthropic-ai\/|@openrouter\/|openai$|openai\/|@google\/generative-ai|@google\/genai|@mistralai\/|cohere-ai|ollama|@aws-sdk\/client-bedrock)/;
const HOST = /openrouter\.ai|api\.anthropic\.com|api\.openai\.com/;
const IMPORT =
  /(?:from\s+|import\s*\(\s*|require\s*\(\s*|import\s+)['"]([^'"]+)['"]/g;

/** Pure: violations in one file's source. `file` is repo-relative with forward slashes. */
export function violations(file: string, src: string): string[] {
  if (file.startsWith(GATEWAY)) return [];
  const out: string[] = [];
  for (const m of src.matchAll(IMPORT)) {
    const spec = m[1];
    if (SDK.test(spec) || /(?:^|\/)ai-gateway\/providers(?:\/|$)/.test(spec))
      out.push(`${file}: imports ${spec}`);
    if (/(?:^|\/)ai-gateway\/domain\/gateway-output(?:\.js)?$/.test(spec))
      out.push(`${file}: imports mintGatewayOutput`);
  }
  if (HOST.test(src)) out.push(`${file}: names a provider endpoint`);
  return out;
}

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
    d.isDirectory()
      ? d.name === 'node_modules'
        ? []
        : walk(join(dir, d.name))
      : d.name.endsWith('.ts')
        ? [join(dir, d.name)]
        : [],
  );
}

describe('no direct provider', () => {
  it('nothing outside src/ai-gateway imports a provider adapter or SDK, or names a provider endpoint', () => {
    const bad = ['src', 'test'].flatMap((root) =>
      walk(root).flatMap((f) => {
        // This guard names the patterns on purpose.
        if (f === 'test/architecture/no-direct-provider.spec.ts') return [];
        return violations(f, readFileSync(f, 'utf8'));
      }),
    );
    expect(bad).toEqual([]);
  });

  it('inside the gateway only the prompt builder mints a GatewayOutput', () => {
    const minters = walk('src/ai-gateway')
      .filter((f) =>
        /\bimport\b[^;]*mintGatewayOutput|export const mintGatewayOutput/.test(
          readFileSync(f, 'utf8'),
        ),
      )
      .sort();
    expect(minters).toEqual([
      'src/ai-gateway/app/prompt-builder.ts',
      'src/ai-gateway/domain/gateway-output.ts',
    ]);
  });

  it('the scanner catches each kind of violation', () => {
    const v = (f: string, s: string) => violations(f, s).length;
    expect(v('src/a.ts', `import x from '@anthropic-ai/sdk';`)).toBe(1);
    expect(v('src/a.ts', `const o = await import('openai');`)).toBe(1);
    expect(
      v('src/a.ts', `import p from './ai-gateway/providers/fake.js';`),
    ).toBe(1);
    expect(v('src/a.ts', `fetch('https://openrouter.ai/api/v1')`)).toBe(1);
    expect(
      v(
        'src/a.ts',
        `import { mintGatewayOutput } from '../ai-gateway/domain/gateway-output.js';`,
      ),
    ).toBe(1);
    expect(
      v('src/ai-gateway/providers/x.ts', `import x from '@anthropic-ai/sdk';`),
    ).toBe(0);
    expect(v('src/a.ts', `import { z } from 'zod';`)).toBe(0);
  });
});
