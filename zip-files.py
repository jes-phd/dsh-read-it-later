#!/usr/bin/env python3
"""把一个文件列表打成 zip。用法：stdin 传入 {"out": "...zip", "files": ["a","b"]}。"""
import json
import os
import sys
import zipfile


def main() -> None:
    try:
        spec = json.load(sys.stdin)
    except Exception as exc:  # noqa: BLE001
        print(json.dumps({"ok": False, "error": f"bad-json: {exc}"}))
        return

    out = spec.get("out")
    files = spec.get("files") or []
    if not out:
        print(json.dumps({"ok": False, "error": "missing-out"}))
        return

    parent = os.path.dirname(out)
    if parent:
        os.makedirs(parent, exist_ok=True)

    used = {}
    count = 0
    try:
        with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as zf:
            for f in files:
                if not f or not os.path.isfile(f):
                    continue
                name = os.path.basename(f)
                if name in used:
                    used[name] += 1
                    stem, ext = os.path.splitext(name)
                    name = f"{stem}({used[name]}){ext}"
                else:
                    used[name] = 1
                zf.write(f, name)
                count += 1
    except Exception as exc:  # noqa: BLE001
        print(json.dumps({"ok": False, "error": f"zip-failed: {exc}"}))
        return

    print(json.dumps({
        "ok": True,
        "zipPath": out,
        "count": count,
        "bytes": os.path.getsize(out) if os.path.exists(out) else 0,
    }, ensure_ascii=False))


if __name__ == "__main__":
    main()
