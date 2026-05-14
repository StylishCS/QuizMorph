import { config } from 'dotenv';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/** Load `.env` from worker dir, `apps/`, or monorepo root (same idea as the API). */
const paths = [
  join(process.cwd(), '.env'),
  join(process.cwd(), '..', '.env'),
  join(process.cwd(), '..', '..', '.env'),
];
for (const p of paths) {
  if (existsSync(p)) {
    config({ path: p });
  }
}
