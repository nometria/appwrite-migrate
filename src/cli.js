#!/usr/bin/env node
/**
 * appwrite-migrate CLI
 *
 * Usage:
 *   appwrite-migrate                         # run from app directory
 *   appwrite-migrate --app-dir /path/to/app  # explicit app directory
 *   appwrite-migrate --dry-run               # validate without writing
 *
 * Env vars (loaded from .env in app dir):
 *   APPWRITE_ENDPOINT, APPWRITE_PROJECT_ID, APPWRITE_API_KEY
 *   APPWRITE_DATABASE_ID  (default: main)
 *   APPWRITE_MIGRATIONS_DIR
 *   RUN_APPWRITE_MIGRATIONS  (set to "false" to skip)
 */

import { parseArgs } from 'util';
import { resolve } from 'path';
import { existsSync } from 'fs';

const { values } = parseArgs({
  options: {
    'app-dir':  { type: 'string', short: 'a', default: process.cwd() },
    'dry-run':  { type: 'boolean', default: false },
    'help':     { type: 'boolean', short: 'h', default: false },
  },
  strict: false,
});

if (values.help) {
  console.log(`
appwrite-migrate - schema-driven Appwrite migration runner

Usage:
  appwrite-migrate [options]

Options:
  --app-dir, -a   Path to your app directory (default: cwd)
  --dry-run        Validate config without creating collections
  --help, -h       Show this help

Env vars (in .env or shell):
  APPWRITE_ENDPOINT          https://cloud.appwrite.io/v1
  APPWRITE_PROJECT_ID        your-project-id
  APPWRITE_API_KEY           your-api-key
  APPWRITE_DATABASE_ID       main (default)
  APPWRITE_MIGRATIONS_DIR    path/to/migrations (default: <app-dir>/db/appwrite)
  RUN_APPWRITE_MIGRATIONS    true (set to false to skip)
`);
  process.exit(0);
}

const appDir = resolve(values['app-dir']);
if (!existsSync(appDir)) {
  console.error(`App directory not found: ${appDir}`);
  process.exit(1);
}

// Load .env
const dotenvPath = `${appDir}/.env`;
if (existsSync(dotenvPath)) {
  const { config } = await import('dotenv');
  config({ path: dotenvPath });
}

process.env.APP_DIR = appDir;

if (values['dry-run']) {
  console.log('[appwrite-migrate] DRY RUN - validating config only');
  process.env.RUN_APPWRITE_MIGRATIONS = 'false';
}

// Run migrations
await import('./migrate.js');
