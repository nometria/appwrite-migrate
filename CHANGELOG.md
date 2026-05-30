# Changelog

All notable changes to `appwrite-migrate` are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

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
