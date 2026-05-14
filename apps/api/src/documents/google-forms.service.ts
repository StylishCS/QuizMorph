import { Injectable, InternalServerErrorException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { google } from 'googleapis';
import type { forms_v1 } from 'googleapis';
import type { AppsScriptQuestion } from '@quizmorph/shared-types';

@Injectable()
export class GoogleFormsService {
  private readonly log = new Logger(GoogleFormsService.name);

  constructor(private readonly config: ConfigService) {}

  /** Google Forms rejects displayed text that contains newline characters. */
  private formLine(text: string | null | undefined, maxLen = 10_000): string {
    if (text == null || text === '') return '';
    const s = String(text).replace(/\r\n|\n|\r/g, ' ').replace(/\s+/g, ' ').trim();
    return s.length > maxLen ? s.slice(0, maxLen) : s;
  }

  private oauthClient(refreshToken: string) {
    const client = new google.auth.OAuth2(
      this.config.get<string>('GOOGLE_CLIENT_ID') ?? '',
      this.config.get<string>('GOOGLE_CLIENT_SECRET') ?? '',
      this.config.get<string>('GOOGLE_CALLBACK_URL') ?? 'http://localhost:3001/auth/google/callback',
    );
    client.setCredentials({ refresh_token: refreshToken });
    return client;
  }

  async createQuizForm(refreshToken: string, title: string, questions: AppsScriptQuestion[]) {
    this.log.log(
      `[createQuizForm] start title=${JSON.stringify(title)} questionCount=${questions.length}`,
    );
    const auth = this.oauthClient(refreshToken);
    const forms = google.forms({ version: 'v1', auth });

    const safeTitle = this.formLine(`QuizMorph — ${title}`, 200);
    const createRes = await forms.forms.create({
      requestBody: {
        info: { title: safeTitle || 'QuizMorph quiz' },
      },
    });

    const formId = createRes.data.formId;
    if (!formId) {
      throw new InternalServerErrorException('Google Forms API returned no formId');
    }
    this.log.log(`[createQuizForm] forms.create ok formId=${formId}`);

    const sorted = [...questions].sort((a, b) => a.order - b.order);
    const requests = this.buildBatchRequests(sorted);
    this.log.debug(`[createQuizForm] batchUpdate requestCount=${requests.length}`);

    if (requests.length) {
      await forms.forms.batchUpdate({
        formId,
        requestBody: { requests },
      });
      this.log.log(`[createQuizForm] batchUpdate done formId=${formId}`);
    }

    const formUrl =
      createRes.data.responderUri ?? `https://docs.google.com/forms/d/${formId}/viewform`;
    const editUrl = `https://docs.google.com/forms/d/${formId}/edit`;

    this.log.log(`[createQuizForm] complete formId=${formId} formUrl=${formUrl}`);
    return { formId, formUrl, editUrl };
  }

  private buildBatchRequests(questions: AppsScriptQuestion[]): forms_v1.Schema$Request[] {
    const requests: forms_v1.Schema$Request[] = [
      {
        updateSettings: {
          settings: {
            quizSettings: {
              isQuiz: true,
            },
          },
          updateMask: 'quizSettings.isQuiz',
        },
      },
    ];

    let index = 0;
    for (const q of questions) {
      const itemTitle = this.formLine(q.title) || 'Question';
      if (q.type === 'MULTIPLE_CHOICE' || q.type === 'TRUE_FALSE') {
        const rawOpts =
          q.options && q.options.length ? q.options : ['A', 'B', 'C', 'D'];
        const opts = rawOpts.map((o) => this.formLine(o) || '—');
        const correctIdx =
          q.correctOptionIndex !== null && q.correctOptionIndex !== undefined
            ? q.correctOptionIndex
            : 0;
        const safeIdx = correctIdx >= 0 && correctIdx < opts.length ? correctIdx : 0;
        const correctValue = this.formLine(opts[safeIdx] ?? opts[0]) || opts[0];

        requests.push({
          createItem: {
            item: {
              title: itemTitle,
              questionItem: {
                question: {
                  choiceQuestion: {
                    type: 'RADIO',
                    options: opts.map((value) => ({ value })),
                  },
                  grading: {
                    pointValue: 1,
                    correctAnswers: {
                      answers: [{ value: correctValue }],
                    },
                  },
                },
              },
            },
            location: { index },
          },
        });
      } else if (q.type === 'SHORT_ANSWER') {
        const correct = this.formLine(q.correctText);
        requests.push({
          createItem: {
            item: {
              title: itemTitle,
              questionItem: {
                question: {
                  textQuestion: { paragraph: false },
                  ...(correct
                    ? {
                        grading: {
                          pointValue: 1,
                          correctAnswers: { answers: [{ value: correct }] },
                        },
                      }
                    : {}),
                },
              },
            },
            location: { index },
          },
        });
      } else {
        const correct = this.formLine(q.correctText);
        requests.push({
          createItem: {
            item: {
              title: itemTitle,
              questionItem: {
                question: {
                  textQuestion: { paragraph: true },
                  ...(correct
                    ? {
                        grading: {
                          pointValue: 1,
                          correctAnswers: { answers: [{ value: correct }] },
                        },
                      }
                    : {}),
                },
              },
            },
            location: { index },
          },
        });
      }
      index += 1;
    }

    return requests;
  }
}
