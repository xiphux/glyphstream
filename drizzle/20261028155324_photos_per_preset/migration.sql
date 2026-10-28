ALTER TABLE `conversations` ADD `photos` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `custom_models` ADD `photos` integer DEFAULT false NOT NULL;--> statement-breakpoint
-- Photos used to come with the texting style, so every texting preset and chat
-- already sends them: switched on to match, so neither changes. (Unlike
-- check-ins, the chats too — their system prompt carries the photo instruction
-- today, and turning it off would change what they send.)
UPDATE `custom_models` SET `photos` = 1 WHERE `reply_style` = 'texting';
--> statement-breakpoint
UPDATE `conversations` SET `photos` = 1 WHERE `reply_style` = 'texting';
