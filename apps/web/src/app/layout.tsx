import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'QuizMorph',
  description: 'Exam PDF to timed Google Forms',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="mx-auto max-w-3xl px-4 py-10">{children}</body>
    </html>
  );
}
