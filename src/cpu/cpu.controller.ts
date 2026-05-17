import { Controller, Get, Param, ParseIntPipe } from '@nestjs/common';
import { CpuService } from './cpu.service';

@Controller('cpu')
export class CpuController {
  constructor(private readonly cpuService: CpuService) {}

  @Get('health')
  getHealth() {
    return this.cpuService.getHealth();
  }

  @Get('broken/fibonacci/:number')
  calculateFibonacciBlocking(@Param('number', ParseIntPipe) number: number) {
    return this.cpuService.calculateFibonacciBlocking(number);
  }

  @Get('fibonacci/:number')
  calculateFibonacciWithWorker(@Param('number', ParseIntPipe) number: number) {
    return this.cpuService.calculateFibonacciWithWorker(number);
  }

  @Get('jobs/fibonacci/:number')
  enqueueFibonacciJob(@Param('number', ParseIntPipe) number: number) {
    return this.cpuService.enqueueFibonacciJob(number);
  }

  @Get('jobs/:jobId')
  getCpuJob(@Param('jobId') jobId: string) {
    return this.cpuService.getCpuJob(jobId);
  }
}
