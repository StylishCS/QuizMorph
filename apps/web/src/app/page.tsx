'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

const TOKEN_KEY = 'quizmorph_token';

function apiBase() {
  return process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';
}

async function apiFetch(path: string, init: RequestInit = {}) {
  const token = typeof window !== 'undefined' ? localStorage.getItem(TOKEN_KEY) : null;
  const headers = new Headers(init.headers);
  headers.set('Accept', 'application/json');
  if (token) headers.set('Authorization', `Bearer ${token}`);
  return fetch(`${apiBase()}${path}`, { ...init, headers });
}

type DocStatus = {
  id: string;
  status: string;
  pageCount: number;
  originalName: string;
  createdAt: string;
};

type QuestionRow = {
  id: string;
  order: number;
  questionText: string;
  questionType: string;
  options: string[];
  answerKey: string | null;
  imageRefs?: string[];
  metadata?: Record<string, unknown>;
};

type FormGenResult = {
  id: string;
  formUrl: string;
  editUrl: string;
  timerEnabled: boolean;
  quilgoHint: string | null;
};

function statusLabel(status: string | undefined): string {
  switch (status) {
    case 'uploaded':
      return 'Your file is ready. Start processing when you are.';
    case 'processing':
      return 'We are reading your PDF and extracting questions. This can take a few minutes.';
    case 'ready':
      return 'Extraction finished. Review your questions below.';
    case 'failed':
      return 'Something went wrong. Open developer information for details or try again.';
    default:
      return 'Waiting for status…';
  }
}

function progressVisual(status: DocStatus | null): {
  percent: number;
  indeterminate: boolean;
  failed: boolean;
} {
  if (!status) return { percent: 0, indeterminate: false, failed: false };
  if (status.status === 'failed') return { percent: 0, indeterminate: false, failed: true };
  if (status.status === 'ready') return { percent: 100, indeterminate: false, failed: false };
  if (status.status === 'processing') return { percent: 40, indeterminate: true, failed: false };
  if (status.status === 'uploaded') return { percent: 18, indeterminate: false, failed: false };
  return { percent: 8, indeterminate: false, failed: false };
}

export default function HomePage() {
  const [token, setToken] = useState<string | null>(null);
  const [docId, setDocId] = useState('');
  const [status, setStatus] = useState<DocStatus | null>(null);
  const [questions, setQuestions] = useState<QuestionRow[] | null>(null);
  const [formResult, setFormResult] = useState<FormGenResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [devOpen, setDevOpen] = useState(false);
  const [customPages, setCustomPages] = useState(false);
  const [pageStartInput, setPageStartInput] = useState('1');
  const [pageEndInput, setPageEndInput] = useState('24');
  const [selectedQuestionId, setSelectedQuestionId] = useState<string | null>(null);
  const questionsLoadedRef = useRef(false);

  useEffect(() => {
    setToken(localStorage.getItem(TOKEN_KEY));
    const authErr = sessionStorage.getItem('quizmorph_auth_error');
    if (authErr) {
      setError(authErr);
      sessionStorage.removeItem('quizmorph_auth_error');
    }
  }, []);

  const authed = useMemo(() => Boolean(token), [token]);

  const signIn = useCallback(() => {
    window.location.href = `${apiBase()}/auth/google`;
  }, []);

  const refreshStatus = useCallback(async () => {
    if (!docId) return;
    const res = await apiFetch(`/documents/${docId}/status`);
    if (res.ok) setStatus((await res.json()) as DocStatus);
  }, [docId]);

  const upload = useCallback(
    async (file: File | null) => {
      if (!file) return;
      setError(null);
      setBusy(true);
      try {
        const fd = new FormData();
        fd.append('file', file);
        const res = await apiFetch('/documents', { method: 'POST', body: fd });
        if (!res.ok) throw new Error(await res.text());
        const data = (await res.json()) as { id: string };
        setDocId(data.id);
        setStatus(null);
        setQuestions(null);
        setFormResult(null);
        setSelectedQuestionId(null);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    },
    [],
  );

  const loadQuestions = useCallback(
    async (opts?: { silent?: boolean }) => {
      if (!docId) return;
      if (!opts?.silent) {
        setError(null);
        setBusy(true);
      }
      try {
        const res = await apiFetch(`/documents/${docId}/questions`);
        if (!res.ok) throw new Error(await res.text());
        setQuestions((await res.json()) as QuestionRow[]);
      } catch (e) {
        if (!opts?.silent) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!opts?.silent) setBusy(false);
      }
    },
    [docId],
  );

  useEffect(() => {
    questionsLoadedRef.current = false;
  }, [docId]);

  useEffect(() => {
    if (!docId) return;
    if (!status || status.status !== 'ready') return;
    if (questionsLoadedRef.current) return;
    questionsLoadedRef.current = true;
    void loadQuestions({ silent: true });
  }, [docId, status, loadQuestions]);

  useEffect(() => {
    if (!questions?.length) return;
    setSelectedQuestionId((prev) =>
      prev && questions.some((q) => q.id === prev) ? prev : questions[0].id,
    );
  }, [questions]);

  const processDoc = useCallback(async () => {
    if (!docId) return;
    setError(null);
    setBusy(true);
    questionsLoadedRef.current = false;
    setQuestions(null);
    setFormResult(null);
    try {
      let body: Record<string, unknown>;
      if (customPages) {
        const ps = Number.parseInt(pageStartInput, 10);
        const pe = Number.parseInt(pageEndInput, 10);
        if (!Number.isFinite(ps) || !Number.isFinite(pe) || ps < 1 || pe < 1) {
          throw new Error('Enter valid page numbers (whole numbers, starting from 1).');
        }
        if (pe < ps) {
          throw new Error('The last page must be greater than or equal to the first page.');
        }
        body = { customPages: true, pageStart: ps, pageEnd: pe };
      } else {
        body = { customPages: false };
      }
      const res = await apiFetch(`/documents/${docId}/process`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(await res.text());
      await res.json();
      await refreshStatus();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [docId, customPages, pageStartInput, pageEndInput]);

  const generateForm = useCallback(async () => {
    if (!docId) return;
    setError(null);
    setBusy(true);
    try {
      const res = await apiFetch(`/documents/${docId}/generate-form`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ timerEnabled: true }),
      });
      if (!res.ok) throw new Error(await res.text());
      setFormResult((await res.json()) as FormGenResult);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [docId]);

  useEffect(() => {
    if (!docId || !authed) return;
    void refreshStatus();
  }, [docId, authed, refreshStatus]);

  useEffect(() => {
    if (!docId || !authed) return;
    const t = setInterval(() => {
      void refreshStatus();
    }, 3000);
    return () => clearInterval(t);
  }, [docId, authed, refreshStatus]);

  const selectedQuestion = useMemo(
    () => questions?.find((q) => q.id === selectedQuestionId) ?? null,
    [questions, selectedQuestionId],
  );

  const prog = progressVisual(status);
  const st = status?.status;

  const devPayload = useMemo(
    () => ({
      documentId: docId || null,
      status,
      questions,
      formResult,
    }),
    [docId, status, questions, formResult],
  );

  useEffect(() => {
    if (!devOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setDevOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [devOpen]);

  return (
    <main className="min-h-screen bg-gradient-to-br from-violet-100/80 via-white to-sky-100/70 px-4 py-10 sm:px-6">
      <div className="mx-auto max-w-3xl space-y-8">
        <header className="text-center sm:text-left">
          <p className="text-sm font-medium uppercase tracking-widest text-violet-600">QuizMorph</p>
          <h1 className="mt-1 bg-gradient-to-r from-violet-700 via-fuchsia-600 to-sky-600 bg-clip-text text-3xl font-bold tracking-tight text-transparent sm:text-4xl">
            Turn your PDF into a quiz
          </h1>
          <p className="mt-3 max-w-xl text-slate-600">
            Upload an exam PDF, let AI pull out the questions, then create a Google Form quiz. For timed
            attempts, you can use{' '}
            <a className="font-medium text-violet-700 underline decoration-violet-300" href="https://quilgo.com" target="_blank" rel="noreferrer">
              Quilgo
            </a>{' '}
            with your form link.
          </p>
          <div className="mt-4 flex flex-wrap items-center justify-center gap-3 sm:justify-start">
            <button
              type="button"
              onClick={() => setDevOpen(true)}
              className="rounded-full border border-slate-200 bg-white/80 px-4 py-2 text-sm font-medium text-slate-700 shadow-sm backdrop-blur hover:bg-white"
            >
              Developer information
            </button>
          </div>
        </header>

        <section className="rounded-2xl border border-white/70 bg-white/90 p-6 shadow-lg shadow-violet-200/40 backdrop-blur">
          <h2 className="text-lg font-semibold text-slate-800">1 · Sign in</h2>
          <p className="mt-1 text-sm text-slate-600">We use Google so the new form can live in your Drive.</p>
          <div className="mt-4">
            {!authed ? (
              <button
                type="button"
                onClick={signIn}
                className="rounded-xl bg-gradient-to-r from-violet-600 to-fuchsia-600 px-5 py-2.5 text-sm font-semibold text-white shadow-md transition hover:brightness-110"
              >
                Continue with Google
              </button>
            ) : (
              <span className="inline-flex items-center gap-2 rounded-full bg-emerald-50 px-4 py-2 text-sm font-medium text-emerald-800 ring-1 ring-emerald-200">
                <span className="h-2 w-2 rounded-full bg-emerald-500" aria-hidden />
                Signed in
              </span>
            )}
          </div>
        </section>

        <section className="rounded-2xl border border-white/70 bg-white/90 p-6 shadow-lg shadow-sky-200/40 backdrop-blur">
          <h2 className="text-lg font-semibold text-slate-800">2 · Upload your PDF</h2>
          <p className="mt-1 text-sm text-slate-600">Only PDF files are accepted.</p>
          <div className="mt-4">
            <label className="flex cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed border-violet-200 bg-violet-50/50 px-6 py-10 transition hover:border-violet-400 hover:bg-violet-50">
              <span className="text-sm font-medium text-violet-800">Choose a file or drop it here</span>
              <span className="mt-1 text-xs text-slate-500">Max size depends on your server settings</span>
              <input
                type="file"
                accept="application/pdf"
                disabled={!authed || busy}
                className="sr-only"
                onChange={(e) => void upload(e.target.files?.[0] ?? null)}
              />
            </label>
            {docId ? (
              <p className="mt-3 text-center text-sm text-slate-500 sm:text-left">
                File uploaded. You can start processing in the next step.
              </p>
            ) : null}
          </div>
        </section>

        <section className="rounded-2xl border border-white/70 bg-white/90 p-6 shadow-lg shadow-fuchsia-200/30 backdrop-blur">
          <h2 className="text-lg font-semibold text-slate-800">3 · Choose pages and process</h2>
          <p className="mt-1 text-sm text-slate-600">
            Leave custom pages off to use the entire PDF. Turn it on to limit which pages are analyzed.
          </p>

          <div className="mt-4 flex items-center gap-3">
            <input
              id="custom-pages"
              type="checkbox"
              checked={customPages}
              disabled={!docId || busy}
              onChange={(e) => setCustomPages(e.target.checked)}
              className="h-4 w-4 rounded border-violet-300 text-violet-600 focus:ring-violet-500"
            />
            <label htmlFor="custom-pages" className="text-sm font-medium text-slate-800">
              Custom page range
            </label>
          </div>

          {customPages ? (
            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              <div>
                <label htmlFor="page-start" className="block text-xs font-medium uppercase tracking-wide text-slate-500">
                  First page
                </label>
                <input
                  id="page-start"
                  type="number"
                  min={1}
                  value={pageStartInput}
                  disabled={!docId || busy}
                  onChange={(e) => setPageStartInput(e.target.value)}
                  className="mt-1 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-slate-900 shadow-inner focus:border-violet-500 focus:outline-none focus:ring-2 focus:ring-violet-200"
                />
              </div>
              <div>
                <label htmlFor="page-end" className="block text-xs font-medium uppercase tracking-wide text-slate-500">
                  Last page
                </label>
                <input
                  id="page-end"
                  type="number"
                  min={1}
                  value={pageEndInput}
                  disabled={!docId || busy}
                  onChange={(e) => setPageEndInput(e.target.value)}
                  className="mt-1 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-slate-900 shadow-inner focus:border-violet-500 focus:outline-none focus:ring-2 focus:ring-violet-200"
                />
              </div>
            </div>
          ) : null}

          <div className="mt-6 space-y-3">
            <div className="flex flex-wrap gap-3">
              <button
                type="button"
                disabled={!docId || busy}
                onClick={() => void processDoc()}
                className="rounded-xl bg-gradient-to-r from-violet-600 to-indigo-600 px-5 py-2.5 text-sm font-semibold text-white shadow-md transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-45"
              >
                Start processing
              </button>
              <button
                type="button"
                disabled={!docId || busy}
                onClick={() => void refreshStatus()}
                className="rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm font-medium text-slate-700 shadow-sm hover:bg-slate-50 disabled:opacity-45"
              >
                Refresh progress
              </button>
              <button
                type="button"
                disabled={!docId || busy || st !== 'ready'}
                onClick={() => void loadQuestions()}
                className="rounded-xl border border-violet-200 bg-violet-50 px-4 py-2.5 text-sm font-medium text-violet-900 hover:bg-violet-100 disabled:opacity-45"
              >
                Reload questions
              </button>
            </div>

            <div>
              <div className="mb-1 flex items-center justify-between gap-2 text-xs text-slate-500">
                <span>{statusLabel(st)}</span>
                {typeof status?.pageCount === 'number' && status.pageCount > 0 ? (
                  <span className="shrink-0 text-slate-400">{status.pageCount} pages in PDF</span>
                ) : null}
              </div>
              <div
                className="relative h-3 overflow-hidden rounded-full bg-slate-200/90 shadow-inner"
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={prog.indeterminate ? undefined : prog.percent}
                aria-label="Processing progress"
              >
                {prog.failed ? (
                  <div className="h-full w-full rounded-full bg-red-400/90" />
                ) : prog.indeterminate ? (
                  <div
                    className="quizmorph-progress-indeterminate absolute top-0 h-full w-2/5 rounded-full bg-gradient-to-r from-violet-500 via-fuchsia-500 to-sky-500 shadow-md"
                  />
                ) : (
                  <div
                    className="h-full rounded-full bg-gradient-to-r from-violet-500 via-fuchsia-500 to-sky-500 transition-[width] duration-500 ease-out"
                    style={{ width: `${prog.percent}%` }}
                  />
                )}
              </div>
            </div>
          </div>
        </section>

        <section className="rounded-2xl border border-white/70 bg-white/90 p-6 shadow-lg shadow-indigo-200/30 backdrop-blur">
          <h2 className="text-lg font-semibold text-slate-800">4 · Create the Google Form</h2>
          <p className="mt-1 text-sm text-slate-600">
            {/* TODO: add a review-and-approve step before generating the form, and optional in-place edits. */}
            When extraction is ready, create a quiz form in your Google account.
          </p>
          <button
            type="button"
            disabled={!docId || busy || st !== 'ready'}
            onClick={() => void generateForm()}
            className="mt-4 rounded-xl bg-gradient-to-r from-sky-600 to-cyan-600 px-5 py-2.5 text-sm font-semibold text-white shadow-md transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-45"
          >
            Generate Google Form
          </button>

          {formResult ? (
            <div className="mt-5 space-y-3 rounded-xl border border-sky-100 bg-sky-50/80 p-4 text-sm">
              <p className="font-medium text-slate-800">Your form is ready</p>
              <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
                <a
                  href={formResult.formUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex justify-center rounded-lg bg-sky-600 px-4 py-2 font-medium text-white hover:bg-sky-500"
                >
                  Open form (respond)
                </a>
                <a
                  href={formResult.editUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex justify-center rounded-lg border border-slate-300 bg-white px-4 py-2 font-medium text-slate-800 hover:bg-slate-50"
                >
                  Edit in Google Forms
                </a>
              </div>
              {formResult.quilgoHint ? <p className="text-xs text-slate-600">{formResult.quilgoHint}</p> : null}
            </div>
          ) : null}
        </section>

        {questions?.length ? (
          <section className="rounded-2xl border border-white/70 bg-white/90 p-6 shadow-lg shadow-violet-200/30 backdrop-blur">
            <h2 className="text-lg font-semibold text-slate-800">Extracted questions</h2>
            <p className="mt-1 text-sm text-slate-600">
              {questions.length} question{questions.length === 1 ? '' : 's'} loaded. Pick one from the list to
              read it in full.
            </p>
            <div className="mt-4">
              <label htmlFor="question-select" className="sr-only">
                Select a question
              </label>
              <select
                id="question-select"
                value={selectedQuestionId ?? ''}
                onChange={(e) => setSelectedQuestionId(e.target.value)}
                className="w-full rounded-xl border border-slate-200 bg-white px-3 py-3 text-sm font-medium text-slate-900 shadow-inner focus:border-violet-500 focus:outline-none focus:ring-2 focus:ring-violet-200"
              >
                {questions.map((q) => (
                  <option key={q.id} value={q.id}>
                    #{q.order + 1} · {q.questionText.replace(/\s+/g, ' ').slice(0, 120)}
                    {q.questionText.length > 120 ? '…' : ''}
                  </option>
                ))}
              </select>
            </div>
            {selectedQuestion ? (
              <article className="mt-5 space-y-4 rounded-xl border border-violet-100 bg-gradient-to-br from-violet-50/80 to-white p-5">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="rounded-full bg-violet-600 px-3 py-0.5 text-xs font-semibold uppercase tracking-wide text-white">
                    {selectedQuestion.questionType.replace(/_/g, ' ')}
                  </span>
                  <span className="text-xs text-slate-500">Question {selectedQuestion.order + 1}</span>
                </div>
                <p className="whitespace-pre-wrap text-base leading-relaxed text-slate-800">{selectedQuestion.questionText}</p>
                {selectedQuestion.options?.length ? (
                  <ul className="space-y-2">
                    {selectedQuestion.options.map((opt, i) => (
                      <li
                        key={`${selectedQuestion.id}-opt-${i}`}
                        className="flex gap-3 rounded-lg border border-white bg-white/90 px-3 py-2 text-sm shadow-sm"
                      >
                        <span className="font-semibold text-violet-600">{String.fromCharCode(65 + i)}.</span>
                        <span className="text-slate-700">{opt}</span>
                      </li>
                    ))}
                  </ul>
                ) : null}
                {selectedQuestion.answerKey ? (
                  <p className="rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-900 ring-1 ring-emerald-100">
                    <span className="font-semibold">Answer key:</span> {selectedQuestion.answerKey}
                  </p>
                ) : (
                  <p className="text-sm text-slate-500">No answer key stored for this item.</p>
                )}
              </article>
            ) : null}
          </section>
        ) : st === 'ready' && questions && questions.length === 0 ? (
          <p className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-center text-sm text-amber-900">
            Processing finished, but no questions were found. Try a different page range or another PDF.
          </p>
        ) : null}

        {error ? (
          <p className="rounded-2xl border border-red-200 bg-red-50 p-4 text-center text-sm text-red-900 shadow-sm">{error}</p>
        ) : null}

        {busy ? (
          <p className="text-center text-xs font-medium text-violet-700" aria-live="polite">
            Working on your request…
          </p>
        ) : null}
      </div>

      {devOpen ? (
        <div
          className="fixed inset-0 z-50 flex items-end justify-center bg-slate-900/50 p-4 sm:items-center"
          role="dialog"
          aria-modal="true"
          aria-labelledby="dev-modal-title"
          onClick={() => setDevOpen(false)}
        >
          <div
            className="max-h-[85vh] w-full max-w-2xl overflow-hidden rounded-2xl bg-slate-950 shadow-2xl ring-1 ring-white/10"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-white/10 px-4 py-3">
              <h2 id="dev-modal-title" className="text-sm font-semibold text-white">
                Developer information
              </h2>
              <button
                type="button"
                onClick={() => setDevOpen(false)}
                className="rounded-lg px-3 py-1 text-sm text-slate-300 hover:bg-white/10 hover:text-white"
              >
                Close
              </button>
            </div>
            <pre className="max-h-[calc(85vh-3.5rem)] overflow-auto p-4 text-xs leading-relaxed text-emerald-100/90">
              {JSON.stringify(devPayload, null, 2)}
            </pre>
          </div>
        </div>
      ) : null}
    </main>
  );
}
