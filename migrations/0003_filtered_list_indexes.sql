CREATE INDEX `assets_favorites` ON `assets` ("sort_at" desc,"id" desc) WHERE status = 'ready' AND trashed_at IS NULL AND is_favorite = 1;
CREATE INDEX `assets_trash` ON `assets` ("sort_at" desc,"id" desc) WHERE status = 'ready' AND trashed_at IS NOT NULL;
CREATE INDEX `assets_purging` ON `assets` (`updated_at`,`id`) WHERE status = 'purging';