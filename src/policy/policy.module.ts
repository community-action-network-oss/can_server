import { Inject, Logger, Module, type OnModuleInit } from '@nestjs/common';
import { config } from '../config.js';
import { ContentSchemaRegistry } from './app/content-schema-registry.js';
import { PACK_SOURCE, type PackSource } from './app/pack-source.js';
import { PolicyStore } from './app/policy-store.js';
import { StructuredContentService } from './app/structured-content.service.js';
import { StructuredContentValidator } from './app/structured-content-validator.js';
import { SchemaVersionRepo } from './infra/schema-version.repo.js';
import { DecisionCache } from './domain/cache.js';
import { ContentSchemaController } from './http/content-schema.controller.js';
import { FsPackSource } from './infra/fs-pack-source.js';
import { DB, type Db } from '../db/db.module.js';
import { parseYaml, type Yaml } from './domain/yaml.js';
import { LegalController } from './legal/legal.controller.js';
import {
  LegalRegistry,
  discoverCorpusDirs,
  parseLegalStack,
} from './legal/registry.js';

@Module({
  controllers: [ContentSchemaController, LegalController],
  providers: [
    {
      provide: PACK_SOURCE,
      useFactory: (): PackSource => new FsPackSource(config.policyPacksDir),
    },
    {
      provide: PolicyStore,
      useFactory: (src: PackSource) => new PolicyStore(src),
      inject: [PACK_SOURCE],
    },
    {
      provide: ContentSchemaRegistry,
      useFactory: (s: PolicyStore) => new ContentSchemaRegistry(s),
      inject: [PolicyStore],
    },
    SchemaVersionRepo,
    StructuredContentValidator,
    {
      provide: StructuredContentService,
      useFactory: (
        a: PolicyStore,
        b: ContentSchemaRegistry,
        c: SchemaVersionRepo,
        d: StructuredContentValidator,
      ) => new StructuredContentService(a, b, c, d),
      inject: [
        PolicyStore,
        ContentSchemaRegistry,
        SchemaVersionRepo,
        StructuredContentValidator,
      ],
    },
    {
      provide: LegalRegistry,
      inject: [DB, PolicyStore, PACK_SOURCE],
      useFactory: (db: Db, store: PolicyStore, src: PackSource) =>
        // The pinned legal_stack is read from the active jurisdiction pack, whose hash the store verified.
        new LegalRegistry(db, async (j) => {
          const pin = config.policyActive[j] ?? config.policyActive.default;
          if (!pin) return undefined;
          const p = await store.load(pin.name, pin.version, pin.hash);
          const meta = parseYaml(
            Buffer.from(
              (await src.read(p.name, p.semver)).get('pack.yaml')!,
            ).toString('utf8'),
          ) as Record<string, Yaml>;
          return meta.legal_stack;
        }),
    },
    {
      provide: DecisionCache,
      useFactory: () =>
        new DecisionCache({
          ttlMs: config.policyCacheTtlSeconds * 1000,
          maxEntries: config.policyCacheMaxEntries,
        }),
    },
  ],
  exports: [
    PACK_SOURCE,
    PolicyStore,
    ContentSchemaRegistry,
    DecisionCache,
    StructuredContentService,
    LegalRegistry,
  ],
})
export class PolicyModule implements OnModuleInit {
  constructor(
    private readonly store: PolicyStore,
    private readonly legal: LegalRegistry,
    @Inject(PACK_SOURCE) private readonly src: PackSource,
  ) {}

  /** A bad pack never stops boot: the previous (or no) pack stays active and callers fail closed. */
  async onModuleInit(): Promise<void> {
    const log = new Logger('Policy');
    for (const [j, ref] of Object.entries(config.policyActive))
      await this.store
        .activate(j, ref)
        .catch((e: Error) =>
          log.error(`refused active pack for ${j}: ${e.message}`),
        );
    if (config.policyShadow)
      await this.store
        .setShadow(config.policyShadow)
        .catch((e: Error) => log.error(`refused shadow pack: ${e.message}`));
    if (config.policyCanary)
      await this.store
        .setCanary(config.policyCanary, config.policyCanary.percent)
        .catch((e: Error) => log.error(`refused canary pack: ${e.message}`));
    await this.bootLegal(log);
  }

  /** Load every corpus under LEGAL_CORPORA_DIR; activate only those a pinned legal_stack names. A refusal never stops boot. */
  private async bootLegal(log: Logger): Promise<void> {
    const loaded = new Map<
      string,
      Awaited<ReturnType<LegalRegistry['register']>>
    >();
    for (const dir of await discoverCorpusDirs(config.legalCorporaDir))
      await this.legal
        .register(dir)
        .then((c) => loaded.set(`${c.id}#${c.hash}`, c))
        .catch((e: Error) =>
          log.error(`refused legal corpus ${dir}: ${e.message}`),
        );
    for (const ref of Object.values(config.policyActive))
      try {
        const p = await this.store.load(ref.name, ref.version, ref.hash);
        const meta = parseYaml(
          Buffer.from(
            (await this.src.read(p.name, p.semver)).get('pack.yaml')!,
          ).toString('utf8'),
        ) as Record<string, Yaml>;
        if (!meta.legal_stack) continue;
        for (const pin of parseLegalStack(p.name, meta.legal_stack)) {
          const c = loaded.get(`${pin.corpus}#${pin.pack_hash}`);
          if (c) await this.legal.activate(c);
        }
      } catch (e) {
        log.error(
          `legal stack not activated for ${ref.name}: ${(e as Error).message}`,
        );
      }
  }
}
