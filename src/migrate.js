#!/usr/bin/env node
/**
 * Appwrite Migration Runner
 *
 * Similar to run-migrations.sh for Supabase, but for Appwrite.
 * Creates collections from Entity schemas and seeds data from JSON files.
 *
 * Usage:
 *   APP_DIR=/path/to/app node scripts/run_appwrite_migrations.js
 *   Or: cd base44-downloader && ../scripts/run_appwrite_migrations.js
 *
 * Env vars (from .env):
 *   APPWRITE_ENDPOINT, APPWRITE_PROJECT_ID, APPWRITE_API_KEY
 *   APPWRITE_DATABASE_ID (default: main)
 *   RUN_APPWRITE_MIGRATIONS (default: true)
 *   APPWRITE_MIGRATIONS_DIR (default: APP_DIR/db/appwrite)
 */

import fs from "fs";
import path from "path";
import * as sdk from "node-appwrite";
import {
  INTEGER_MAX,
  FLOAT_MAX,
  entityToCollectionId,
  jsonTypeToAppwrite,
  coerceValueForAttribute,
  defaultForType,
} from "./plan.js";

function log(msg, obj) {
  console.log(`[appwrite-migrate] ${msg}`, obj ?? "");
}
function errlog(msg, obj) {
  console.error(`[appwrite-migrate] ERROR: ${msg}`, obj ?? "");
}

function env(name, def = null) {
  const v = process.env[name];
  return v !== undefined && v !== "" ? v : def;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Load Entity JSON schemas from a directory
 */
function loadEntitySchemas(entitiesPath) {
  const schemas = {};
  if (!fs.existsSync(entitiesPath)) return schemas;
  const files = fs.readdirSync(entitiesPath);
  for (const f of files) {
    if (f.endsWith(".json")) {
      const name = f.replace(/\.json$/i, "");
      const full = path.join(entitiesPath, f);
      try {
        const content = JSON.parse(fs.readFileSync(full, "utf8"));
        if (content?.properties) schemas[name] = content;
      } catch (e) {
        errlog(`Failed to load ${f}`, e.message);
      }
    }
  }
  return schemas;
}

/** Common attributes for all entity collections (like Supabase schema) */
const COMMON_ATTRS = [
  { key: "created_by_id", type: "string", size: 255, required: false },
  { key: "created_by", type: "string", size: 255, required: false },
  { key: "is_sample", type: "boolean", required: false },
  // Legacy / alternate date field names so seed data and older exports work
  { key: "created_date", type: "string", size: 64, required: false },
  { key: "updated_date", type: "string", size: 64, required: false },
  { key: "created_at", type: "string", size: 64, required: false },
  { key: "updated_at", type: "string", size: 64, required: false },
];

/**
 * Build collection definition from Entity schema
 */
function buildCollectionFromEntity(entityName, schema) {
  const collectionId = entityToCollectionId(entityName);
  const attrs = [...COMMON_ATTRS];
  const props = schema.properties || {};
  const required = new Set(schema.required || []);
  const seen = new Set(COMMON_ATTRS.map((a) => a.key));

  for (const [key, val] of Object.entries(props)) {
    const keySnake = key.replace(/([A-Z])/g, "_$1").toLowerCase().replace(/^_/, "");
    if (seen.has(keySnake)) continue;
    seen.add(keySnake);
    const appwriteType = jsonTypeToAppwrite(val, key);
    attrs.push({
      key: keySnake,
      required: required.has(key),
      ...appwriteType,
      default: val.default,
    });
  }

  return { collectionId, name: entityName, attributes: attrs };
}

/**
 * Wait for collection attributes to be available (Appwrite processes async)
 */
async function waitForAttributes(databases, databaseId, collectionId, timeoutMs = 60000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const col = await databases.getCollection(databaseId, collectionId);
      const attrs = col.attributes || [];
      const processing = attrs.some((a) => a.status === "processing");
      if (!processing) return true;
    } catch (_) {}
    await sleep(1000);
  }
  return false;
}

/**
 * Create a single attribute on a collection.
 * String attributes can be array: true for native string[] support.
 */
async function createAttribute(databases, databaseId, collectionId, attr) {
  const { key, required, type, size, default: def, array: isArray, min: attrMin, max: attrMax } = attr;
  try {
    if (type === "string") {
      // createStringAttribute(..., default, array). Default must be "" or null; cannot set default when required.
      const stringDefault = required ? null : (def != null && typeof def === "string" ? def : "");
      if (isArray) {
        await databases.createStringAttribute(databaseId, collectionId, key, size || 255, required, null, true);
      } else {
        await databases.createStringAttribute(databaseId, collectionId, key, size || 255, required, stringDefault);
      }
    } else if (type === "integer") {
      // SDK order: databaseId, collectionId, key, required, min, max, xdefault, array. Always pass min=0 so seeding accepts 0.
      const min = attrMin != null ? Math.floor(Number(attrMin)) : 0;
      const max = attrMax != null ? Math.floor(Number(attrMax)) : INTEGER_MAX;
      await databases.createIntegerAttribute(databaseId, collectionId, key, required, min, max);
    } else if (type === "float") {
      // SDK order: key, required, min, max, xdefault. Pass min/max explicitly so default is never used as min (e.g. 5).
      const min = attrMin != null ? Number(attrMin) : 0;
      const max = attrMax != null ? Number(attrMax) : FLOAT_MAX;
      await databases.createFloatAttribute(databaseId, collectionId, key, required, min, max, def);
    } else if (type === "boolean") {
      await databases.createBooleanAttribute(databaseId, collectionId, key, required, def);
    } else {
      const stringDefault = required ? null : (def != null && typeof def === "string" ? def : "");
      await databases.createStringAttribute(databaseId, collectionId, key, size || 255, required, stringDefault);
    }
  } catch (e) {
    if (e.code === 409 || e.message?.includes("already exists")) return;
    throw e;
  }
}

/**
 * Ensure database exists
 */
async function ensureDatabase(databases, databaseId, databaseName) {
  try {
    await databases.get(databaseId);
    return;
  } catch (_) {}
  await databases.create(databaseId, databaseName || databaseId);
}

/** Appwrite collectionId: only a-z, A-Z, 0-9, ., -, _; max 36 chars; cannot start with special char */
const MIGRATIONS_COLLECTION_ID = "migrations";

/**
 * Ensure migrations collection exists and get applied migrations.
 * Always ensure filename/executed_at attributes exist (collection may exist from a previous run without them).
 */
async function getAppliedMigrations(databases, databaseId) {
  const collId = MIGRATIONS_COLLECTION_ID;
  try {
    await databases.getCollection(databaseId, collId);
  } catch (_) {
    await databases.createCollection(databaseId, collId, "Migrations");
    await sleep(500);
  }
  // Ensure attributes exist (idempotent: 409 = already exists)
  for (const [key, size, required, def] of [
    ["filename", 255, true, null],
    ["executed_at", 64, false, ""],
  ]) {
    try {
      await databases.createStringAttribute(databaseId, collId, key, size, required, def);
      await sleep(300);
    } catch (e) {
      if (e.code !== 409 && !e.message?.includes("already exists")) throw e;
    }
  }
  await waitForAttributes(databases, databaseId, collId);

  const list = await databases.listDocuments(databaseId, collId, [sdk.Query.limit(500)]);
  return new Set((list.documents || []).map((d) => d.filename));
}

async function recordMigration(databases, databaseId, filename) {
  const collId = MIGRATIONS_COLLECTION_ID;
  await databases.createDocument(
    databaseId,
    collId,
    sdk.ID.unique(),
    { filename, executed_at: new Date().toISOString() }
  );
}

/**
 * Get allowed attribute keys, types, array flag, min/max, and required defaults for a collection.
 * Used so seed data can be filtered and coerced to match current schema (including integer/float ranges).
 */
async function getCollectionSchemaForSeed(databases, databaseId, collectionId) {
  const col = await databases.getCollection(databaseId, collectionId);
  const attrs = col.attributes || [];
  const allowedKeys = new Set(attrs.map((a) => a.key));
  const attrTypes = {};
  const attrArrays = {};
  const attrMin = {};
  const attrMax = {};
  const requiredDefaults = {};
  for (const a of attrs) {
    attrTypes[a.key] = (a.type || "string").toLowerCase();
    attrArrays[a.key] = !!a.array;
    if (a.min != null) attrMin[a.key] = (a.type || "").toLowerCase() === "integer" ? Math.floor(Number(a.min)) : Number(a.min);
    if (a.max != null) attrMax[a.key] = (a.type || "").toLowerCase() === "integer" ? Math.floor(Number(a.max)) : Number(a.max);
    if (a.required) {
      const def = defaultForType(a.type);
      const t = attrTypes[a.key];
      if ((t === "integer" || t === "float") && a.min != null) {
        const min = t === "integer" ? Math.floor(Number(a.min)) : Number(a.min);
        requiredDefaults[a.key] = typeof def === "number" ? (t === "integer" ? Math.floor(Math.max(min, def)) : Math.max(min, def)) : min;
      } else {
        requiredDefaults[a.key] = def;
      }
    }
  }
  return { allowedKeys, attrTypes, attrArrays, attrMin, attrMax, requiredDefaults };
}

/**
 * Normalize a seed document to match the collection schema: only include allowed attributes,
 * coerce values (native arrays; JSON string for objects; clamp integer/float to min/max), and
 * fill missing required attributes with defaults.
 */
function normalizeSeedDoc(doc, allowedKeys, attrTypes, attrArrays, attrMin, attrMax, requiredDefaults) {
  const out = {};
  for (const [key, value] of Object.entries(doc)) {
    if (allowedKeys.has(key)) {
      out[key] = coerceValueForAttribute(value, attrTypes[key], attrArrays[key], attrMin[key], attrMax[key]);
    }
  }
  for (const [key, defaultValue] of Object.entries(requiredDefaults)) {
    if (out[key] === undefined || out[key] === null || out[key] === "") {
      out[key] = defaultValue;
    }
  }
  return out;
}

/** Legacy date attribute names we ensure exist so older seed data can be stored */
const LEGACY_DATE_ATTRS = [
  { key: "created_date", size: 64 },
  { key: "updated_date", size: 64 },
  { key: "created_at", size: 64 },
  { key: "updated_at", size: 64 },
];

/**
 * Ensure common date attributes exist on a collection (for older seed data).
 * Idempotent: skips if attribute already exists.
 */
async function ensureLegacyDateAttributes(databases, databaseId, collectionId) {
  for (const { key, size } of LEGACY_DATE_ATTRS) {
    try {
      await databases.createStringAttribute(databaseId, collectionId, key, size, false, "");
      await sleep(200);
    } catch (e) {
      if (e.code === 409 || e.message?.includes("already exists")) continue;
      throw e;
    }
  }
}

async function main() {
  const appDir = env("APP_DIR") || process.cwd();
  const migrationsDir = env("APPWRITE_MIGRATIONS_DIR") || path.join(appDir, "db", "appwrite");
  const entitiesPath = path.join(appDir, "src", "Entities");

  const endpoint = env("APPWRITE_ENDPOINT") || env("VITE_APPWRITE_ENDPOINT");
  const projectId = env("APPWRITE_PROJECT_ID") || env("VITE_APPWRITE_PROJECT_ID");
  const apiKey = env("APPWRITE_API_KEY") || env("VITE_APPWRITE_API_KEY");
  const databaseId = env("APPWRITE_DATABASE_ID") || env("VITE_APPWRITE_DATABASE_ID") || "main";

  if (!endpoint || !projectId || !apiKey) {
    errlog("Missing APPWRITE_ENDPOINT, APPWRITE_PROJECT_ID, or APPWRITE_API_KEY");
    process.exit(1);
  }

  if (env("RUN_APPWRITE_MIGRATIONS", "true") === "false") {
    log("RUN_APPWRITE_MIGRATIONS=false, skipping");
    process.exit(0);
  }

  const client = new sdk.Client().setEndpoint(endpoint).setProject(projectId).setKey(apiKey);
  const databases = new sdk.Databases(client);

  await ensureDatabase(databases, databaseId, databaseId);
  const applied = await getAppliedMigrations(databases, databaseId);

  // 1. Collections from Entity schemas
  const entitySchemas = loadEntitySchemas(entitiesPath);
  const usersCollection = { collectionId: "users", name: "users", attributes: [
    { key: "email", type: "string", size: 255, required: true },
    { key: "full_name", type: "string", size: 255, required: false },
    { key: "role", type: "string", size: 64, required: false },
  ]};

  const collections = [usersCollection];
  for (const [name, schema] of Object.entries(entitySchemas)) {
    if (name.toLowerCase() === "user") continue;
    collections.push(buildCollectionFromEntity(name, schema));
  }

  for (const col of collections) {
    const migKey = `001_collections_${col.collectionId}`;
    if (applied.has(migKey)) {
      log(`Skipping collection ${col.collectionId} (already applied)`);
      continue;
    }

    log(`Creating collection ${col.collectionId}...`);
    try {
      await databases.createCollection(databaseId, col.collectionId, col.name);
    } catch (e) {
      if (e.code === 409) {
        log(`Collection ${col.collectionId} already exists`);
        await recordMigration(databases, databaseId, migKey);
        continue;
      }
      throw e;
    }

    await sleep(500);
    for (const attr of col.attributes) {
      await createAttribute(databases, databaseId, col.collectionId, attr);
      await sleep(300);
    }
    await waitForAttributes(databases, databaseId, col.collectionId);
    await recordMigration(databases, databaseId, migKey);
  }

  // 2. Data seeding from 002_data.json
  const dataFile = path.join(migrationsDir, "002_data.json");
  if (fs.existsSync(dataFile)) {
    const migKey = "002_data";
    if (applied.has(migKey)) {
      log("Skipping data seed (already applied)");
    } else {
      log("Seeding data...");
      const data = JSON.parse(fs.readFileSync(dataFile, "utf8"));
      for (const [collectionId, docs] of Object.entries(data)) {
        if (!Array.isArray(docs)) continue;
        try {
          await ensureLegacyDateAttributes(databases, databaseId, collectionId);
          await waitForAttributes(databases, databaseId, collectionId);
        } catch (e) {
          errlog(`Collection ${collectionId} not found, skipping seed`, e.message);
          continue;
        }
        let schemaForSeed;
        try {
          schemaForSeed = await getCollectionSchemaForSeed(databases, databaseId, collectionId);
        } catch (e) {
          errlog(`Collection ${collectionId} not found, skipping seed`, e.message);
          continue;
        }
        const { allowedKeys, attrTypes, attrArrays, attrMin, attrMax, requiredDefaults } = schemaForSeed;
        for (const doc of docs) {
          try {
            const { id, ...rest } = doc;
            const normalized = normalizeSeedDoc(rest, allowedKeys, attrTypes, attrArrays, attrMin, attrMax, requiredDefaults);
            await databases.createDocument(
              databaseId,
              collectionId,
              id || sdk.ID.unique(),
              normalized
            );
          } catch (e) {
            if (e.code === 409) continue;
            errlog(`Failed to create doc in ${collectionId}`, e.message);
          }
          await sleep(100);
        }
      }
      await recordMigration(databases, databaseId, migKey);
    }
  } else {
    log("No 002_data.json found, skipping data seed");
  }

  log("Appwrite migrations completed");
}

/**
 * Library entry point (documented in README). Reads config from process.env,
 * honoring the same APP_DIR / dry-run conventions the CLI sets up, and runs the
 * migration. Returns a promise that resolves when complete.
 */
export async function runMigrations(opts = {}) {
  if (opts.appDir) process.env.APP_DIR = opts.appDir;
  if (opts.dryRun) process.env.RUN_APPWRITE_MIGRATIONS = "false";
  return main();
}

// Re-export the pure planning core so consumers get one import surface and the
// CLI runner + any external planner stay perfectly in sync.
export {
  jsonTypeToAppwrite,
  entityToCollectionId,
  coerceValueForAttribute,
  defaultForType,
  buildPlan,
  buildCollectionFromEntity,
  buildMigrationManifest,
  planSeedDocs,
  COMMON_ATTRS,
  INTEGER_MAX,
  FLOAT_MAX,
} from "./plan.js";

// Auto-run only when invoked directly as a script (CLI), not when imported as a library.
const invokedDirectly =
  typeof process !== "undefined" &&
  Array.isArray(process.argv) &&
  process.argv[1] &&
  (process.argv[1].endsWith("migrate.js") || process.argv[1].endsWith("cli.js") || process.env.APPWRITE_MIGRATE_RUN === "1");

if (invokedDirectly) {
  main().catch((e) => {
    errlog(e.message, e);
    process.exit(1);
  });
}
