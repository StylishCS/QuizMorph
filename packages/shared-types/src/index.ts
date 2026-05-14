import { z } from 'zod';

export const QuestionTypeSchema = z.enum([
  'MULTIPLE_CHOICE',
  'SHORT_ANSWER',
  'PARAGRAPH',
  'TRUE_FALSE',
  'UNKNOWN',
]);

export const ExtractedQuestionSchema = z.object({
  order: z.number().int().nonnegative(),
  questionText: z.string().min(1),
  questionType: QuestionTypeSchema,
  options: z.array(z.string()).default([]),
  answerKey: z.string().nullable().optional(),
  imageRefs: z.array(z.string()).default([]),
  metadata: z.record(z.unknown()).optional(),
});

export const ExtractedQuestionsPayloadSchema = z.object({
  questions: z.array(ExtractedQuestionSchema),
});

export const ProcessDocumentJobSchema = z
  .object({
    documentId: z.string().uuid(),
    fullDocument: z.boolean().optional(),
    pageStart: z.number().int().positive().optional(),
    pageEnd: z.number().int().positive().optional(),
  })
  .superRefine((val, ctx) => {
    if (val.fullDocument === true) return;
    if (val.pageStart === undefined || val.pageEnd === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Either fullDocument: true or both pageStart and pageEnd are required',
      });
      return;
    }
    if (val.pageEnd < val.pageStart) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'pageEnd must be >= pageStart',
        path: ['pageEnd'],
      });
    }
  });

export const AppsScriptQuestionSchema = z.object({
  order: z.number().int(),
  title: z.string(),
  type: z.enum(['MULTIPLE_CHOICE', 'SHORT_ANSWER', 'PARAGRAPH', 'TRUE_FALSE']),
  options: z.array(z.string()),
  correctOptionIndex: z.number().int().min(0).nullable().optional(),
  correctText: z.string().nullable().optional(),
  imageDriveFileId: z.string().nullable().optional(),
});

export const AppsScriptPayloadSchema = z.object({
  secret: z.string(),
  title: z.string(),
  questions: z.array(AppsScriptQuestionSchema),
});

export type QuestionType = z.infer<typeof QuestionTypeSchema>;
export type ExtractedQuestion = z.infer<typeof ExtractedQuestionSchema>;
export type ExtractedQuestionsPayload = z.infer<typeof ExtractedQuestionsPayloadSchema>;
export type ProcessDocumentJob = z.infer<typeof ProcessDocumentJobSchema>;
export type AppsScriptQuestion = z.infer<typeof AppsScriptQuestionSchema>;
export type AppsScriptPayload = z.infer<typeof AppsScriptPayloadSchema>;
