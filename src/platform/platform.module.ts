import { Global, Module } from '@nestjs/common';
import { config } from '../config.js';
import { SmtpNotification } from './mail/smtp.adapter.js';
import { CLOCK, ID_GENERATOR, SystemClock, UuidV7Generator } from './ports.js';
import { NOTIFICATION } from './ports/notification.js';

@Global()
@Module({
  providers: [
    { provide: CLOCK, useClass: SystemClock },
    { provide: ID_GENERATOR, useClass: UuidV7Generator },
    {
      provide: NOTIFICATION,
      useFactory: () => {
        if (config.mailTransport !== 'smtp')
          throw new Error('MAIL_TRANSPORT must be smtp');
        return new SmtpNotification(config.smtpUrl);
      },
    },
  ],
  exports: [CLOCK, ID_GENERATOR, NOTIFICATION],
})
export class PlatformModule {}
