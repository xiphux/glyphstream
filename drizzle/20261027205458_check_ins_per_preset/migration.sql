ALTER TABLE `conversations` ADD `check_ins` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `custom_models` ADD `check_ins` integer DEFAULT false NOT NULL;--> statement-breakpoint
-- A texting preset defaults to checking in, so existing ones are switched on to
-- match. Existing conversations are left off: a preset is copied into a chat when
-- it starts, so check-ins arrive with the next chat from the preset, rather than
-- changing the prompt of one already under way.
UPDATE `custom_models` SET `check_ins` = 1 WHERE `reply_style` = 'texting';
