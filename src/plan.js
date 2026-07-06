/**
 * appwrite-migrate · pure planning core
 *
 * Side-effect-free building blocks shared by the CLI runner (migrate.js) and any
 * external consumer (e.g. the Nometria web planner). Importing this module never
 * touches Appwrite, the filesystem, or process.env — it only transforms plain
 * objects, so the web app and the OSS CLI compute IDENTICAL plans.
 *
 * Exports:
 *   entityToCollectionId(name)          -> snake_case collection id
 *   keyToSnake(key)                     -> snake_case attribute key
 *   jsonTypeToAppwrite(prop, key)       -> { type, size?, min?, max?, array? }
 *   buildCollectionFromEntity(name, s)  -> { collectionId, name, attributes }
 *   buildPlan(schemaMap)                -> { collections, warnings }
 *   buildMigrationManifest(plan)        -> ordered { operations } JSON
 *   coerceValueForAttribute(...)        -> value coerced + clamped to an attr
 *   planSeedDocs(plan, seedData)        -> normalized seed rows + per-row diags
 */

export const INTEGER_MAX = 9007199254740991; // Number.MAX_SAFE_INTEGER
export const FLOAT_MAX = 1.7976931348623157e308;

/** COMMON_ATTRS appwrite-migrate adds to every entity collection. */
export const COMMON_ATTRS = [
  { key: "created_by_id", type: "string", size: 255, required: false, audit: true },
  { key: "created_by", type: "string", size: 255, required: false, audit: true },
  { key: "is_sample", type: "boolean", required: false, audit: true },
  { key: "created_date", type: "string", size: 64, required: false, audit: true },
  { key: "updated_date", type: "string", size: 64, required: false, audit: true },
  { key: "created_at", type: "string", size: 64, required: false, audit: true },
  { key: "updated_at", type: "string", size: 64, required: false, audit: true },
];

/** Entity name -> collection ID (snake_case). */
export function entityToCollectionId(name) {
  return name
    .replace(/([A-Z])/g, "_$1")
    .toLowerCase()
    .replace(/^_/, "");
}

/** Attribute key -> snake_case. */
export function keyToSnake(key) {
  return key
    .replace(/([A-Z])/g, "_$1")
    .toLowerCase()
    .replace(/^_/, "");
}

/**
 * Map a JSON Schema property to an Appwrite attribute creation spec.
 * Arrays -> native string[]; objects -> JSON string; numbers carry min/max.
 */
export function jsonTypeToAppwrite(prop, _key) {
  const t = prop.type;
  const enumVal = prop.enum;
  const format = prop.format;
  if (enumVal) return { type: "string", size: 255 };
  if (t === "string") {
    const size = typeof prop.maxLength === "number" ? prop.maxLength : format === "date" ? 32 : 65535;
    return { type: "string", size };
  }
  if (t === "number" || t === "integer") {
    const isInt = t === "integer";
    const out = { type: isInt ? "integer" : "float" };
    const min = prop.minimum != null ? Number(prop.minimum) : 0;
    const max = prop.maximum != null ? Number(prop.maximum) : isInt ? INTEGER_MAX : FLOAT_MAX;
    out.min = isInt ? Math.floor(min) : min;
    out.max = isInt ? Math.floor(max) : max;
    return out;
  }
  if (t === "boolean") return { type: "boolean" };
  if (t === "array") return { type: "string", size: 255, array: true };
  if (t === "object") return { type: "string", size: 65535 };
  return { type: "string", size: 255 };
}

/** Build a collection definition (audit attrs + mapped props) from an Entity schema. */
export function buildCollectionFromEntity(entityName, schema) {
  const collectionId = entityToCollectionId(entityName);
  const attributes = COMMON_ATTRS.map((a) => ({ ...a }));
  const props = (schema && schema.properties) || {};
  const required = new Set(Array.isArray(schema && schema.required) ? schema.required : []);
  const seen = new Set(COMMON_ATTRS.map((a) => a.key));

  for (const [key, val] of Object.entries(props)) {
    const keySnake = keyToSnake(key);
    if (seen.has(keySnake)) continue;
    seen.add(keySnake);
    const appwriteType = jsonTypeToAppwrite(val || {}, key);
    attributes.push({
      key: keySnake,
      required: required.has(key),
      audit: false,
      ...appwriteType,
      ...(val && val.default !== undefined ? { default: val.default } : {}),
    });
  }

  return { collectionId, name: entityName, attributes };
}

/**
 * Build a full plan from a map of { EntityName: schema }.
 * Returns { collections, warnings }. A bare single schema ({ properties }) is
 * accepted and treated as one "Entity". `user` maps to the built-in collection.
 */
export function buildPlan(schemaMap) {
  if (schemaMap == null || typeof schemaMap !== "object" || Array.isArray(schemaMap)) {
    throw new Error("Top-level JSON must be an object of { EntityName: schema }.");
  }

  const warnings = [];
  let entries;
  if (Object.prototype.hasOwnProperty.call(schemaMap, "properties")) {
    entries = [["Entity", schemaMap]];
  } else {
    entries = Object.entries(schemaMap);
  }

  const collections = [];
  for (const [entity, schemaRaw] of entries) {
    if (entity.toLowerCase() === "user") {
      warnings.push(`"${entity}" maps to the built-in users collection; skipped from the entity plan.`);
      continue;
    }
    if (schemaRaw == null || typeof schemaRaw !== "object") {
      warnings.push(`Entity "${entity}" is not an object; skipped.`);
      continue;
    }
    const props = schemaRaw.properties;
    if (props == null || typeof props !== "object" || Array.isArray(props)) {
      warnings.push(`Entity "${entity}" has no "properties" object; skipped.`);
      continue;
    }
    collections.push(buildCollectionFromEntity(entity, schemaRaw));
  }

  if (collections.length === 0) throw new Error("No valid entity schemas found.");
  return { collections, warnings };
}

/** Map an attribute kind to its Appwrite create-operation name. */
function opForAttr(type) {
  if (type === "string") return "createStringAttribute";
  if (type === "integer") return "createIntegerAttribute";
  if (type === "float") return "createFloatAttribute";
  if (type === "boolean") return "createBooleanAttribute";
  return "createStringAttribute";
}

/** Portable manifest: the ordered create operations a runner would execute. */
export function buildMigrationManifest(plan) {
  return {
    tool: "appwrite-migrate",
    generatedAt: new Date().toISOString(),
    operations: plan.collections.flatMap((c) => [
      { op: "createCollection", collectionId: c.collectionId, name: c.name || c.entity },
      ...c.attributes.map((a) => ({
        op: opForAttr(a.type),
        collectionId: c.collectionId,
        key: a.key,
        required: !!a.required,
        ...(a.type === "string" ? { size: a.size, array: !!a.array } : {}),
        ...(a.type === "integer" || a.type === "float" ? { min: a.min, max: a.max } : {}),
      })),
    ]),
  };
}

/** Default value for a missing required attribute by type. */
export function defaultForType(type) {
  const t = (type || "").toLowerCase();
  if (t === "integer" || t === "float") return 0;
  if (t === "boolean") return false;
  return "";
}

/**
 * Coerce a value to match an Appwrite attribute type.
 * - native string[] -> array of strings; object -> JSON string
 * - integer/float -> Number, floored for ints, clamped to [min,max]
 * - boolean -> truthy/"true"/"1"
 */
export function coerceValueForAttribute(value, attrType, isArray, minVal, maxVal) {
  const t = (attrType || "string").toLowerCase();
  if (value === undefined || value === null) return value;
  if (t === "string" && isArray) {
    if (Array.isArray(value)) return value.map((v) => (typeof v === "string" ? v : String(v)));
    if (typeof value === "object") return JSON.stringify(value);
    return [String(value)];
  }
  if (t === "string") {
    if (Array.isArray(value) || typeof value === "object") return JSON.stringify(value);
    return typeof value === "string" ? value : String(value);
  }
  const isInt = t === "integer" || t === "int";
  if (isInt || t === "float") {
    let n;
    if (typeof value === "number" && !Number.isNaN(value)) n = value;
    else {
      n = Number(value);
      n = Number.isNaN(n) ? 0 : isInt ? Math.floor(n) : n;
    }
    if (minVal != null && n < minVal) n = minVal;
    if (maxVal != null && n > maxVal) n = maxVal;
    if (isInt) return parseInt(String(Math.floor(Number(n))), 10);
    return n;
  }
  if (t === "boolean") {
    if (typeof value === "boolean") return value;
    if (typeof value === "string") return value.toLowerCase() === "true" || value === "1";
    return Boolean(value);
  }
  return value;
}

/**
 * Build a lookup of attribute metadata for a planned collection, used to
 * normalize seed documents the same way the live runner does.
 */
export function attrIndexForCollection(collection) {
  const allowedKeys = new Set();
  const attrTypes = {};
  const attrArrays = {};
  const attrMin = {};
  const attrMax = {};
  const requiredDefaults = {};
  for (const a of collection.attributes) {
    allowedKeys.add(a.key);
    const t = (a.type || "string").toLowerCase();
    attrTypes[a.key] = t;
    attrArrays[a.key] = !!a.array;
    if (a.min != null) attrMin[a.key] = t === "integer" ? Math.floor(Number(a.min)) : Number(a.min);
    if (a.max != null) attrMax[a.key] = t === "integer" ? Math.floor(Number(a.max)) : Number(a.max);
    if (a.required) {
      const def = defaultForType(t);
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
 * Plan seed-data insertion for a built plan against a parsed 002_data.json map
 * ({ collectionId: [docs] }). Pure: returns the normalized documents that WOULD
 * be inserted, plus per-collection diagnostics (dropped keys, clamped numbers,
 * filled required defaults, unknown collections). No network, no writes.
 */
export function planSeedDocs(plan, seedData) {
  if (seedData == null || typeof seedData !== "object" || Array.isArray(seedData)) {
    throw new Error("Seed data must be an object of { collectionId: [documents] }.");
  }
  const byId = new Map(plan.collections.map((c) => [c.collectionId, c]));
  const collections = [];
  const warnings = [];

  for (const [collectionId, docs] of Object.entries(seedData)) {
    const collection = byId.get(collectionId);
    if (!collection) {
      warnings.push(`Seed targets unknown collection "${collectionId}" (no matching entity in the plan); skipped.`);
      continue;
    }
    if (!Array.isArray(docs)) {
      warnings.push(`Seed for "${collectionId}" is not an array; skipped.`);
      continue;
    }
    const idx = attrIndexForCollection(collection);
    const rows = [];
    for (const doc of docs) {
      if (doc == null || typeof doc !== "object" || Array.isArray(doc)) {
        rows.push({ id: null, document: {}, dropped: [], clamped: [], filled: [], skipped: true });
        continue;
      }
      const { id, ...rest } = doc;
      const out = {};
      const dropped = [];
      const clamped = [];
      const filled = [];
      for (const [key, value] of Object.entries(rest)) {
        if (!idx.allowedKeys.has(key)) {
          dropped.push(key);
          continue;
        }
        const before = value;
        const coerced = coerceValueForAttribute(value, idx.attrTypes[key], idx.attrArrays[key], idx.attrMin[key], idx.attrMax[key]);
        const t = idx.attrTypes[key];
        if ((t === "integer" || t === "float") && typeof before === "number" && typeof coerced === "number" && coerced !== before) {
          clamped.push({ key, from: before, to: coerced });
        }
        out[key] = coerced;
      }
      for (const [key, def] of Object.entries(idx.requiredDefaults)) {
        if (out[key] === undefined || out[key] === null || out[key] === "") {
          out[key] = def;
          filled.push(key);
        }
      }
      rows.push({ id: id != null ? id : null, document: out, dropped, clamped, filled, skipped: false });
    }
    collections.push({ collectionId, name: collection.name, rows });
  }

  return { collections, warnings };
}
