ALTER TABLE `conversations` ADD `reply_style` text DEFAULT 'standard' NOT NULL;--> statement-breakpoint
ALTER TABLE `custom_models` ADD `reply_style` text DEFAULT 'standard' NOT NULL;