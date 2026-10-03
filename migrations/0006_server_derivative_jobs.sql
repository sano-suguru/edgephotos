CREATE TABLE `derivative_jobs` (
	`upload_id` text PRIMARY KEY NOT NULL,
	`state` text NOT NULL,
	`generation` integer DEFAULT 0 NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` text,
	`lease_until` text,
	`failure` text,
	`created_at` text NOT NULL,
	`queued_at` text,
	`completed_at` text,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`upload_id`) REFERENCES `uploads`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "derivative_jobs_state_check" CHECK("derivative_jobs"."state" IN ('awaiting_original', 'queued', 'running', 'done', 'failed', 'cancelled'))
);

CREATE INDEX `derivative_jobs_open` ON `derivative_jobs` (`state`,`updated_at`) WHERE state IN ('queued', 'running');