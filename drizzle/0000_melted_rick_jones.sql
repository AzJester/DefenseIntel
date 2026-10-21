CREATE TABLE `alerts` (
	`id` text PRIMARY KEY NOT NULL,
	`record_id` text NOT NULL,
	`severity` text NOT NULL,
	`reason` text NOT NULL,
	`created` text NOT NULL,
	`acknowledged` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `competitors` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`aliases` text NOT NULL,
	`website` text NOT NULL,
	`profile` text NOT NULL,
	`active` integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `intelligence` (
	`id` text PRIMARY KEY NOT NULL,
	`company` text NOT NULL,
	`category` text NOT NULL,
	`title` text NOT NULL,
	`summary` text NOT NULL,
	`assessment` text NOT NULL,
	`url` text NOT NULL,
	`published` text NOT NULL,
	`reviewed` text NOT NULL,
	`priority` text NOT NULL,
	`source` text NOT NULL,
	`verification` text NOT NULL,
	`origin` text NOT NULL,
	`created` text NOT NULL,
	`fingerprint` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `metadata` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
