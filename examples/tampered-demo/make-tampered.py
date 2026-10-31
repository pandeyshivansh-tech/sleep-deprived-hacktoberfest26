#!/usr/bin/env python3
"""Builds debug-4.4.1-tampered.tgz, the input of the tampered-demo example.

It downloads the real debug@4.4.1 tarball from the public npm registry, checks it
against the registry's published sha512, and writes a modified copy next to this
script. The copy simulates a tampered release with three changes:

  1. package.json gains a "postinstall" script
  2. src/node.js gets one appended comment line
  3. lib/telemetry.min.js is added (an INERT placeholder: it does nothing)

Nothing is extracted to disk and no package code is run. Everything happens in
memory, and the output is deterministic (fixed gzip timestamp).

Usage: python3 -I examples/tampered-demo/make-tampered.py
"""
import base64
import gzip
import hashlib
import io
import json
import pathlib
import tarfile
import urllib.request

NAME, VERSION = "debug", "4.4.1"
OUT = pathlib.Path(__file__).resolve().parent / f"{NAME}-{VERSION}-tampered.tgz"


def get(url):
    with urllib.request.urlopen(url, timeout=60) as response:
        return response.read()


meta = json.loads(get(f"https://registry.npmjs.org/{NAME}/{VERSION}"))
data = get(meta["dist"]["tarball"])

algorithm, expected = meta["dist"]["integrity"].split("-", 1)
assert algorithm == "sha512", algorithm
actual = base64.b64encode(hashlib.sha512(data).digest()).decode()
assert actual == expected, "the downloaded tarball does not match the registry checksum"

source = tarfile.open(fileobj=io.BytesIO(data), mode="r:gz")
buffer = io.BytesIO()
with tarfile.open(fileobj=buffer, mode="w", format=tarfile.USTAR_FORMAT) as target:
    for member in source.getmembers():
        content = source.extractfile(member).read() if member.isfile() else None
        if member.name == "package/package.json":
            manifest = json.loads(content)
            manifest.setdefault("scripts", {})["postinstall"] = "node lib/telemetry.min.js"
            content = (json.dumps(manifest, indent=2) + "\n").encode()
        elif member.name == "package/src/node.js":
            content += b"\n// tampered: line appended for the demo\n"
        if content is not None:
            member.size = len(content)
        target.addfile(member, io.BytesIO(content) if content is not None else None)

    added = tarfile.TarInfo("package/lib/telemetry.min.js")
    payload = b"/* Inert demo file added to simulate a tampered release. It does nothing. */\n"
    added.size = len(payload)
    added.mode = 0o644
    target.addfile(added, io.BytesIO(payload))

with open(OUT, "wb") as raw:
    with gzip.GzipFile(fileobj=raw, mode="wb", mtime=0) as compressed:
        compressed.write(buffer.getvalue())
print(f"wrote {OUT.name} ({OUT.stat().st_size} bytes)")
