import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ServeStaticModule } from '@nestjs/serve-static';
import { join } from 'path';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { CacheModule } from './cache/cache.module';
import { CpuModule } from './cpu/cpu.module';
import { OrderModule } from './order/order.module';
import { PaymentModule } from './payment/payment.module';
import { ProductModule } from './product/product.module';
import { QueueModule } from './queue/queue.module';

@Module({
  imports: [
    ServeStaticModule.forRoot({
      rootPath: join(process.cwd(), 'public'),
      serveRoot: '/nest-static',
    }),
    MongooseModule.forRoot(
      process.env.MONGO_URI || 'mongodb://localhost:27017/backend_mastery',
    ),
    CacheModule,
    QueueModule,
    PaymentModule,
    ProductModule,
    OrderModule,
    CpuModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule { }
