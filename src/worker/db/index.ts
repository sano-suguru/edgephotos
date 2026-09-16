import { type DrizzleD1Database, drizzle } from 'drizzle-orm/d1'

// Typed handle over the D1 binding. No relational query API is registered: queries are either
// the query builder for simple CRUD or explicit SQL through `sql`.
export type Db = DrizzleD1Database

export function createDb(d1: D1Database): Db {
  return drizzle(d1)
}
