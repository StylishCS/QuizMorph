'use client';

import { useEffect, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';

const TOKEN_KEY = 'quizmorph_token';

function CallbackInner() {
  const router = useRouter();
  const params = useSearchParams();

  useEffect(() => {
    const err = params.get('error');
    if (err) {
      sessionStorage.setItem('quizmorph_auth_error', decodeURIComponent(err));
      router.replace('/');
      return;
    }
    const token = params.get('token');
    if (token) {
      localStorage.setItem(TOKEN_KEY, token);
    }
    router.replace('/');
  }, [params, router]);

  return <p className="text-sm text-slate-600">Finishing sign-in…</p>;
}

export default function AuthCallbackPage() {
  return (
    <Suspense fallback={<p className="text-sm text-slate-600">Loading…</p>}>
      <CallbackInner />
    </Suspense>
  );
}
