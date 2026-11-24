#!/usr/bin/env python3
# -*- coding: utf-8 -*-
# Modified for kaogong-naoku-re1.0: 本项目新增脚本（不从上游继承）。
"""生成导入题库元数据 qbanks.json（题库 → 自有分类 → 成员题目）。

背景：题库合并只把题写进 kaogong.db.questions，合并后「这题属于哪个导入题库、
在该题库的第几套第几题」就丢了；真题浏览因此无法按导入题库分类。
本脚本读「导入 JSON」+「题库合并计划」+（可选的）合并后题库，产出：

    qbanks.json
      banks[].id / name / book / group_label / total
      banks[].groups[] = {key: 题集名, items: [{qid, no}]}

qid 一律是 **合并后题库里的 qid**（新题是题库自己的 qid，并入既有题的用原题 qid），
所以前端/服务端拿它可以直接和 questions.qid 对齐。

用法（重复导入新题库时再跑一次，会按 id 合并进已有 qbanks.json）：
    python build_qbanks.py --import 导入.json --plan 合并计划.json \
        --id sihai-ljtc-600-2026 --name "四海公考 · 逻辑填空600题（2026）"
"""
import argparse
import json
import os
import re
import sqlite3
import sys
from collections import OrderedDict

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "qbanks.json")


def _norm(s):
    """题干归一化：去标签、去空白、去划线，只留可比较的文字。"""
    s = re.sub(r"<[^>]+>", "", s or "")
    s = s.replace("______", "").replace("____", "")
    s = re.sub(r"\s+", "", s)
    return s


def _set_order(key):
    m = re.search(r"(\d+)", key or "")
    return (int(m.group(1)) if m else 9999, key or "")


def build(import_path, plan_path, bank_id, bank_name, db_path=None, out_path=OUT):
    with open(import_path, encoding="utf-8") as f:
        items = json.load(f)
    with open(plan_path, encoding="utf-8") as f:
        plan = json.load(f)

    by_key, by_stem = {}, {}
    for it in items:
        src = it.get("_source") or {}
        by_key[(src.get("set"), src.get("no"))] = it
        by_stem.setdefault(_norm(it.get("stem")), []).append(it)

    members, unresolved = [], []
    for ent in plan.get("updates", []) + plan.get("creates", []):
        src = ent.get("_source") or {}
        qid = str(ent.get("bank_qid") or "").strip()
        it = by_key.get((src.get("set"), src.get("no")))
        if not (qid and it):
            unresolved.append(("plan", ent.get("no"), qid))
            continue
        members.append((it, qid))
    # 冲突条目（同题干不同答案）没带 _source：按题干归一化回查导入 JSON
    for ent in plan.get("conflicts", []):
        qid = str(ent.get("bank_qid") or "").strip()
        cand = by_stem.get(_norm(ent.get("stem")), [])
        cand = [c for c in cand if str(c.get("answer")) == str(ent.get("book_answer"))]
        if not (qid and len(cand) == 1):
            unresolved.append(("conflict", ent.get("no"), qid))
            continue
        members.append((cand[0], qid))

    seen = set()
    groups = OrderedDict()
    for it, qid in members:
        if qid in seen:
            continue
        seen.add(qid)
        src = it.get("_source") or {}
        g = src.get("set") or "未分套"
        groups.setdefault(g, []).append({"qid": qid, "no": int(src.get("no") or 0)})
    out_groups = []
    for key in sorted(groups, key=_set_order):
        rows = sorted(groups[key], key=lambda x: x["no"])
        out_groups.append({"key": key, "items": rows})

    bank = {
        "id": bank_id,
        "name": bank_name,
        "book": (items[0].get("_source") or {}).get("book", ""),
        "group_label": "题集",
        "total": sum(len(g["items"]) for g in out_groups),
        "groups": out_groups,
    }

    # 只保留题库里真的存在的题，避免前端点开 404
    missing = 0
    if db_path and os.path.exists(db_path):
        con = sqlite3.connect(db_path)
        have = {r[0] for r in con.execute("SELECT qid FROM questions")}
        for g in out_groups:
            keep = [x for x in g["items"] if x["qid"] in have]
            missing += len(g["items"]) - len(keep)
            g["items"] = keep
        out_groups[:] = [g for g in out_groups if g["items"]]
        bank["total"] = sum(len(g["items"]) for g in out_groups)
        con.close()

    data = {"version": 1, "banks": []}
    if os.path.exists(out_path):
        try:
            with open(out_path, encoding="utf-8") as f:
                data = json.load(f)
        except Exception:
            data = {"version": 1, "banks": []}
    banks = [b for b in data.get("banks", []) if b.get("id") != bank_id]
    banks.append(bank)
    data["banks"] = sorted(banks, key=lambda b: b.get("name", ""))
    data["version"] = 1
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=1)
    return bank, unresolved, missing


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--import", dest="imp", required=True, help="导入 JSON（带 _source.set / no）")
    ap.add_argument("--plan", required=True, help="题库合并计划 JSON")
    ap.add_argument("--id", required=True, help="题库 id（英文 slug，前端筛选参数用它）")
    ap.add_argument("--name", required=True, help="题库显示名")
    ap.add_argument("--db", default=os.path.join(HERE, "kaogong.db"), help="合并后的题库（用于剔除不存在的题）")
    ap.add_argument("--out", default=OUT)
    a = ap.parse_args()
    bank, unresolved, missing = build(a.imp, a.plan, a.id, a.name, a.db, a.out)
    print("题库: %s（%s）" % (bank["name"], bank["id"]))
    print("分类: %d 组 · 成员 %d 题 · 题库中缺失 %d 题" % (len(bank["groups"]), bank["total"], missing))
    for g in bank["groups"][:5]:
        print("  %s: %d 题" % (g["key"], len(g["items"])))
    if len(bank["groups"]) > 5:
        print("  … 共 %d 组" % len(bank["groups"]))
    if unresolved:
        print("未能解析的条目（%d）：%r" % (len(unresolved), unresolved[:8]))
        return 1
    print("已写入 %s" % a.out)
    return 0


if __name__ == "__main__":
    sys.exit(main())
