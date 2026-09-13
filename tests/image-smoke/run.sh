#!/usr/bin/env bash
# Boot a built GlyphStream runtime image and prove it works, the way CI's
# "Docker image smoke" job does. Usable locally too:
#
#   docker build --target runtime -t glyphstream:smoke .
#   tests/image-smoke/run.sh glyphstream:smoke
#
# Checks, in order:
#   1. the server boots and /api/health answers (migrations applied to a fresh DB)
#   2. /login server-renders (following its redirect to /setup on a fresh DB)
#   3. smoke.mjs does real work with every runtime dependency, from the image's
#      own production node_modules (sharp's musl binary, pyodide, MCP SDK, …)
#   4. the server logged no error while doing all of the above
set -euo pipefail

image="${1:?usage: run.sh <image>}"
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
name="glyphstream-smoke-$$"
port="${SMOKE_PORT:-3900}"

cleanup() {
	echo "--- container log ---"
	docker logs "$name" 2>&1 || true
	docker rm -f "$name" >/dev/null 2>&1 || true
}
trap cleanup EXIT

# The e2e fixture config: one endpoint pointing at a mock upstream that isn't
# running here. Listing models from it fails soft, which is also worth proving.
docker run -d --name "$name" -p "127.0.0.1:${port}:3000" \
	-e AUTH_SECRET=image-smoke-secret-not-used-anywhere-32ch \
	-e GITHUB_OAUTH_CLIENT_ID=smoke \
	-e GITHUB_OAUTH_CLIENT_SECRET=smoke \
	-e SETUP_TOKEN=image-smoke-setup-token \
	-e EXTERNAL_BASE_URL="http://localhost:${port}" \
	-e CONFIG_PATH=/smoke/config.toml \
	-v "$repo/tests/e2e/fixtures/config.toml:/smoke/config.toml:ro" \
	-v "$here:/app/image-smoke:ro" \
	"$image" >/dev/null

echo "waiting for /api/health"
for _ in $(seq 1 60); do
	if curl -fsS "http://127.0.0.1:${port}/api/health" >/dev/null 2>&1; then break; fi
	if [ "$(docker inspect -f '{{.State.Running}}' "$name")" != "true" ]; then
		echo "::error::container exited before becoming healthy"
		exit 1
	fi
	sleep 1
done
curl -fsS "http://127.0.0.1:${port}/api/health"
echo

# A fresh DB has no users, so /login sends the visitor on to /setup: follow
# redirects and require the page it lands on to render.
read -r status landed < <(curl -sL -o /dev/null -w '%{http_code} %{url_effective}\n' "http://127.0.0.1:${port}/login")
echo "/login -> $status ($landed)"
if [ "$status" != "200" ]; then
	echo "::error::/login ended at $landed with $status"
	exit 1
fi

docker exec -w /app "$name" node image-smoke/smoke.mjs

# Node prints uncaught errors and console.error stacks with an "Error:" line.
# The fixture endpoint being unreachable is logged as a warning, not an error.
if docker logs "$name" 2>&1 | grep -E '(^|\s)(Error|TypeError|RangeError|ReferenceError):' >/dev/null; then
	echo "::error::the server logged an error during the smoke run"
	exit 1
fi
echo "image smoke passed"
