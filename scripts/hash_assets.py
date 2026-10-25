#!/usr/bin/env python3
"""Fingerprint static assets for cache busting (run at Docker build time).

    python3 hash_assets.py <web root>

- Renames css/app.css, js/*.js to name.<hash>.ext (hash of the final content).
- Rewrites references in index.html, the JS module imports and sw.js.
- Replaces __BUILD__ (sw.js cache version, app build id) with a build id
  derived from all app files, so each deploy installs a fresh service worker.

Local development (start.sh) serves the unhashed files with no-cache headers.
"""

import hashlib
import os
import re
import sys

# Leaf modules first: a file is hashed only after its own imports were rewritten.
ASSETS = ["js/i18n.js", "js/data.js", "js/app.js", "css/app.css"]
REFERRERS = ["index.html", "sw.js"]


def read(root, rel):
    with open(os.path.join(root, rel), encoding="utf-8") as f:
        return f.read()


def write(root, rel, text):
    with open(os.path.join(root, rel), "w", encoding="utf-8") as f:
        f.write(text)


def build_id(root):
    h = hashlib.sha1()
    for rel in sorted(ASSETS + REFERRERS + ["404.html", "manifest.webmanifest"]):
        h.update(rel.encode())
        h.update(read(root, rel).encode())
    return h.hexdigest()[:10]


def rewrite_refs(text, renames, base_dir):
    """Replace references to renamed files, relative to the referring file."""
    for old, new in renames.items():
        rel_old = os.path.relpath(old, base_dir or ".").replace(os.sep, "/")
        rel_new = os.path.relpath(new, base_dir or ".").replace(os.sep, "/")
        for prefix in ("./", ""):
            pattern = r"""(?<=["'])""" + re.escape(prefix + rel_old) + r"""(?=["'?#])"""
            text = re.sub(pattern, prefix + rel_new, text)
    return text


def main():
    root = sys.argv[1] if len(sys.argv) > 1 else "."
    build = build_id(root)
    renames = {}

    for rel in ASSETS:
        text = read(root, rel).replace("__BUILD__", build)
        text = rewrite_refs(text, renames, os.path.dirname(rel))
        digest = hashlib.sha1(text.encode()).hexdigest()[:8]
        stem, ext = os.path.splitext(rel)
        new_rel = f"{stem}.{digest}{ext}"
        write(root, new_rel, text)
        os.remove(os.path.join(root, rel))
        renames[rel] = new_rel
        print(f"  {rel} -> {new_rel}")

    for rel in REFERRERS:
        text = read(root, rel).replace("__BUILD__", build)
        write(root, rel, rewrite_refs(text, renames, os.path.dirname(rel)))

    # Fail the build if anything still points at an unhashed asset.
    for rel in REFERRERS + list(renames.values()):
        text = read(root, rel)
        for old in renames:
            name = os.path.basename(old)
            if re.search(r"""["'/]""" + re.escape(name) + r"""["'?#]""", text):
                sys.exit(f"error: {rel} still references {name}")
    print(f"  build {build}")


if __name__ == "__main__":
    main()
