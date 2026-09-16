import { applyD1Migrations } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { Column, is, SQL, StringChunk } from 'drizzle-orm'
import { getTableConfig, SQLiteTable } from 'drizzle-orm/sqlite-core'
import { describe, expect, it } from 'vitest'
import * as schema from '../../src/worker/db/schema'

const tables: SQLiteTable[] = Object.values(schema).filter((v) => is(v, SQLiteTable))

async function all<T>(query: string): Promise<T[]> {
  return (await env.DB.prepare(query).all<T>()).results
}

// What the migrated database looks like, in a shape comparable with the Drizzle schema.
async function actualTable(name: string) {
  const columns = await all<{ name: string; type: string; notnull: number; dflt_value: string | null; pk: number }>(
    `SELECT name, type, "notnull", dflt_value, pk FROM pragma_table_info('${name}')`,
  )
  const indexes = await all<{ name: string; unique: number; origin: string }>(
    `SELECT name, "unique", origin FROM pragma_index_list('${name}')`,
  )
  const indexColumns = async (index: string) =>
    (
      await all<{ name: string; desc: number }>(`SELECT name, desc FROM pragma_index_xinfo('${index}') WHERE key = 1`)
    ).map((c) => `${c.name}${c.desc ? ' desc' : ''}`)
  const foreignKeys = await all<{ table: string; from: string; to: string; on_delete: string }>(
    `SELECT "table", "from", "to", on_delete FROM pragma_foreign_key_list('${name}')`,
  )
  const sql = (await env.DB.prepare('SELECT sql FROM sqlite_master WHERE name = ?')
    .bind(name)
    .first<{ sql: string }>())!.sql
  const singlePk = columns.filter((c) => c.pk > 0).length === 1
  return {
    columns: columns.map((c) => ({
      name: c.name,
      type: c.type.toLowerCase(),
      // Legacy SQLite: a non-INTEGER PRIMARY KEY without NOT NULL accepts NULL. 0001_initial.sql relies on the
      // app always supplying ids; Drizzle always declares such keys NOT NULL, so single-column keys skip this check.
      notNull: c.pk && singlePk ? 'pk' : c.notnull === 1,
      default: c.dflt_value,
      pk: c.pk > 0,
    })),
    namedIndexes: await Promise.all(
      indexes
        .filter((i) => i.origin === 'c')
        .map(async (i) => ({ name: i.name, unique: i.unique === 1, columns: await indexColumns(i.name) })),
    ),
    // Column-level UNIQUE constraints are unnamed autoindexes in SQL; compare them by column only.
    uniqueColumns: (
      await Promise.all(
        indexes.filter((i) => i.origin === 'u').map(async (i) => (await indexColumns(i.name)).join(',')),
      )
    ).sort(),
    foreignKeys: foreignKeys
      .map((f) => ({ from: f.from, table: f.table, to: f.to, onDelete: f.on_delete }))
      .sort((a, b) => a.from.localeCompare(b.from)),
    checks: sql.match(/\bCHECK\s*\(/gi)?.length ?? 0,
  }
}

function indexColumn(c: unknown): string {
  if (is(c, Column)) return c.name
  if (is(c, SQL)) {
    const column = c.queryChunks.find((q) => is(q, Column)) as Column
    const desc = c.queryChunks.some((q) => is(q, StringChunk) && q.value.join('').trim().toLowerCase() === 'desc')
    return `${column.name}${desc ? ' desc' : ''}`
  }
  throw new Error('unsupported index column')
}

function expectedTable(table: SQLiteTable) {
  const config = getTableConfig(table)
  const compositePk = new Set(config.primaryKeys.flatMap((pk) => pk.columns.map((c) => c.name)))
  return {
    columns: config.columns.map((c) => {
      const pk = c.primary || compositePk.has(c.name)
      return {
        name: c.name,
        type: c.getSQLType().toLowerCase(),
        notNull: c.primary ? 'pk' : c.notNull,
        default: c.hasDefault && c.default !== undefined ? String(c.default) : null,
        pk,
      }
    }),
    namedIndexes: config.indexes.map((i) => ({
      name: i.config.name,
      unique: i.config.unique,
      columns: i.config.columns.map(indexColumn),
    })),
    uniqueColumns: config.columns
      .filter((c) => c.isUnique)
      .map((c) => c.name)
      .sort(),
    foreignKeys: config.foreignKeys
      .map((f) => {
        const ref = f.reference()
        return {
          from: ref.columns[0].name,
          table: getTableConfig(ref.foreignTable).name,
          to: ref.foreignColumns[0].name,
          onDelete: (f.onDelete ?? 'no action').toUpperCase(),
        }
      })
      .sort((a, b) => a.from.localeCompare(b.from)),
    checks: config.checks.length,
  }
}

const sortByName = <T extends { name: string }>(items: T[]) => [...items].sort((a, b) => a.name.localeCompare(b.name))

describe('D1 migrations', () => {
  it('creates the expected tables', async () => {
    const { results } = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name",
    ).all<{ name: string }>()
    expect(results.map((r) => r.name)).toEqual(
      expect.arrayContaining(['album_assets', 'albums', 'assets', 'd1_migrations', 'settings', 'shares', 'uploads']),
    )
  })

  it('is recorded and re-applying is a no-op', async () => {
    const before = await env.DB.prepare('SELECT COUNT(*) AS n FROM d1_migrations').first<{ n: number }>()
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS)
    const after = await env.DB.prepare('SELECT COUNT(*) AS n FROM d1_migrations').first<{ n: number }>()
    expect(after?.n).toBe(before?.n)
    expect(after?.n).toBe(env.TEST_MIGRATIONS.length)
  })

  it('matches the Drizzle schema used for types, queries and generated migrations', async () => {
    const names = await all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name != 'd1_migrations' ORDER BY name",
    )
    expect(names.map((t) => t.name)).toEqual(tables.map((t) => getTableConfig(t).name).sort())
    for (const table of tables) {
      const name = getTableConfig(table).name
      const expected = expectedTable(table)
      const actual = await actualTable(name)
      expect({ name, ...actual, namedIndexes: sortByName(actual.namedIndexes) }).toEqual({
        name,
        ...expected,
        namedIndexes: sortByName(expected.namedIndexes),
      })
    }
  })

  it('stores no plaintext share secret column', async () => {
    const { results } = await env.DB.prepare("SELECT name FROM pragma_table_info('shares')").all<{ name: string }>()
    expect(results.map((r) => r.name).sort()).toEqual(
      ['album_id', 'created_at', 'expires_at', 'id', 'revoked_at', 'secret_hash'].sort(),
    )
  })

  it('enforces one asset per original SHA-256 and valid states', async () => {
    const insert = (id: string, status = 'ready') =>
      env.DB.prepare(
        `INSERT INTO assets (id, status, sha256, original_size, original_content_type, sort_at, created_at, updated_at)
         VALUES (?, ?, 'abc', 1, 'image/jpeg', 0, 'x', 'x')`,
      )
        .bind(id, status)
        .run()
    await insert('m-1')
    await expect(insert('m-2')).rejects.toThrow(/UNIQUE/)
    await expect(
      env.DB.prepare(
        `INSERT INTO assets (id, status, sha256, original_size, original_content_type, sort_at, created_at, updated_at)
         VALUES ('m-3', 'bogus', 'def', 1, 'image/jpeg', 0, 'x', 'x')`,
      ).run(),
    ).rejects.toThrow(/CHECK/)
    await env.DB.prepare("DELETE FROM assets WHERE id = 'm-1'").run()
  })
})
