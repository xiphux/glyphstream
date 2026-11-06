ALTER TABLE `conversations` ADD `starting_scene` text DEFAULT 'texting' NOT NULL;--> statement-breakpoint
ALTER TABLE `custom_models` ADD `starting_scene` text DEFAULT 'texting' NOT NULL;--> statement-breakpoint
ALTER TABLE `messages` ADD `scene` text;--> statement-breakpoint
CREATE INDEX `idx_messages_conv_scene` ON `messages` (`conversation_id`,`id`,`scene`) WHERE "messages"."scene" is not null;--> statement-breakpoint
-- The texting reply style became 'character', which moves between texting and
-- in person: every texting preset and chat carries on as one that starts (and,
-- with no marker yet, still is) texting. A chat's system prompt changes with it
-- once, so its next turn re-reads the conversation from the top; that one-time
-- cost buys a single code path instead of keeping the old style alive.
UPDATE `custom_models` SET `reply_style` = 'character' WHERE `reply_style` = 'texting';
--> statement-breakpoint
UPDATE `conversations` SET `reply_style` = 'character' WHERE `reply_style` = 'texting';
