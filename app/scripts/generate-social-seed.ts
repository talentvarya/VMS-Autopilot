import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SOCIAL_SEED_FILE, renderSocialSeedSql } from '../src/lib/social/seed-sql';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const target = resolve(appRoot, SOCIAL_SEED_FILE);
mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, renderSocialSeedSql(), 'utf8');
console.log(`Wrote ${SOCIAL_SEED_FILE}`);
