import { Injectable } from '@nestjs/common';

@Injectable()
export class AppService {
  getHello(): { message: string; instance: string } {
    return {
      message: 'Hello',
      instance: process.env.HOSTNAME || 'local-dev',
    };
  }
}
