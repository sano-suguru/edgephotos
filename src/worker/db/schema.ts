import { desc, sql } from 'drizzle-orm'
import { check, index, integer, primaryKey, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'
import { ORIGINAL_CONTENT_TYPES } from '../../contracts/schemas'

// D1 schema for types, simple queries and `drizzle-kit generate`. Applied schema changes are the
// reviewed SQL files in migrations/; this file must describe the same schema.
// Property names are the column names, so rows from explicit SQL (`SELECT a.* ...`) have the same
// shape as `$inferSelect`. Columns use plain types with no ORM-side mapping for the same reason
// (`is_favorite` stays 0/1). `wrangler` owns the `d1_migrations` table; it is not declared here.

export const assets = sqliteTable(
  'assets',
  {
    id: text().primaryKey(),
    status: text({ enum: ['ready', 'purging'] }).notNull(),
    sha256: text().notNull(),
    original_size: integer().notNull(),
    original_content_type: text({ enum: ORIGINAL_CONTENT_TYPES }).notNull(),
    original_filename: text(),
    width: integer(),
    height: integer(),
    taken_at: text(),
    sort_at: integer().notNull(),
    is_favorite: integer().notNull().default(0),
    trashed_at: text(),
    created_at: text().notNull(),
    updated_at: text().notNull(),
  },
  (t) => [
    // One asset per original byte sequence. Re-uploads converge on the existing asset.
    uniqueIndex('assets_sha256').on(t.sha256),
    index('assets_timeline').on(desc(t.sort_at), desc(t.id)),
    check('assets_status_check', sql`${t.status} IN ('ready', 'purging')`),
    check('assets_is_favorite_check', sql`${t.is_favorite} IN (0, 1)`),
  ],
)

export const uploads = sqliteTable(
  'uploads',
  {
    id: text().primaryKey(),
    // Column-level UNIQUE in 0001_initial.sql (an unnamed SQLite autoindex, not a named index). drizzle-kit
    // believes it is `uploads_asset_id_unique`: changing it generates a DROP INDEX that fails on real
    // databases, so rewrite such a migration as a table rebuild (see docs/development.md §6 baseline).
    asset_id: text().notNull().unique(),
    status: text({ enum: ['pending', 'finalized', 'duplicate'] }).notNull(),
    sha256: text().notNull(),
    original_size: integer().notNull(),
    original_content_type: text({ enum: ORIGINAL_CONTENT_TYPES }).notNull(),
    thumbnail_size: integer().notNull(),
    preview_size: integer().notNull(),
    original_filename: text(),
    width: integer(),
    height: integer(),
    taken_at: text(),
    duplicate_of: text(),
    created_at: text().notNull(),
    expires_at: text().notNull(),
    finalized_at: text(),
  },
  (t) => [
    index('uploads_status').on(t.status, t.created_at),
    check('uploads_status_check', sql`${t.status} IN ('pending', 'finalized', 'duplicate')`),
  ],
)

export const albums = sqliteTable('albums', {
  id: text().primaryKey(),
  title: text().notNull(),
  created_at: text().notNull(),
  updated_at: text().notNull(),
})

export const albumAssets = sqliteTable(
  'album_assets',
  {
    album_id: text()
      .notNull()
      .references(() => albums.id, { onDelete: 'cascade' }),
    asset_id: text()
      .notNull()
      .references(() => assets.id, { onDelete: 'cascade' }),
    added_at: text().notNull(),
  },
  (t) => [primaryKey({ columns: [t.album_id, t.asset_id] }), index('album_assets_asset').on(t.asset_id)],
)

export const shares = sqliteTable(
  'shares',
  {
    id: text().primaryKey(),
    album_id: text().notNull(),
    // SHA-256 (hex) of the share secret. The plaintext secret is never stored.
    secret_hash: text().notNull(),
    created_at: text().notNull(),
    expires_at: text().notNull(),
    revoked_at: text(),
  },
  (t) => [index('shares_album').on(t.album_id, t.created_at)],
)

export const settings = sqliteTable('settings', {
  key: text().primaryKey(),
  value: text().notNull(),
  updated_at: text().notNull(),
})

export type AssetRow = typeof assets.$inferSelect
export type UploadRow = typeof uploads.$inferSelect
export type UploadInsert = typeof uploads.$inferInsert
export type AlbumRow = typeof albums.$inferSelect
export type ShareRow = typeof shares.$inferSelect
