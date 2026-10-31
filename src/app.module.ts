import { Module } from '@nestjs/common';
import { ServeStaticModule } from '@nestjs/serve-static';
import { join } from 'path';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { CacheModule } from './cache/cache.module';
import { DiagnosticsModule } from './diagnostics/diagnostics.module';
import { CpuModule } from './cpu/cpu.module';
import { OrderModule } from './order/order.module';
import { PaymentModule } from './payment/payment.module';
import { ProductModule } from './product/product.module';
import { QueueModule } from './queue/queue.module';
import { DatabaseModule } from './database/database.module';

@Module({
  imports: [
    ServeStaticModule.forRoot({
      rootPath: join(process.cwd(), 'public'),
      serveRoot: '/nest-static',
    }),
    DatabaseModule,
    CacheModule,
    QueueModule,
    PaymentModule,
    ProductModule,
    OrderModule,
    CpuModule,
    DiagnosticsModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule { }
