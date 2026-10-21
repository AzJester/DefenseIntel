CREATE TABLE `brief_snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`created` text NOT NULL,
	`data` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `event_alerts` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`severity` text NOT NULL,
	`reason` text NOT NULL,
	`created` text NOT NULL,
	`acknowledged` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `event_clusters` (
	`id` text PRIMARY KEY NOT NULL,
	`updated` text NOT NULL,
	`data` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `evidence_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`record_id` text NOT NULL,
	`fetched_at` text NOT NULL,
	`data` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `official_awards` (
	`id` text PRIMARY KEY NOT NULL,
	`company` text NOT NULL,
	`published` text NOT NULL,
	`fetched_at` text NOT NULL,
	`data` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `record_provenance` (
	`record_id` text PRIMARY KEY NOT NULL,
	`first_seen` text NOT NULL,
	`fetched_at` text NOT NULL,
	`hash` text NOT NULL
);
