import { applyD1Migrations } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'

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
