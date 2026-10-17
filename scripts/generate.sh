#!/usr/bin/env bash
# Regenerates src/gen/ from the public Permio protos.
#
#   scripts/generate.sh                 # uses ../proto
#   PERMIO_PROTO_DIR=/path/to/proto scripts/generate.sh
#
# src/gen/ is fully owned by this script: never edit it by hand.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROTO_DIR="$(cd "${PERMIO_PROTO_DIR:-$ROOT/../proto}" && pwd)"
BUF="${BUF:-buf}"
if ! command -v "$BUF" >/dev/null 2>&1 && [ -x "$HOME/.local/bin/buf" ]; then
  BUF="$HOME/.local/bin/buf"
fi

if [ ! -f "$PROTO_DIR/proto/permissions/v1/permissions.proto" ]; then
  echo "proto repo not found at $PROTO_DIR (set PERMIO_PROTO_DIR)" >&2
  exit 1
fi

cd "$ROOT"
# Passing the input on the command line overrides the template's input, so the
# public-file allowlist is repeated here as --path flags (buf resolves them
# relative to the working directory, hence the absolute paths).
"$BUF" generate "$PROTO_DIR" --template buf.gen.yaml \
  --path "$PROTO_DIR/proto/permissions/v1/permissions.proto" \
  --path "$PROTO_DIR/proto/organisation/v1/organisation.proto" \
  --path "$PROTO_DIR/proto/pagination/v1/pagination.proto"

if find src/gen -name '*internal*' | grep -q .; then
  echo "internal protos leaked into src/gen; refusing to continue" >&2
  exit 1
fi
echo "generated $(find src/gen -name '*.ts' | wc -l) files into src/gen"
