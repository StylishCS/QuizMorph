import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { DocumentsController } from './documents.controller';
import { DocumentsService } from './documents.service';
import { GoogleFormsService } from './google-forms.service';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [AuthModule, BullModule.registerQueue({ name: 'documents' })],
  controllers: [DocumentsController],
  providers: [DocumentsService, GoogleFormsService],
})
export class DocumentsModule {}
