import { Logger, Module, type OnModuleInit } from '@nestjs/common';
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

@Module({
  controllers: [ContentSchemaController],
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
      provide: DecisionCache,
      useFactory: () =>
        new DecisionCache({
          ttlMs: config.policyCacheTtlSeconds * 1000,
          maxEntries: config.policyCacheMaxEntries,
        }),
    },
  ],
  exports: [
    PolicyStore,
    ContentSchemaRegistry,
    DecisionCache,
    StructuredContentService,
  ],
})
export class PolicyModule implements OnModuleInit {
  constructor(private readonly store: PolicyStore) {}

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
  }
}
