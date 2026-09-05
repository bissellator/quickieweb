#!/usr/bin/env bash
# Build a deployable zip for the admin Lambda.
#
#   ./infra/build-lambda.sh
#
# Produces ./infra/<deploy.functionName>.zip with:
#   - server.mjs, package.json (handler = server.handler, native Function URL)
#   - shared/render.mjs, so the Lambda renders byte-identical HTML to the local build
#   - admin/lib/, admin/ui/
#   - production node_modules including the LINUX x64 sharp binary
#
# No credentials go in the bundle. The Lambda reads S3 through its execution
# role and takes bucket names from environment variables.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUILD="$ROOT/infra/lambda-build"
FN="$(node -p "require('$ROOT/config.json').deploy.functionName || 'qw-admin'")"
ZIP="$ROOT/infra/$FN.zip"

echo "==> Clean build dir"
rm -rf "$BUILD" "$ZIP"
mkdir -p "$BUILD/lib" "$BUILD/ui" "$BUILD/../shared"

echo "==> Copy runtime files"
cp "$ROOT/admin/server.mjs"   "$BUILD/"
cp "$ROOT/admin/package.json" "$BUILD/"
cp "$ROOT/admin/lib/"*.mjs    "$BUILD/lib/"
cp "$ROOT/admin/ui/"*         "$BUILD/ui/"

# server.mjs imports ../shared/render.mjs, so the layout has to survive zipping:
# the zip root is BUILD, and shared/ must sit one level above server.mjs. Lambda
# extracts to /var/task, so we place shared/ inside and rewrite the import.
mkdir -p "$BUILD/shared"
cp "$ROOT/shared/render.mjs" "$BUILD/shared/"
# Rewrite the relative import to the flattened location.
node -e '
  const fs = require("fs");
  const p = process.argv[1];
  const s = fs.readFileSync(p, "utf8").replace(
    /from "\.\.\/shared\/render\.mjs"/,
    `from "./shared/render.mjs"`
  );
  fs.writeFileSync(p, s);
' "$BUILD/server.mjs"
grep -q './shared/render.mjs' "$BUILD/server.mjs" || {
  echo "ERROR: shared import rewrite failed -- the Lambda would crash on cold start." >&2
  exit 1
}

echo "==> Production install with the LINUX x64 sharp binary"
# The --os/--cpu/--libc flags force npm to fetch @img/sharp-linux-x64 even
# though this build usually runs on Windows.
( cd "$BUILD" && npm install --omit=dev --os=linux --cpu=x64 --libc=glibc --no-audit --no-fund )

echo "==> Verify the linux sharp binary is present"
if [ ! -d "$BUILD/node_modules/@img/sharp-linux-x64" ]; then
  echo "ERROR: @img/sharp-linux-x64 missing -- Lambda would crash on require('sharp')." >&2
  exit 1
fi

echo "==> Zip"
# Windows zip stores FAT attributes; build with Python zipfile so the entries
# are written as unix with sane modes.
BUILD="$BUILD" ZIP="$ZIP" python - <<'PY'
import os, zipfile
build = os.environ["BUILD"]
zippath = os.environ["ZIP"]
with zipfile.ZipFile(zippath, "w", zipfile.ZIP_DEFLATED) as z:
    for dirpath, _dirs, files in os.walk(build):
        for name in files:
            full = os.path.join(dirpath, name)
            rel = os.path.relpath(full, build).replace(os.sep, "/")
            zi = zipfile.ZipInfo(rel)
            zi.compress_type = zipfile.ZIP_DEFLATED
            zi.create_system = 3  # unix
            zi.external_attr = 0o644 << 16
            with open(full, "rb") as fh:
                z.writestr(zi, fh.read())
print("wrote", zippath)
PY

echo "==> Done"
ls -la "$ZIP" | awk '{printf "    %.1f MB  %s\n", $5/1048576, $9}'
