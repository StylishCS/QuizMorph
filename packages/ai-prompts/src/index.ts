import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

export function loadQuestionExtractionPromptV1(): string {
  const candidates = [
    join(here, 'prompts', 'question-extraction.v1.txt'),
    join(here, '..', 'prompts', 'question-extraction.v1.txt'),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return readFileSync(p, 'utf-8');
  }
  throw new Error('Could not load question-extraction.v1.txt');
}
