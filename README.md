# appwrite-migrate

[![npm version](https://img.shields.io/npm/v/appwrite-migrate.svg)](https://www.npmjs.com/package/appwrite-migrate)
[![npm downloads](https://img.shields.io/npm/dm/appwrite-migrate.svg)](https://www.npmjs.com/package/appwrite-migrate)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18-brightgreen)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

> Schema-driven migration runner for Appwrite. The missing `prisma migrate` for Appwrite.

Creates collections from JSON Entity schemas, handles all attribute types (including native string arrays and float/integer range clamping), seeds data from a JSON file, and tracks applied migrations idempotently — so it's safe to run on every deploy.

---

## Quick start

```bash
# Install
npm install --save-dev appwrite-migrate

# Set up your environment
cat > .env << 'EOF'
APPWRITE_ENDPOINT=https://cloud.appwrite.io/v1
APPWRITE_PROJECT_ID=your-project-id
APPWRITE_API_KEY=your-api-key
APPWRITE_DATABASE_ID=main
EOF

# Place entity schemas (see examples/src/Entities/)
mkdir -p src/Entities
# Copy examples/src/Entities/Task.json to src/Entities/

# Run migrations
npx appwrite-migrate

# Validate without writing anything
npx appwrite-migrate --dry-run
```

---

## Install

```bash
# Run without installing
npx appwrite-migrate

# Install globally
npm install -g appwrite-migrate

# Or as a dev dependency
npm install --save-dev appwrite-migrate
```

---

## Setup

**1. Add environment variables** (`.env` in your app directory):

```bash
APPWRITE_ENDPOINT=https://cloud.appwrite.io/v1
APPWRITE_PROJECT_ID=your-project-id
APPWRITE_API_KEY=your-api-key           # requires collections.write scope
APPWRITE_DATABASE_ID=main
```

**2. Place Entity schemas** in `src/Entities/`:

```json
// src/Entities/Task.json
{
  "properties": {
    "title":     { "type": "string",  "maxLength": 500 },
    "body":      { "type": "string",  "maxLength": 5000 },
    "completed": { "type": "boolean", "default": false },
    "priority":  { "type": "integer", "minimum": 1, "maximum": 10 },
    "score":     { "type": "float",   "minimum": 0.0, "maximum": 100.0 },
    "tags":      { "type": "array",   "items": { "type": "string" } },
    "meta":      { "type": "object" }
  },
  "required": ["title"]
}
```

**3. Optionally add seed data** at `db/appwrite/002_data.json`:

```json
{
  "task": [
    { "id": "seed-1", "title": "First task", "completed": false, "priority": 5 }
  ],
  "category": [
    { "id": "cat-1", "name": "Work" }
  ]
}
```

---

## Run

```bash
# From your app directory
npx appwrite-migrate

# Specify a different app directory
npx appwrite-migrate --app-dir /path/to/my-app

# Validate config and schema without writing anything
npx appwrite-migrate --dry-run

# Disable via env var (useful in CI to skip migrations)
RUN_APPWRITE_MIGRATIONS=false npx appwrite-migrate
```

---

## Directory structure

```
your-app/
├── .env
├── src/
│   └── Entities/
│       ├── Task.json
│       ├── User.json
│       └── Category.json
└── db/
    └── appwrite/
        └── 002_data.json   ← optional seed data
```

---

## Supported attribute types

| JSON Schema type | Appwrite attribute | Notes |
|-----------------|-------------------|-------|
| `string` | String | `maxLength` respected (default: 255) |
| `integer` | Integer | `minimum`/`maximum` clamped to Appwrite limits |
| `float` | Float | `minimum`/`maximum` clamped |
| `boolean` | Boolean | — |
| `array` of string | String Array | Native Appwrite array |
| `object` | String | JSON-serialized (Appwrite has no native object type) |

---

## Automatic audit fields

Every collection automatically gets these fields added:

| Field | Type | Description |
|-------|------|-------------|
| `created_by_id` | string | ID of the creating user |
| `created_by` | string | Display name of the creating user |
| `created_at` | string | ISO 8601 creation timestamp |
| `updated_at` | string | ISO 8601 last-updated timestamp |

---

## Idempotency

`appwrite-migrate` tracks every applied migration in a `migrations` collection in your Appwrite database. Running it twice is safe — already-applied migrations are skipped. This makes it suitable for `postinstall` scripts or deploy hooks.

```json
// package.json
{
  "scripts": {
    "postinstall": "appwrite-migrate",
    "deploy": "npm run build && appwrite-migrate && npm start"
  }
}
```

---

## CLI reference

```
appwrite-migrate [options]

Options:
  --app-dir   Path to your app directory (default: current directory)
  --dry-run   Validate without creating collections or seeding data
  --help      Show help

Environment variables:
  APPWRITE_ENDPOINT      Appwrite instance URL
  APPWRITE_PROJECT_ID    Project ID
  APPWRITE_API_KEY       API key (requires collections.write, databases.write)
  APPWRITE_DATABASE_ID   Database ID (default: main)
  RUN_APPWRITE_MIGRATIONS  Set to 'false' to skip (default: true)
  VITE_APPWRITE_ENDPOINT   Alternative: Vite-prefixed env vars are also read
  VITE_APPWRITE_PROJECT_ID
  VITE_APPWRITE_API_KEY
  VITE_APPWRITE_DATABASE_ID
```

---

## Use as a library

```js
import { runMigrations } from 'appwrite-migrate';

await runMigrations({
  appDir: './my-app',
  dryRun: false,
});
```

---

## Important: API key permissions

The API key used must have these scopes enabled in the Appwrite Console:

- `databases.read` / `databases.write`
- `collections.read` / `collections.write`
- `attributes.read` / `attributes.write`
- `documents.read` / `documents.write`

---

## Contributing

PRs welcome. Run tests with `npm test`.

---

## License

MIT © [Nometria](https://nometria.com)

---

## Example output

Running `node --test tests/migrate.test.js`:

```
✔ CLI prints help and exits 0 (50.738208ms)
✔ CLI errors without required config (117.514125ms)
ℹ tests 2
ℹ suites 0
ℹ pass 2
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 314.400125
```

CLI help output:

```
appwrite-migrate — schema-driven Appwrite migration runner

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
```

See `examples/src/Entities/` for sample Task and User schema files.
