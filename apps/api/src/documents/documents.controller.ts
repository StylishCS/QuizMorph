import {
  BadRequestException,
  Controller,
  Get,
  Logger,
  Param,
  ParseUUIDPipe,
  Post,
  Body,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import type { MultipartFile } from '@fastify/multipart';
import { DocumentsService } from './documents.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser } from '../common/current-user.decorator';
import type { JwtUser } from '../auth/jwt.strategy';
import { ProcessDocumentDto, GenerateFormDto } from './dto/process-document.dto';

@Controller('documents')
@UseGuards(JwtAuthGuard)
export class DocumentsController {
  private readonly log = new Logger(DocumentsController.name);

  constructor(private readonly documents: DocumentsService) {}

  @Post()
  async upload(@Req() req: FastifyRequest, @CurrentUser() user: JwtUser) {
    const mp = req as FastifyRequest & { file: () => Promise<MultipartFile | undefined> };
    const file = await mp.file();
    if (!file) {
      throw new BadRequestException('Missing file field');
    }
    const buf = await file.toBuffer();
    if (!buf.length) {
      throw new BadRequestException('Empty file');
    }
    const originalName = file.filename ?? 'upload.pdf';
    if (!originalName.toLowerCase().endsWith('.pdf')) {
      throw new BadRequestException('Only PDF uploads are supported');
    }
    this.log.log(
      `[upload] user=${user.userId} file=${JSON.stringify(originalName)} bytes=${buf.length}`,
    );
    const doc = await this.documents.saveUpload(user.userId, buf, originalName);
    this.log.log(`[upload] done documentId=${doc.id} status=${doc.status}`);
    return { id: doc.id, status: doc.status, originalName: doc.originalName };
  }

  @Post(':id/process')
  async process(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: ProcessDocumentDto,
    @CurrentUser() user: JwtUser,
  ) {
    this.log.log(
      `[process] user=${user.userId} documentId=${id} body=${JSON.stringify(body)}`,
    );
    const out = await this.documents.enqueueProcess(id, user.userId, body);
    this.log.log(`[process] queued documentId=${id} returnedStatus=${out.status}`);
    return out;
  }

  @Get(':id/status')
  async status(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: JwtUser) {
    return this.documents.getStatus(id, user.userId);
  }

  @Get(':id/questions')
  async questions(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: JwtUser) {
    this.log.log(`[questions] user=${user.userId} documentId=${id}`);
    return this.documents.getQuestions(id, user.userId);
  }

  @Post(':id/generate-form')
  async generateForm(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: GenerateFormDto,
    @CurrentUser() user: JwtUser,
  ) {
    const timer = body.timerEnabled ?? true;
    this.log.log(`[generate-form] user=${user.userId} documentId=${id} timerEnabled=${timer}`);
    const out = await this.documents.generateForm(id, user.userId, timer);
    this.log.log(`[generate-form] done documentId=${id} generatedFormRowId=${out.id} formUrl=${out.formUrl}`);
    return out;
  }
}
