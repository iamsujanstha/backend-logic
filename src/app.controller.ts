import { Controller, Get, Param, ParseIntPipe } from '@nestjs/common';
import { AppService } from './app.service';

@Controller()
export class AppController {
  constructor(private readonly appService: AppService) { }

  @Get()
  getHello(): { message: string; instance: string } {
    return this.appService.getHello();
  }

  @Get('block')
  block() {
    const start = Date.now();
    while (Date.now() - start < 5000) { } // block 5s
    return 'Done';
  }

  // ❌ THE PROBLEM: CPU-intensive work blocks the event loop

  @Get('fibonacci-blocking/:number')
  fibonacciBlocking(@Param('number', ParseIntPipe) number: number) {
    console.log('⏰ Request received at:', new Date().toISOString());

    // This calculation blocks the ENTIRE event loop
    const result = this.calculateFibonacci(number); // Takes 5 seconds!

    console.log('✅ Response sent at:', new Date().toISOString());

    // During those 5 seconds, NO OTHER request can be processed
    // Your server is DEAD to the outside world!

    return { result, method: 'blocking' };
  }

  private calculateFibonacci(n: number): number {
    if (n <= 1) return n;
    return this.calculateFibonacci(n - 1) + this.calculateFibonacci(n - 2);
  }
}
