# Prompt snippets

A prompt snippet is a reusable **piece** of a prompt — not a whole prompt. A
visual style you reach for constantly, a tone instruction, a recurring
character in a story. You insert one at the cursor and then type the rest of
the message around it.

The classic case is image generation, where the style block is long, fiddly,
and identical every time:

```
Style: <a 60-word description of the look you want>

Description: a cat sitting on a windowsill at dusk
```

Only the second half changes. Snippets let you keep the first half in a
library and pull it in with a couple of keystrokes.

Snippets take no configuration — there's nothing to add to `config.toml` or
`.env`. Manage them at **Settings → Prompt snippets**.

## Using them

Type `;` in the message box, then part of the snippet's name:

```
Style: ;tori
```

A menu appears; pick with `↑`/`↓` and `Enter` (or `Tab`), or click. The
snippet's text replaces `;tori` right where the cursor is, and you keep typing.

- **Matching** is case-insensitive and matches anywhere in the name, so `;tori`
  finds "Akira Toriyama Style". Tags match too.
- **A bare `;`** lists everything.
- **`Esc`** closes the menu without inserting.
- **Ctrl-Z (⌘Z)** removes a whole inserted snippet in one step, so a wrong pick
  costs one keystroke to undo.
- **Stack as many as you like** — style, then camera, then palette, then your
  own description. This is the main thing snippets do that a custom model
  can't.

Snippets work in the main composer, on the new-chat screen, and in the inline
message editor.

An ordinary `;` in your writing never opens the menu — it only triggers at the
start of a word, so `const x = 1;` and `foo; bar` are left alone.

### Snippets vs. custom models

Both save you retyping, but they work at different levels:

|                | Custom model                            | Prompt snippet                  |
| -------------- | --------------------------------------- | ------------------------------- |
| What it is     | Base model + system prompt + parameters | A piece of text                 |
| Chosen         | Before you type, from the model picker  | While you type, at the cursor   |
| How many apply | One per conversation                    | As many as you want per message |
| Good for       | "This assistant behaves like X"         | "Paste this paragraph in again" |

If you'd end up with dozens of near-identical custom models that differ only by
a paragraph of prompt text, you want snippets.

## Modality filtering

Each snippet can be tagged with the kinds of model it applies to — `chat`,
`image`, `video`. The autocomplete then only offers the ones that fit whatever
model is active, so your 60 image styles don't clutter the menu in a text chat.

**A snippet with no kinds is generic** and offered everywhere. That's usually
what you want for tone or formatting instructions.

The filter never hides everything: if it would leave the menu empty but
something does match what you typed, those matches are shown anyway. A
mistagged snippet is always still reachable.

## Import and export

The whole library is one Markdown file. Paste it into the import box or upload
a `.md` at **Settings → Prompt snippets**; **Export** downloads the same
format, so a round-trip is lossless and you can hand-edit a large library in a
real editor.

### Format

Each snippet is a `##` heading, optional metadata lines, a blank line, then the
body:

<!-- prettier-ignore -->
```markdown
# My snippet library

Anything before the first heading is ignored, so notes to yourself are fine.

## Akira Toriyama Style
kinds: image, video
tags: anime, character

clean and highly readable linework, appealing character-focused design
language, expressive forms, dynamic silhouettes, polished cel-style
rendering, and a playful yet technically disciplined aesthetic.

## Terse Tone

No preamble, no summary. Answer the question directly.
```

Rules:

- **`## Name`** starts a snippet. The heading text is its name: one line, not
  blank, unique within your library, 200 characters or fewer.
- **`kinds:`** and **`tags:`** are comma-separated and optional. They must sit
  **directly under the heading, with no blank line between** — a blank line
  ends the metadata block, and everything after it is body.
- Everything after that blank line, up to the next `##`, is the body —
  including blank lines and paragraphs. Body is required.
- Only `kinds:` and `tags:` are metadata. Any other `Word: value` line is body
  text, so a style that opens with `Style: a clean look` is safe.
- A **tag** may not contain a comma (commas separate tags) or a line break.
  Anything else is fine — `sci-fi`, `line art`, `80s` all work.
- A **line break** means any of LF, CR, U+2028 or U+2029. The last two matter
  more than they look: U+2028 is the soft line break (Shift+Enter) that word
  processors and PDFs emit, so it can ride along invisibly in text pasted from
  one. It ends a line here just like a newline does, and names and tags reject
  it for the same reason they reject a newline.
- Size limits, the same ones the editor enforces: name 200 characters, body
  8,000, at most 20 tags of 60 characters each.

Anything that doesn't conform is reported, never guessed at. One bad entry
never fails the rest of the import:

| Situation                           | Result                                  |
| ----------------------------------- | --------------------------------------- |
| Unknown value in `kinds:`           | Warned, that value ignored              |
| Heading with no body, or no name    | Skipped, reported                       |
| Name already in your library        | Skipped, unless **Overwrite** is ticked |
| Over a size limit                   | Skipped, reported                       |
| `kinds:`/`tags:` after a blank line | Warned — read as body text (see below)  |

The import result tells you how many were imported, updated and skipped, and
surfaces any warnings.

### The blank line after a heading matters

This is the one rule that bites, because a blank line after a Markdown heading
is such a natural thing to type:

<!-- prettier-ignore -->
```markdown
## Akira Toriyama Style

kinds: image, video
```

That reads `kinds: image, video` as the first line of the **body**, not as
metadata — the snippet ends up generic, with a stray line of text in it. The
import warns you when it sees this.

It works this way deliberately. A body's first line is genuinely allowed to be
a tag list (`tags: 8k, photorealistic` is a perfectly good image-prompt
fragment), so treating a post-blank-line `tags:` as metadata would silently
delete real content. Warning is the safe direction; if you meant it as body,
prefix it with `\` and the warning goes away.

### Bodies that look like the format

A body can legitimately contain lines that look like this format's own syntax —
a prompt template with its own `## Section` headings, or a fragment whose first
line is `tags: 8k, photorealistic`. Export escapes those with a leading
backslash so they survive re-import:

<!-- prettier-ignore -->
```markdown
## Structured Brief
kinds: chat

Reply using exactly these sections:

\## Summary
\## Details
```

Export escapes any body line starting with a Markdown heading (`#` through
`######`) or with `kinds:`/`tags:`. Only `## ` could actually be misread as
structure — the rest are escaped so the exported file still reads correctly as
Markdown in an editor or viewer.

You don't need to add the backslashes yourself when hand-authoring — but if you
write such a line and want it kept as text, escape it this way. The backslash is
removed on import, so what you get back is the literal line.

By default a snippet whose name already exists is **skipped** and reported.
Tick **Overwrite snippets with the same name** to replace their contents
instead — that makes re-importing an edited export the natural way to bulk-edit
your library.
