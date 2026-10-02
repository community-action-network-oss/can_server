import { Global, Module } from '@nestjs/common';
import { CLOCK, ID_GENERATOR, SystemClock, UuidV7Generator } from './ports.js';

@Global()
@Module({
  providers: [
    { provide: CLOCK, useClass: SystemClock },
    { provide: ID_GENERATOR, useClass: UuidV7Generator },
  ],
  exports: [CLOCK, ID_GENERATOR],
})
export class PlatformModule {}
