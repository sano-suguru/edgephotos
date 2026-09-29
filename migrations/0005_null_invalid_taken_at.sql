-- A capture time the API once accepted by its spelling alone, but that no clock shows (month 13, February 30,
-- hour 24, an offset beyond ±14:00), is forgotten: the photo is placed by its upload time, as when EXIF has no
-- date. Such a value would otherwise keep the whole library out of a backup that verifies. The round trip through
-- strftime catches impossible dates (SQLite rolls February 30 over to March 1); hour 24 it keeps, so that is
-- checked on its own. sort_at is recomputed from created_at (always `toISOString()` output) the way
-- sortAtFor does when there is no capture time.
UPDATE `assets`
SET `taken_at` = NULL,
  `sort_at` = CAST(strftime('%s', `created_at`) AS INTEGER) * 1000 + CAST(substr(`created_at`, 21, 3) AS INTEGER)
WHERE `taken_at` IS NOT NULL AND (
  strftime('%Y-%m-%dT%H:%M:%S', substr(`taken_at`, 1, 19)) IS NOT substr(`taken_at`, 1, 19)
  OR substr(`taken_at`, 12, 2) > '23'
  OR (substr(`taken_at`, -6, 1) IN ('+', '-') AND (substr(`taken_at`, -5) > '14:00' OR substr(`taken_at`, -2) > '59'))
);
UPDATE `uploads`
SET `taken_at` = NULL
WHERE `taken_at` IS NOT NULL AND (
  strftime('%Y-%m-%dT%H:%M:%S', substr(`taken_at`, 1, 19)) IS NOT substr(`taken_at`, 1, 19)
  OR substr(`taken_at`, 12, 2) > '23'
  OR (substr(`taken_at`, -6, 1) IN ('+', '-') AND (substr(`taken_at`, -5) > '14:00' OR substr(`taken_at`, -2) > '59'))
);
