"""Zip the Lambda build directory with unix file modes.

    python infra/zip-lambda.py <build-dir> <output-zip>

Called by infra/build-lambda.mjs. This is a real file rather than a heredoc
because heredocs are unreliable in the shells available on the Windows box this
is usually built from.

Windows' own zip tooling stores FAT attributes, which Lambda unpacks with modes
it cannot read. zipfile lets us write the entries as unix with sane permissions.
"""
import os
import sys
import zipfile

if len(sys.argv) != 3:
    sys.exit("usage: zip-lambda.py <build-dir> <output-zip>")

build, zippath = sys.argv[1], sys.argv[2]

if not os.path.isdir(build):
    sys.exit("build dir does not exist: %s" % build)

count = 0
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
            count += 1

if count == 0:
    sys.exit("refusing to write an empty zip")

print("wrote %s (%d entries, %.1f MB)" % (
    zippath, count, os.path.getsize(zippath) / 1048576.0))
