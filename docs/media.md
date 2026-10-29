# Images and video

Image and video models sit in the same picker and the same conversations as
chat models. Any upstream speaking `/v1/images` or `/v1/videos` works;
[openai-api-bridge](https://github.com/xiphux/openai-api-bridge) is a companion
project that puts ComfyUI, Venice, ImageRouter and OpenRouter behind that API.

## Generating

- **Inline generation** — images and video render in the thread, with
  job-status progress for long video renders.
- **Image-to-image follow-ups** attach the last generated image automatically;
  re-rolls are additive, never destructive.
- **Modality-aware picker.** Each image/video model shows what it takes and
  makes (`T2I`, `I2I`, `TI2V`), so the text-to-image and image-to-image listings
  of the same family are easy to tell apart. Models that only transform an
  image (upscalers, background removal, image-to-video) require an attachment
  before you can send, instead of failing after you've written a prompt.
- **Compare across models** — fan one prompt out to several image or video
  models and pick from the grid ([models](models.md#multi-model-compare)).
  Each result can be starred, re-rolled for another variation, or discarded,
  from the grid or while swiping through it in the lightbox, which shows the
  grid's own buttons until you tap **Done**.

## Aspect ratios

Models that advertise the shapes they accept get a selector beside the prompt
box, so you ask for "widescreen" or "portrait" rather than computing pixels. The
size budget stays with the model, so every offered shape fits the hardware it
was configured for and no prompt can ask for an image large enough to exhaust
it.

- Your last choice is remembered, and one pick covers a whole multi-model
  compare; a model whose own list lacks it renders the nearest shape it has.
- **Default** sends no shape at all, so each model falls back to its own — which
  in a compare means each renders at the shape it was built for.
- **Name a shape in the prompt** — "create a 9:16 poster of…" — and the picker
  follows along and says it did. Pick a shape yourself and it stands down, until
  the prose asks for something again.

## Prompt enhancement

Optional: before generating, an LLM rewrites your prompt into the format the
target model prefers. For images that's natural-language narrative, booru tags,
keyword soup, a hybrid, or structured JSON; for video, cinematic prose, a
structured shot description, or a labelled multimodal script with its own
soundscape, adding camera motion and pacing. A prompt already written in the
target model's format is left alone. It's configured per model, runs per branch
in a compare, and the original prompt is kept and shown beside the result
([configuration](configuration.md#prompt-enhancement-image_enhancement)).

## The gallery

Everything ever generated, in one place.

- **Lightbox** with swipe and arrow-key navigation; jump back to the source
  conversation, or start a new one from any image. It loads a copy sized to
  your screen (a phone gets the same copy the chat already showed), so flicking
  through a batch on mobile data stays quick; a large monitor gets the original
  once it can show more pixels than the copies hold. Download and Share always
  give the original file.
- **Stacks.** Related media — a whole conversation, or a multi-model batch
  sharing one prompt — stacks into a single card you can expand. Toggle it off
  for the flat view.
- **Search your prompts** by keyword, plus semantic matching when an embedding
  model is configured ([embeddings](web-search.md)). Results come best-match
  first; switch to **Newest** above them when the query is a name every result
  contains and relevance has nothing to rank on. **Filter** by the model that
  made it.
- **Browse by time** with sticky day or month headers and a right-edge timeline
  rail to jump to any month.
- **Favorites.** Star the ones that came out well — from the lightbox, or from
  the chat you made them in, compare grid included — and filter down to them,
  alone or combined with search and the other filters.
- **Bulk operations** via multi-select.
- **Recently deleted.** Deleted images and videos — from the gallery, a
  discarded branch or compare cell, or a deleted conversation — wait 30 days
  before they're gone, so a mis-tap can be restored.

## Storage

Generated media is pulled from the upstream as soon as it's made and stored by
GlyphStream, so it outlives whatever the upstream does with its copy. It's kept
until you delete it; uploads that never made it into a sent message are cleaned
up automatically. See [deployment](deployment.md#splitting-storage-across-volumes)
for where it lives on disk.

## Attachments

Attach images and files to a message from the picker, by drag-and-drop or by
pasting. Images are resized in the browser before upload, and iPhone HEIC photos
are converted to JPEG.

## Conversation avatars

Ask the model to describe an image of itself, then draw it with any configured
image model and make the result that conversation's face. It suits roleplay —
the character designs its own portrait — but isn't limited to it. Both steps
start from the avatar in the chat's header: **Ask for a description** puts the
request in the composer, and **Draw** opens a dialog with the description to
review, the image model, and whether to enhance the prompt.

The portrait shows at the end of the reply it was drawn from, and becomes the
avatar as soon as it's drawn. The description stays in the thread as
continuity; the image is shown but never re-sent to the model, and drawing
doesn't change the conversation, so you can draw at any time — after you've
carried on chatting, or while a reply is arriving.

Each portrait keeps every version you draw. The arrows along its bottom switch
between them, and whichever is showing is the avatar. The button on it draws
again, and the bin removes the version on show (its image goes to Recently
deleted); removing the one that's the avatar moves the avatar to the version
showing next, or back to the preset's when none is left. Pick several image
models in the dialog to compare — different models read a description very
differently: their portraits appear in the dialog as they finish, and the one
you pick becomes the avatar. The others are kept as versions. Close the dialog
before picking and you can still pick from the full-size view: tap the portrait
and swipe through the results.
