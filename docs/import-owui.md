# Importing from Open WebUI

GlyphStream ships a one-shot script for migrating chat history out of Open
WebUI. It walks OWUI's tree-shaped export into the matching GlyphStream
schema, splits reasoning blocks (`<details type="reasoning">`) into
structured parts, and renders assistant markdown to HTML so the UI shows
formatted output immediately.

```bash
# 1. In OWUI: Settings → "Export All Chats" → save the JSON file.

# 2. Drop the export onto the host alongside docker-compose.yml.
mkdir -p /srv/glyphstream/imports
cp ~/Downloads/owui-export.json /srv/glyphstream/imports/

# 3. Find your GlyphStream user id. The row exists once you've completed
#    the /setup wizard — any sign-in method (GitHub or passkey-only) works.
docker compose exec glyphstream sqlite3 /app/data/glyphstream.db \
  "SELECT id, display_name FROM users;"

# 4. Dry-run first to see counts without writing.
docker compose exec glyphstream node /app/build/scripts/import-owui.js \
  /app/imports/owui-export.json --user-id <your-uuid> --dry-run

# 5. Real run.
docker compose exec glyphstream node /app/build/scripts/import-owui.js \
  /app/imports/owui-export.json --user-id <your-uuid>
```

For local dev (no Docker):
`pnpm import:owui <export.json> --user-id <uuid>`.

## Caveats

- Imported conversations get a synthetic `endpoint_id = 'imported-owui'` —
  full history is preserved and viewable, but sending a _new_ message in an
  imported conversation will fail with "endpoint not configured" until a
  future "reassign endpoint" UI lands.
- OWUI's export references images by URL to its own file API; once OWUI is
  shut down those URLs 404. The script rewrites image references to an
  `_[image unavailable]_` placeholder so the surrounding text still reads
  coherently.
- Re-running the script will create duplicates (no idempotency check yet).
  To re-import cleanly, wipe previous imports first:
  `sqlite3 /app/data/glyphstream.db "DELETE FROM conversations WHERE endpoint_id = 'imported-owui';"`
