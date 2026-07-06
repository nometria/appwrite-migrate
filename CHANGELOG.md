# Changelog

All notable changes to `appwrite-migrate` are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [Unreleased]

### Added
- Pure planning core extracted to `src/plan.js`, importable via
  `@nometria-ai/appwrite-migrate/plan` — `buildPlan`, `buildMigrationManifest`,
  `planSeedDocs`, `coerceValueForAttribute`, `jsonTypeToAppwrite`,
  `entityToCollectionId`. Side-effect-free (no Appwrite, no filesystem), so
  consumers can compute a plan and preview seed coercion without writing.
- `planSeedDocs(plan, seedData)` — dry-run seed planner that mirrors the live
  runner: drops unknown keys, clamps integer/float to attribute range,
  JSON-serializes objects, fills missing required attributes, and reports
  per-row diagnostics (`dropped`, `clamped`, `filled`).
- `runMigrations({ appDir, dryRun })` library entry point (matching the README).
- `string` attribute size now respects JSON Schema `maxLength` (was previously
  hard-coded to 65535 for non-date strings).

### Changed
- `migrate.js` now consumes the shared core instead of duplicating the type
  mapping and coercion logic, so CLI runs and computed plans can never drift.
- The migration only auto-runs when invoked as a script; importing the module as
  a library no longer triggers a migration.

## [1.0.0] - 2025-03-22

### Added
- Automatic collection creation from JSON Entity schemas (`src/Entities/*.json`)
- Full attribute type support: `string`, `integer`, `float`, `boolean`, native string arrays, JSON objects
- Integer/float `min`/`max` clamping to avoid Appwrite attribute range errors
- Common audit fields auto-added: `created_by_id`, `created_at`, `updated_at`, `created_by`
- Data seeding from `db/appwrite/002_data.json`
- Migration tracking via `migrations` collection - fully idempotent
- `waitForAttributes` polling to handle Appwrite's async attribute processing
- Seed data normalization: coercion, required defaults, unknown key filtering
- `RUN_APPWRITE_MIGRATIONS=false` env var to disable in CI without removing the script
- Support for `VITE_APPWRITE_*` env var prefix (Vite project convention)
