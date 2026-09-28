import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SEED_FILE, renderPermissionSeedSql } from '../src/lib/permissions/seed-sql';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const target = resolve(appRoot, SEED_FILE);
mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, renderPermissionSeedSql(), 'utf8');
console.log(`Wrote ${SEED_FILE}`);
