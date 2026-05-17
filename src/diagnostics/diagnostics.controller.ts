import { Controller, Get, Post } from '@nestjs/common';
import { DiagnosticsService } from './diagnostics.service';

@Controller('diagnostics')
export class DiagnosticsController {
  constructor(private readonly diagnosticsService: DiagnosticsService) {}

  @Get('instance')
  getInstance() {
    return this.diagnosticsService.getInstance();
  }

  @Post('broken/local-counter')
  incrementBrokenLocalCounter() {
    return this.diagnosticsService.incrementBrokenLocalCounter();
  }

  @Post('shared-counter')
  incrementSharedCounter() {
    return this.diagnosticsService.incrementSharedCounter();
  }

  @Get('shared-counter')
  getSharedCounter() {
    return this.diagnosticsService.getSharedCounter();
  }
}
