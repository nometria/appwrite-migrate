import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildPlan,
  buildMigrationManifest,
  planSeedDocs,
  coerceValueForAttribute,
  entityToCollectionId,
} from '../src/plan.js';

test('entityToCollectionId snake-cases names', () => {
  assert.equal(entityToCollectionId('Task'), 'task');
  assert.equal(entityToCollectionId('BlogPost'), 'blog_post');
});

test('buildPlan maps types and adds audit attrs', () => {
  const plan = buildPlan({
    Task: {
      properties: {
        title: { type: 'string', maxLength: 500 },
        priority: { type: 'integer', minimum: 1, maximum: 10 },
        tags: { type: 'array', items: { type: 'string' } },
        meta: { type: 'object' },
      },
      required: ['title'],
    },
  });
  assert.equal(plan.collections.length, 1);
  const c = plan.collections[0];
  assert.equal(c.collectionId, 'task');
  const byKey = Object.fromEntries(c.attributes.map((a) => [a.key, a]));
  assert.equal(byKey.title.type, 'string');
  assert.equal(byKey.title.required, true);
  assert.equal(byKey.priority.type, 'integer');
  assert.equal(byKey.priority.min, 1);
  assert.equal(byKey.priority.max, 10);
  assert.equal(byKey.tags.array, true);
  // audit fields present
  assert.ok(byKey.created_at && byKey.created_at.audit === true);
});

test('buildPlan skips the built-in user entity with a warning', () => {
  const plan = buildPlan({
    User: { properties: { email: { type: 'string' } } },
    Task: { properties: { title: { type: 'string' } } },
  });
  assert.equal(plan.collections.length, 1);
  assert.match(plan.warnings.join(' '), /users collection/i);
});

test('buildMigrationManifest emits ordered create operations', () => {
  const plan = buildPlan({ Task: { properties: { title: { type: 'string' } } } });
  const m = buildMigrationManifest(plan);
  assert.equal(m.tool, 'appwrite-migrate');
  assert.equal(m.operations[0].op, 'createCollection');
  assert.ok(m.operations.some((o) => o.op === 'createStringAttribute' && o.key === 'title'));
});

test('coerceValueForAttribute clamps integers and serializes objects', () => {
  assert.equal(coerceValueForAttribute(99, 'integer', false, 1, 10), 10);
  assert.equal(coerceValueForAttribute(-5, 'integer', false, 0, 100), 0);
  assert.equal(coerceValueForAttribute(2.7, 'integer', false, 0, 100), 2);
  assert.equal(coerceValueForAttribute({ x: 1 }, 'string', false), '{"x":1}');
  assert.deepEqual(coerceValueForAttribute(['a', 1], 'string', true), ['a', '1']);
  assert.equal(coerceValueForAttribute('true', 'boolean', false), true);
});

test('planSeedDocs normalizes rows: drop unknowns, clamp, fill required', () => {
  const plan = buildPlan({
    Task: {
      properties: { title: { type: 'string' }, priority: { type: 'integer', minimum: 1, maximum: 10 } },
      required: ['title'],
    },
  });
  const out = planSeedDocs(plan, {
    task: [{ id: 's1', priority: 99, nope: 'x' }],
  });
  const row = out.collections[0].rows[0];
  assert.equal(row.document.priority, 10);
  assert.deepEqual(row.dropped, ['nope']);
  assert.ok(row.clamped.some((c) => c.key === 'priority' && c.to === 10));
  assert.ok(row.filled.includes('title')); // required, missing -> filled with ""
});

test('planSeedDocs warns on unknown collection', () => {
  const plan = buildPlan({ Task: { properties: { title: { type: 'string' } } } });
  const out = planSeedDocs(plan, { ghost: [{ id: '1' }] });
  assert.equal(out.collections.length, 0);
  assert.match(out.warnings.join(' '), /unknown collection/i);
});
