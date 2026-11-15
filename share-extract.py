#!/usr/bin/env python
"""Extract one DSH session's shareable content for the Feishu share button.

Reads the multi-frame zstd session log (Node cannot decode multi-frame zstd)
and prints a single JSON object:

    {"sessionId","title","cwd","prompts":[...],"answers":[...],
     "files":[...],"turns":N,"lastTurn":n}

Usage:
    python share-extract.py --session <sessionId> [--max-answers 3]
"""
import argparse
import json
import os
import sys
from pathlib import Path

import zstandard as zstd

SESS_ROOT = Path(os.environ.get("USERPROFILE") or os.path.expanduser("~")) / ".dsh" / "sessions"


def find_log(sid):
    # 界面上的 data-conversation-session 可能带 "session-" 前缀
    if sid.startswith("session-"):
        sid = sid[len("session-"):]
    pats = [f"*/session-{sid}/session.v*.jsonl.zstd", f"*/session-{sid}*/session.v*.jsonl.zstd"]
    cands = []
    for pat in pats:
        cands.extend(SESS_ROOT.glob(pat))
        if cands:
            break
    if not cands:
        return None

    def version(p):
        head = p.name.split(".")[1] if p.name.count(".") >= 3 else ""
        try:
            return int(head.lstrip("v"))
        except ValueError:
            return 0

    return max(cands, key=lambda p: (version(p), p.stat().st_size))


def load(path: Path):
    with open(path, "rb") as f:
        data = zstd.ZstdDecompressor().stream_reader(f).read()
    recs = []
    for line in data.decode("utf-8", "replace").split("\n"):
        line = line.strip()
        if not line:
            continue
        try:
            recs.append(json.loads(line))
        except Exception:
            pass
    return recs


def text_of(msg):
    parts = []
    for c in (msg or {}).get("content", []) or []:
        if isinstance(c, dict) and c.get("type") == "text":
            t = c.get("text")
            if isinstance(t, str):
                parts.append(t)
    return "\n".join(parts).strip()


def turn_of(seq, starts):
    """Attribute a record seq to the turn whose turn/start seq is the largest <= seq."""
    cur = None
    for st, tn in starts:
        if seq is not None and seq >= st:
            cur = tn
        else:
            break
    return cur


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--session", required=True)
    ap.add_argument("--max-answers", type=int, default=3)
    ap.add_argument("--turn", type=int, default=None, help="only this turn number")
    ap.add_argument("--seq", type=int, default=None, help="resolve the turn that contains this record seq")
    args = ap.parse_args()

    path = find_log(args.session)
    if path is None:
        print(json.dumps({"error": "session-log-not-found", "sessionId": args.session}))
        return 2

    recs = load(path)

    starts = []
    for r in recs:
        if r.get("type") == "turn/start" and isinstance((r.get("data") or {}).get("turn"), int):
            starts.append((r.get("seq") or 0, r["data"]["turn"]))
    starts.sort()

    want = args.turn
    if want is None and args.seq is not None:
        want = turn_of(args.seq, starts)

    def in_scope(r):
        if want is None:
            return True
        return turn_of(r.get("seq"), starts) == want

    title = None
    cwd = None
    prompts = []
    user_msgs = []
    answers = []
    files = []
    seen_files = set()
    turns = 0

    for r in recs:
        t = r.get("type")
        d = r.get("data") or {}
        if t == "session" and cwd is None:
            cwd = d.get("cwd") or r.get("cwd")
        elif t == "session/title":
            v = d.get("title")
            if isinstance(v, str) and v.strip():
                title = v.strip()
        elif t == "turn/end":
            turns += 1
        elif t == "tool/call":
            if not in_scope(r):
                continue
            if d.get("name") in ("write", "edit", "present", "save"):
                try:
                    a = json.loads(d.get("arguments") or "{}")
                except Exception:
                    a = {}
                cand = []
                if isinstance(a.get("file_path"), str):
                    cand.append(a["file_path"])
                if isinstance(a.get("path"), str):
                    cand.append(a["path"])
                for f in (a.get("files") or []):
                    if isinstance(f, dict) and isinstance(f.get("path"), str):
                        cand.append(f["path"])
                for p in cand:
                    if p and p not in seen_files and not p.startswith("<"):
                        seen_files.add(p)
                        files.append(p)
        elif t == "user/message":
            if ((d.get("source") or {}).get("kind")) != "user":
                continue
            txt = text_of(d)
            if not txt:
                continue
            if in_scope(r):
                if not user_msgs or user_msgs[-1] != txt:
                    user_msgs.append(txt)
        elif t == "agent/inbox/spliced":
            if want is not None:
                continue
            for ins in (d.get("inserted") or []):
                if not isinstance(ins, dict):
                    continue
                if ((ins.get("source") or {}).get("kind")) != "user":
                    continue
                txt = text_of({"content": ins.get("content")})
                if txt and (not prompts or prompts[-1] != txt):
                    prompts.append(txt)
        elif t == "assistant/message":
            if not in_scope(r):
                continue
            txt = text_of(d.get("message"))
            if txt:
                answers.append({"turn": d.get("turn") or turn_of(r.get("seq"), starts), "text": txt})
        elif t == "deliverables/presented":
            if not in_scope(r):
                continue
            for f in (d.get("files") or []):
                p = f.get("path") if isinstance(f, dict) else None
                if isinstance(p, str) and p and p not in seen_files:
                    seen_files.add(p)
                    files.append(p)

    if want is not None:
        kept_answers = answers
    else:
        kept_answers = answers[-max(1, args.max_answers):]
    last_turn = want if want is not None else (kept_answers[-1]["turn"] if kept_answers else None)
    final_prompts = user_msgs or prompts
    print(json.dumps({
        "sessionId": args.session,
        "title": title,
        "cwd": cwd,
        "turn": want,
        "prompts": final_prompts,
        "answers": [a["text"] for a in kept_answers],
        "files": files,
        "turns": turns,
        "lastTurn": last_turn,
        "logFile": str(path),
    }, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
