#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把 AI 解析导入题库 questions.ai_json。

输入 JSON 格式（数组）：
    [{"qid": "2047698", "ai": {"v":1, "answer":"C", "summary":"...", "blocks":[...]}}, ...]

也接受 build_ai_analysis.py --out 产出的同结构文件。

用法：
    python import_ai_analysis.py ai_analysis_试点.json
    python import_ai_analysis.py ai_analysis_试点.json --model manual-v1 --dry
"""

import argparse
import json
import os
import sqlite3
import sys
import time

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

HERE = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.join(HERE, "kaogong.db")


def validate(ai):
    if not isinstance(ai, dict):
        raise ValueError("ai 不是对象")
    if not isinstance(ai.get("blocks"), list) or not ai["blocks"]:
        raise ValueError("blocks 缺失")
    for b in ai["blocks"]:
        if not isinstance(b, dict) or "type" not in b:
            raise ValueError("block 结构错误: %r" % (b,))
        if b["type"] == "table" and not b.get("rows"):
            raise ValueError("table 无 rows")
        if b["type"] in ("text", "steps", "warn", "note") and not b.get("x"):
            raise ValueError("block 缺 x")
    return ai


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("path", help="JSON 文件路径")
    ap.add_argument("--model", default="manual", help="写入 ai_model 的标识")
    ap.add_argument("--dry", action="store_true", help="只校验不写库")
    args = ap.parse_args()

    with open(args.path, encoding="utf-8") as f:
        data = json.load(f)
    if isinstance(data, dict):
        data = [data]
    if not isinstance(data, list):
        sys.exit("文件应为数组或单个对象")

    c = sqlite3.connect(DB_PATH, timeout=20)
    c.row_factory = sqlite3.Row
    ok = skip = bad = 0
    now = time.strftime("%Y-%m-%dT%H:%M:%S")
    for item in data:
        qid = str(item.get("qid") or "").strip()
        ai = item.get("ai")
        if not qid:
            print("[SKIP] 缺 qid"); skip += 1; continue
        row = c.execute("SELECT qid,module,category,answer FROM questions WHERE qid=?", (qid,)).fetchone()
        if not row:
            print("[MISS] 题库无此题 qid=%s" % qid); skip += 1; continue
        try:
            validate(ai)
        except Exception as e:
            print("[BAD ] %s %s → %s" % (qid, row["module"], e)); bad += 1; continue
        if str(ai.get("answer") or "").strip().upper() != str(row["answer"]).strip().upper():
            print("[WARN] %s 答案不一致：ai=%s 题库=%s（按题库覆盖）"
                  % (qid, ai.get("answer"), row["answer"]))
            ai["answer"] = row["answer"]
        if not args.dry:
            c.execute("UPDATE questions SET ai_json=?,ai_model=?,ai_at=? WHERE qid=?",
                      (json.dumps(ai, ensure_ascii=False), args.model, now, qid))
        ok += 1
    if not args.dry:
        c.commit()
    print("导入%s：成功 %d，跳过 %d，失败 %d" % ("（试跑）" if args.dry else "", ok, skip, bad))
    c.close()


if __name__ == "__main__":
    main()
