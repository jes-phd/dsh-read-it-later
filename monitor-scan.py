#!/usr/bin/env python3
"""扫描一个 DSH 会话日志，给「状态监控」用：这一轮跑完没有、有没有卡在需要人决定。

只输出结论，不解完整正文（正文可以很大）：
  {
    "sessionId", "title", "cwd",
    "turns": 已完成的轮次, "lastTurn": 最后一轮编号, "openTurn": 是否有轮次还没结束,
    "mtime": 日志修改时间,
    "pending": null | {"id","kind":"question|approval","title","text","options":[...],"at"}
  }
"""
import argparse
import glob
import json
import os
import sys


def find_log(session_id):
    sid = session_id
    if sid.startswith('session-'):
        sid = sid[len('session-'):]
    root = os.path.expanduser('~/.dsh/sessions')
    best = None
    for path in glob.glob(os.path.join(root, '*', 'session-' + sid, 'session.v*.jsonl.zstd')):
        if best is None or os.path.getsize(path) > os.path.getsize(best):
            best = path
    return best


def text_of(value):
    if isinstance(value, str):
        return value
    return ''


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--session', required=True)
    args = ap.parse_args()

    log = find_log(args.session)
    if not log:
        print(json.dumps({'error': 'session-log-not-found', 'sessionId': args.session}))
        return 2

    try:
        import zstandard
    except ImportError:
        print(json.dumps({'error': 'zstandard-not-installed'}))
        return 3

    try:
        with open(log, 'rb') as fh:
            raw = zstandard.ZstdDecompressor().stream_reader(fh).read().decode('utf-8', 'replace')
    except Exception as exc:  # noqa: BLE001
        print(json.dumps({'error': f'decode-failed: {exc}'}))
        return 4

    lines = [ln for ln in raw.split('\n') if ln.strip()]
    title = ''
    cwd = ''
    turns = 0
    last_turn = 0
    last_end_idx = -1
    question_calls = {}   # callId -> {'idx','text','options','title','at'}
    approvals = {}        # id -> {'idx','text','options','at','toolName'}

    for idx, line in enumerate(lines):
        try:
            rec = json.loads(line)
        except Exception:  # noqa: BLE001
            continue
        kind = rec.get('type')
        data = rec.get('data') or {}
        at = rec.get('time') or rec.get('at') or data.get('time') or None

        if kind == 'session/title':
            title = text_of(data.get('title')) or title
        elif kind == 'session':
            cwd = text_of(data.get('cwd')) or cwd
        elif kind == 'turn/end':
            turns += 1
            last_end_idx = idx
            if isinstance(data.get('turn'), int):
                last_turn = data['turn']
        elif kind == 'tool/call' and data.get('name') in ('ask_user_question', 'question'):
            call_id = data.get('callId')
            if not call_id:
                continue
            try:
                payload = json.loads(data.get('arguments') or '{}')
            except Exception:  # noqa: BLE001
                payload = {}
            questions = payload.get('questions') or []
            first = questions[0] if questions else {}
            options = [o.get('label') for o in (first.get('options') or []) if o.get('label')]
            question_calls[call_id] = {
                'idx': idx,
                'at': at,
                'title': first.get('header') or '',
                'text': first.get('question') or payload.get('question') or '',
                'options': options,
            }
        elif kind == 'approval/asked':
            ask_id = data.get('id')
            if ask_id:
                approvals[ask_id] = {
                    'idx': idx,
                    'at': at,
                    'title': data.get('toolName') or '',
                    'text': data.get('reason') or '需要你确认这次操作',
                    'options': ['允许', '拒绝'],
                }
        elif kind == 'approval/decided':
            approvals.pop(data.get('id'), None)
        elif kind == 'tool/result':
            # 结果行里带 toolCallId（字段位置不固定），直接按文本找也能配对
            for call_id in list(question_calls):
                if call_id in line:
                    question_calls.pop(call_id, None)

    pending = None
    candidates = []
    for call_id, info in question_calls.items():
        if info['idx'] > last_end_idx:
            candidates.append(('question', call_id, info))
    for ask_id, info in approvals.items():
        if info['idx'] > last_end_idx:
            candidates.append(('approval', ask_id, info))
    if candidates:
        candidates.sort(key=lambda item: item[2]['idx'])
        kind, ident, info = candidates[-1]
        pending = {
            'id': ident,
            'kind': kind,
            'title': info.get('title') or '',
            'text': info.get('text') or '',
            'options': info.get('options') or [],
            'at': info.get('at'),
        }

    print(json.dumps({
        'sessionId': args.session,
        'title': title,
        'cwd': cwd,
        'turns': turns,
        'lastTurn': last_turn,
        'openTurn': last_end_idx != len(lines) - 1 and turns >= 0 and (
            # 最后一条不是 turn/end，且之后还有记录 → 这一轮还在跑
            any(ln for ln in lines[last_end_idx + 1:])
        ),
        'mtime': os.path.getmtime(log),
        'size': os.path.getsize(log),
        'logFile': log,
        'pending': pending,
    }, ensure_ascii=False))
    return 0


if __name__ == '__main__':
    sys.exit(main())
