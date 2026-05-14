import './load-env.js';
import { Worker, type Job } from 'bullmq';
import { Redis } from 'ioredis';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@quizmorph/db';
import { loadQuestionExtractionPromptV1 } from '@quizmorph/ai-prompts';
import {
  ExtractedQuestionsPayloadSchema,
  ProcessDocumentJobSchema,
  type ExtractedQuestion,
  type ProcessDocumentJob,
} from '@quizmorph/shared-types';
import type { Prisma } from '@quizmorph/db';

const __dirname = dirname(fileURLToPath(import.meta.url));

function scriptPath() {
  return join(__dirname, '..', 'scripts', 'extract_pdf.py');
}

/** Prefer venv (PEP 668–safe); override with PYTHON_EXECUTABLE. */
function resolvePythonExecutable(): string {
  if (process.env.PYTHON_EXECUTABLE?.trim()) {
    return process.env.PYTHON_EXECUTABLE.trim();
  }
  const workerRoot = join(__dirname, '..');
  const unixPython = join(workerRoot, '.venv', 'bin', 'python3');
  const unixPythonAlt = join(workerRoot, '.venv', 'bin', 'python');
  const winPython = join(workerRoot, '.venv', 'Scripts', 'python.exe');
  if (existsSync(unixPython)) return unixPython;
  if (existsSync(unixPythonAlt)) return unixPythonAlt;
  if (existsSync(winPython)) return winPython;
  return 'python3';
}

function stripJsonFence(raw: string): string {
  let s = raw.trim();
  if (s.startsWith('```')) {
    s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  }
  return s.trim();
}

/** Vision models often return a top-level array; our schema expects { questions: [...] }. */
function normalizeExtractedQuestionsJson(parsed: unknown): unknown {
  if (Array.isArray(parsed)) {
    return { questions: parsed };
  }
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const o = parsed as Record<string, unknown>;
    if (Array.isArray(o.questions)) {
      return parsed;
    }
    if (Array.isArray(o.question)) {
      return { questions: o.question };
    }
  }
  return parsed;
}

async function runPythonMeta(pdfPath: string): Promise<{ totalPages: number }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(resolvePythonExecutable(), [scriptPath(), pdfPath, 'meta'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => (stdout += d.toString()));
    proc.stderr.on('data', (d) => (stderr += d.toString()));
    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(stderr || `python meta exited ${code}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout) as { totalPages: number });
      } catch (e) {
        reject(e);
      }
    });
  });
}

type ExtractedPage = { pageNumber: number; text: string; pageImage?: string | null };

async function runPythonExtract(
  pdfPath: string,
  pageStart: number,
  pageEnd: number,
  outDir: string,
): Promise<{ pages: ExtractedPage[]; totalPages: number }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(resolvePythonExecutable(), [scriptPath(), pdfPath, String(pageStart), String(pageEnd), outDir], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => (stdout += d.toString()));
    proc.stderr.on('data', (d) => (stderr += d.toString()));
    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(stderr || `python exited ${code}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout) as { pages: ExtractedPage[]; totalPages: number });
      } catch (e) {
        reject(e);
      }
    });
  });
}

async function callOllama(
  baseUrl: string,
  model: string,
  userContent: string,
  opts?: { imagesB64?: string[] },
): Promise<string> {
  const images = opts?.imagesB64?.filter(Boolean) ?? [];
  const useImages = images.length > 0;
  const res = await fetch(`${baseUrl.replace(/\/$/, '')}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      stream: false,
      ...(useImages ? {} : { format: 'json' }),
      messages: [
        {
          role: 'user',
          content: userContent,
          ...(useImages ? { images } : {}),
        },
      ],
    }),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Ollama error ${res.status}: ${t}`);
  }
  const data = (await res.json()) as { message?: { content?: string } };
  const content = data.message?.content;
  if (!content) throw new Error('Ollama returned empty content');
  return content;
}

async function extractQuestionsForPage(
  pageText: string,
  pageImageAbsPath: string | null,
  ollamaBase: string,
  model: string,
  promptTemplate: string,
): Promise<ExtractedQuestion[]> {
  const text = pageText.slice(0, 120_000);
  const userContent = promptTemplate.replace('{{PAGE_TEXT}}', text);

  let imagesB64: string[] | undefined;
  if (pageImageAbsPath && existsSync(pageImageAbsPath)) {
    const buf = await readFile(pageImageAbsPath);
    imagesB64 = [buf.toString('base64')];
  }

  const maxAttempts = 3;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const raw = await callOllama(ollamaBase, model, userContent, { imagesB64 });
      const parsedJson = normalizeExtractedQuestionsJson(JSON.parse(stripJsonFence(raw)));
      const parsed = ExtractedQuestionsPayloadSchema.safeParse(parsedJson);
      if (parsed.success) {
        return parsed.data.questions;
      }
      lastErr = parsed.error;
    } catch (e) {
      lastErr = e;
    }
  }
  throw new Error(`Failed to extract/validate questions: ${String(lastErr)}`);
}

async function handleJob(payload: ProcessDocumentJob, prisma: PrismaClient) {
  const doc = await prisma.document.findUnique({ where: { id: payload.documentId } });
  if (!doc) throw new Error('Document not found');

  let pageStart: number;
  let pageEnd: number;
  if (payload.fullDocument === true) {
    const meta = await runPythonMeta(doc.storagePath);
    pageStart = 1;
    pageEnd = meta.totalPages;
  } else {
    pageStart = payload.pageStart ?? Number(process.env.DEFAULT_PAGE_START ?? 2);
    pageEnd = payload.pageEnd ?? Number(process.env.DEFAULT_PAGE_END ?? 24);
  }

  const workDir = join(dirname(doc.storagePath), `${doc.id}-work`);
  await mkdir(workDir, { recursive: true });

  const extracted = await runPythonExtract(doc.storagePath, pageStart, pageEnd, workDir);

  await prisma.document.update({
    where: { id: doc.id },
    data: { pageCount: extracted.totalPages },
  });

  const promptTemplate = loadQuestionExtractionPromptV1();
  const ollamaBase = process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434';
  const model = process.env.OLLAMA_MODEL ?? 'qwen2.5vl:7b';
  const skipPageImage = process.env.OLLAMA_SKIP_PAGE_IMAGE === '1';

  await prisma.extractedQuestion.deleteMany({ where: { documentId: doc.id } });
  await prisma.documentPage.deleteMany({ where: { documentId: doc.id } });

  let globalOrder = 0;
  for (const page of extracted.pages) {
    const pagePng = page.pageImage ? join(workDir, page.pageImage) : null;
    const pagePngOk = !skipPageImage && pagePng && existsSync(pagePng) ? pagePng : null;

    let questions: ExtractedQuestion[] = [];
    try {
      questions = await extractQuestionsForPage(page.text, pagePngOk, ollamaBase, model, promptTemplate);
    } catch (err) {
      console.error(`extractQuestionsForPage failed page=${page.pageNumber}`, err);
      questions = [];
    }

    for (const q of questions) {
      const refs = [...(q.imageRefs ?? [])];
      if (page.pageImage && !refs.includes(page.pageImage)) refs.push(page.pageImage);

      await prisma.extractedQuestion.create({
        data: {
          documentId: doc.id,
          order: globalOrder++,
          questionText: q.questionText,
          questionType: q.questionType,
          options: q.options,
          answerKey: q.answerKey ?? null,
          imageRefs: refs,
          metadata: {
            ...(typeof q.metadata === 'object' && q.metadata !== null ? q.metadata : {}),
            sourcePage: page.pageNumber,
          } as Prisma.InputJsonValue,
        },
      });
    }
    await prisma.documentPage.create({
      data: {
        documentId: doc.id,
        pageNumber: page.pageNumber,
        ocrText: page.text,
        imagePath: pagePngOk,
      },
    });
  }

  await prisma.document.update({
    where: { id: doc.id },
    data: {
      status: 'ready',
      pageCount: extracted.totalPages,
    },
  });
}

function parsePositiveIntEnv(raw: string | undefined, fallback: number): number {
  if (raw == null || raw.trim() === '') return fallback;
  const n = Number.parseInt(raw.trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

async function main() {
  const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379';
  const connection = new Redis(redisUrl, { maxRetriesPerRequest: null });
  const prisma = new PrismaClient();

  const lockDuration = parsePositiveIntEnv(process.env.WORKER_LOCK_DURATION_MS, 45 * 60 * 1000);
  const maxStalledCount = Math.min(
    50,
    Math.max(1, parsePositiveIntEnv(process.env.WORKER_MAX_STALLED_COUNT, 5)),
  );
  const stalledInterval = parsePositiveIntEnv(process.env.WORKER_STALLED_INTERVAL_MS, 60 * 1000);

  new Worker(
    'documents',
    async (job: Job) => {
      if (job.name !== 'process') return;
      let documentId: string | undefined;
      try {
        const payload = ProcessDocumentJobSchema.parse(job.data);
        documentId = payload.documentId;
        await handleJob(payload, prisma);
      } catch (err) {
        if (documentId) {
          await prisma.document.updateMany({
            where: { id: documentId },
            data: { status: 'failed' },
          });
        }
        throw err;
      }
    },
    {
      connection,
      lockDuration,
      maxStalledCount,
      stalledInterval,
    },
  )
    .on('stalled', (jobId) => {
      console.warn(
        `[worker] job stalled (lock expired or worker too busy; BullMQ may requeue): id=${String(jobId)}`,
      );
    })
    .on('failed', (job, err) => {
      console.error('Job failed', job?.id, err);
    });

  console.log(
    `Worker listening on queue documents (lockDuration=${lockDuration}ms maxStalledCount=${maxStalledCount} stalledInterval=${stalledInterval}ms)`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
