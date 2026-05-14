import { Injectable, NotFoundException, BadRequestException, Logger } from '@nestjs/common';
import type { ProcessDocumentDto } from './dto/process-document.dto';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { v4 as uuid } from 'uuid';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { ProcessDocumentJobSchema } from '@quizmorph/shared-types';
import { GoogleFormsService } from './google-forms.service';
import type { AppsScriptQuestion } from '@quizmorph/shared-types';

@Injectable()
export class DocumentsService {
  private readonly log = new Logger(DocumentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    @InjectQueue('documents') private readonly documentsQueue: Queue,
    private readonly googleForms: GoogleFormsService,
  ) {}

  private storageRoot() {
    const p = this.config.get<string>('FILE_STORAGE_PATH') ?? join(process.cwd(), 'uploads');
    return resolve(p);
  }

  async saveUpload(userId: string, buffer: Buffer, originalName: string) {
    const id = uuid();
    const root = this.storageRoot();
    await mkdir(root, { recursive: true });
    const storagePath = join(root, `${id}.pdf`);
    await writeFile(storagePath, buffer);

    const doc = await this.prisma.document.create({
      data: {
        id,
        userId,
        originalName,
        storagePath,
        status: 'uploaded',
        pageCount: 0,
      },
    });

    this.log.log(
      `[saveUpload] documentId=${doc.id} userId=${userId} storagePath=${storagePath} bytes=${buffer.length}`,
    );

    return doc;
  }

  async enqueueProcess(documentId: string, userId: string, dto: ProcessDocumentDto) {
    const doc = await this.prisma.document.findFirst({
      where: { id: documentId, userId },
    });
    if (!doc) throw new NotFoundException('Document not found');

    const custom = dto.customPages === true;
    let jobInput: { documentId: string; fullDocument?: boolean; pageStart?: number; pageEnd?: number };
    if (custom) {
      if (dto.pageStart == null || dto.pageEnd == null) {
        throw new BadRequestException(
          'When custom pages is enabled, enter both the first and last page number.',
        );
      }
      if (dto.pageEnd < dto.pageStart) {
        throw new BadRequestException('The last page must be greater than or equal to the first page.');
      }
      jobInput = { documentId, pageStart: dto.pageStart, pageEnd: dto.pageEnd };
    } else {
      jobInput = { documentId, fullDocument: true };
    }

    const job = ProcessDocumentJobSchema.parse(jobInput);

    this.log.log(
      `[enqueueProcess] documentId=${documentId} userId=${userId} job=${JSON.stringify(job)}`,
    );

    await this.prisma.document.update({
      where: { id: documentId },
      data: { status: 'processing' },
    });

    await this.documentsQueue.add('process', job, {
      attempts: 3,
      backoff: { type: 'exponential', delay: 5000 },
    });

    this.log.log(`[enqueueProcess] bull job added queue=documents name=process documentId=${documentId}`);

    return this.getStatus(documentId, userId);
  }

  async getStatus(documentId: string, userId: string) {
    const doc = await this.prisma.document.findFirst({
      where: { id: documentId, userId },
      select: { id: true, status: true, pageCount: true, originalName: true, createdAt: true },
    });
    if (!doc) throw new NotFoundException('Document not found');
    this.log.debug(
      `[getStatus] documentId=${documentId} userId=${userId} status=${doc.status} pageCount=${doc.pageCount} name=${JSON.stringify(doc.originalName)}`,
    );
    return doc;
  }

  async getQuestions(documentId: string, userId: string) {
    const doc = await this.prisma.document.findFirst({ where: { id: documentId, userId } });
    if (!doc) throw new NotFoundException('Document not found');
    const rows = await this.prisma.extractedQuestion.findMany({
      where: { documentId },
      orderBy: { order: 'asc' },
    });
    this.log.log(`[getQuestions] documentId=${documentId} userId=${userId} count=${rows.length}`);
    return rows.map((r) => ({
      id: r.id,
      order: r.order,
      questionText: r.questionText,
      questionType: r.questionType,
      options: r.options as string[],
      answerKey: r.answerKey,
      imageRefs: r.imageRefs as string[],
      metadata: r.metadata as Record<string, unknown>,
    }));
  }

  async generateForm(documentId: string, userId: string, timerEnabled = true) {
    const doc = await this.prisma.document.findFirst({ where: { id: documentId, userId } });
    if (!doc) throw new NotFoundException('Document not found');
    if (doc.status !== 'ready') {
      this.log.warn(
        `[generateForm] document not ready documentId=${documentId} status=${doc.status}`,
      );
      throw new BadRequestException('Document is not ready for form generation');
    }

    const rows = await this.prisma.extractedQuestion.findMany({
      where: { documentId },
      orderBy: { order: 'asc' },
    });
    if (!rows.length) {
      this.log.warn(`[generateForm] no questions documentId=${documentId}`);
      throw new BadRequestException('No extracted questions available');
    }

    this.log.log(
      `[generateForm] documentId=${documentId} userId=${userId} questionRows=${rows.length} timerEnabled=${timerEnabled}`,
    );

    const questions: AppsScriptQuestion[] = rows.map((r, idx) => {
      const options = (r.options as string[]) ?? [];
      const type = this.mapQuestionType(r.questionType);
      let correctOptionIndex: number | null = null;
      let correctText: string | null = null;
      const key = r.answerKey?.trim();

      if (type === 'MULTIPLE_CHOICE' && key) {
        const letter = key.charAt(0).toUpperCase();
        const idxLetter = letter.charCodeAt(0) - 65;
        if (idxLetter >= 0 && idxLetter < options.length) {
          correctOptionIndex = idxLetter;
        } else {
          const optIdx = options.findIndex((o) => o.trim().toLowerCase() === key.toLowerCase());
          correctOptionIndex = optIdx >= 0 ? optIdx : 0;
        }
      } else if (type === 'TRUE_FALSE' && key) {
        const lower = key.toLowerCase();
        correctOptionIndex = lower.startsWith('t') ? 0 : lower.startsWith('f') ? 1 : 0;
      } else if (type === 'SHORT_ANSWER' || type === 'PARAGRAPH') {
        correctText = key ?? null;
      }

      return {
        order: idx,
        title: r.questionText,
        type,
        options:
          type === 'TRUE_FALSE'
            ? ['True', 'False']
            : type === 'MULTIPLE_CHOICE'
              ? options.length
                ? options
                : ['A', 'B', 'C', 'D']
              : [],
        correctOptionIndex,
        correctText,
        imageDriveFileId: null,
      };
    });

    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user?.googleRefreshToken) {
      this.log.warn(`[generateForm] missing Google refresh token userId=${userId}`);
      throw new BadRequestException(
        'Your account needs Google authorization to create forms in your Drive. Sign out of QuizMorph, then sign in with Google again and approve access.',
      );
    }

    this.log.log(
      `[generateForm] calling Google Forms API title=${JSON.stringify(doc.originalName)} mappedQuestions=${questions.length}`,
    );
    const result = await this.googleForms.createQuizForm(
      user.googleRefreshToken,
      doc.originalName,
      questions,
    );

    const form = await this.prisma.generatedForm.create({
      data: {
        documentId,
        googleFormId: result.formId,
        formUrl: result.formUrl,
        editUrl: result.editUrl,
        timerEnabled,
      },
    });

    this.log.log(
      `[generateForm] stored GeneratedForm id=${form.id} googleFormId=${result.formId} documentId=${documentId}`,
    );

    return {
      id: form.id,
      formUrl: form.formUrl,
      editUrl: form.editUrl,
      timerEnabled: form.timerEnabled,
      quilgoHint:
        timerEnabled && form.formUrl
          ? 'Open Quilgo, attach this published form URL, and enable the timer for respondents.'
          : null,
    };
  }

  private mapQuestionType(t: string): AppsScriptQuestion['type'] {
    switch (t) {
      case 'MULTIPLE_CHOICE':
        return 'MULTIPLE_CHOICE';
      case 'TRUE_FALSE':
        return 'TRUE_FALSE';
      case 'SHORT_ANSWER':
        return 'SHORT_ANSWER';
      case 'PARAGRAPH':
        return 'PARAGRAPH';
      default:
        return 'SHORT_ANSWER';
    }
  }
}
