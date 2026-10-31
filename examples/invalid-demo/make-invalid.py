#!/usr/bin/env python3
"""Builds the two harmless invalid archives of the invalid-demo example.

  not-a-gzip.tgz     plain text with a .tgz name (a name is not proof of a format)
  gzip-not-tar.tgz   a valid gzip stream whose content is not a tar archive

Both are tiny and inert text. Output is deterministic (fixed gzip timestamp).

Usage: python3 -I examples/invalid-demo/make-invalid.py
"""
import gzip
import pathlib

here = pathlib.Path(__file__).resolve().parent
(here / "not-a-gzip.tgz").write_bytes(b"This is plain text, not an archive. Its name ends in .tgz, but a name is not proof.\n")
(here / "gzip-not-tar.tgz").write_bytes(gzip.compress(b"A valid gzip stream whose content is not a tar archive.\n" * 20, mtime=0))
