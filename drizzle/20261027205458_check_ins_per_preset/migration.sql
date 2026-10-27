ALTER TABLE `conversations` ADD `check_ins` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `custom_models` ADD `check_ins` integer DEFAULT false NOT NULL;--> statement-breakpoint
-- Texting presets and chats had check-ins before this was a setting; keep them.
UPDATE `custom_models` SET `check_ins` = 1 WHERE `reply_style` = 'texting';--> statement-breakpoint
UPDATE `conversations` SET `check_ins` = 1 WHERE `reply_style` = 'texting';
