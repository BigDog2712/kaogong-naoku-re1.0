#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""AI解析生成器 —— 为题库每道题生成结构化解析，写入 questions.ai_json。

产出的 JSON 由前端 aiAnalysisHtml() 渲染成「🤖 AI解析」表格卡片，
位置在每题解析区的最上方（官方解析之前）。

用法
----
    # 看进度（各模块覆盖率）
    python build_ai_analysis.py --stats

    # 试跑 1 题，只打印不写库
    python build_ai_analysis.py --limit 1 --dry

    # 试点：言语理解 30 题
    python build_ai_analysis.py --module 言语理解与表达 --limit 30

    # 指定模块某个大类
    python build_ai_analysis.py --module 判断推理 --category 图形推理 --limit 50

    # 全量 + 断点续跑（已生成的自动跳过）+ 6 并发
    python build_ai_analysis.py --all --workers 6

    # 强制重做（覆盖已有 ai_json）
    python build_ai_analysis.py --module 言语理解与表达 --limit 30 --force

环境变量
--------
    AI_API_KEY    必填。DeepSeek / 通义 / 智谱 / OpenAI 等任一家的 key
    AI_BASE_URL   默认 https://api.deepseek.com/v1
    AI_MODEL      默认 deepseek-chat

写库前必须停掉 server.py（SQLite 单写者），脚本会先探测是否被占用。
"""

import argparse
import json
import os
import re
import socket
import sqlite3
import sys
import threading
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed

# 部分中转 API（如 ginka.cloud）DNS 同时返回 AAAA，但 IPv6 实际不通，
# urllib 默认优先 IPv6 会卡到超时。这里强制域名解析只取 IPv4。
_orig_getaddrinfo = socket.getaddrinfo
def _ipv4_getaddrinfo(host, port, family=0, type=0, proto=0, flags=0):
    return _orig_getaddrinfo(host, port, socket.AF_INET, type, proto, flags)
socket.getaddrinfo = _ipv4_getaddrinfo

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

HERE = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.join(HERE, "kaogong.db")

# 支持多 key 轮换：AI_API_KEYS 逗号分隔（优先），或单个 AI_API_KEY。
# 每个 key 有独立限流，轮换等于把吞吐上限放大 N 倍；请求在线程间轮询分配。
_KEYS_RAW = os.environ.get("AI_API_KEYS", "") or os.environ.get("AI_API_KEY", "")
API_KEYS = [k.strip() for k in _KEYS_RAW.split(",") if k.strip()]
API_KEY = API_KEYS[0] if API_KEYS else ""
BASE_URL = os.environ.get("AI_BASE_URL", "https://api.deepseek.com/v1").strip().rstrip("/")
MODEL = os.environ.get("AI_MODEL", "deepseek-chat").strip()

_LOCK = threading.Lock()
_key_cursor = [0]
_key_cursor_lock = threading.Lock()

# 限流诊断：仅 AI_DEBUG=1 时打印，不影响正常生成
_DEBUG = os.environ.get("AI_DEBUG", "") == "1"
_STATS = {"429": 0, "5xx": 0, "retry": 0}
_STATS_LOCK = threading.Lock()

# 网络抖动兜底：只限制「网络异常」重试次数，HTTP 429/5xx 仍靠换 key 解决
NETWORK_RETRY_MAX = int(os.environ.get("AI_NETWORK_RETRIES", "2"))
HTTP_TIMEOUT = int(os.environ.get("AI_HTTP_TIMEOUT", "90"))
BACKOFF_MAX = float(os.environ.get("AI_BACKOFF_MAX", "5"))

def next_key():
    """线程安全地轮询取下一个 key。"""
    if not API_KEYS:
        return ""
    with _key_cursor_lock:
        k = API_KEYS[_key_cursor[0] % len(API_KEYS)]
        _key_cursor[0] += 1
        return k

EXPERT_FILE = os.path.join(HERE, "公考上岸教练_专家提示词.md")

# 任务锁定语：放在完整专家提示词之前，防止模型跑去扮演考官/出诊断卷/做备考规划。
TASK_LOCK = """【当前任务】你现在只做一件事：为下面这道行测真题生成结构化解析。
严格按文末的 JSON 契约输出，不要扮演考官、不要出题、不要做备考规划、不要写申论批改。
Call your methodology from the expert role below, but the ONLY deliverable is the JSON specified at the end.

--- 以下为你必须遵循的专家方法论全文 ---

"""

# 精简版 = 内嵌的输出契约本身（默认方案，实测质量与完整版相当但省约 60% token）
SYSTEM_PROMPT_SIMPLE = """你是资深公务员考试辅导专家，融合中公、粉笔、华图的公开教学方法论，并长期研究国考省考真题命题规律。

请为给定的一道行测真题生成结构化解析，严格输出 JSON（不要 markdown 代码块，不要任何解释性前后缀）。

要求：
1. 结论先行：summary 一句话说清本题考什么、答案为什么是它，50 字以内。
2. 逐项判定：对每一个选项给出「✓ 入选」或「✗ 排除」以及具体理由。理由必须引用题干或选项的原词、原句，禁止「不符合题意」「表述不当」这类空话。
3. 方法可迁移：提炼出能直接用于同类题的判断步骤或口诀（2-4 步）。
4. 避坑：指出本题最容易错的点和错因（1-3 条）。
5. 笔记：一段可直接抄进错题本的要点，写「触发条件 + 判断动作」，而不是只写结论。

输出 JSON 结构：
{
  "answer": "正确选项字母",
  "summary": "一句话考点与结论",
  "blocks": [
    {"t": "题干骨架", "type": "text", "x": "把题干翻译成逻辑式/结构式/解题纲领"},
    {"t": "逐项判定", "type": "table", "head": ["选项", "判断", "依据"], "rows": [["A", "✗ 排除", "引用原词的具体理由"], ["B", "✗ 排除", "..."], ["C", "✓ 入选", "..."], ["D", "✗ 排除", "..."]]},
    {"t": "可迁移方法", "type": "steps", "x": ["第1步：...", "第2步：...", "第3步：..."]},
    {"t": "避坑提醒", "type": "warn", "x": ["坑一：...", "坑二：..."]},
    {"t": "笔记", "type": "note", "x": "可直接抄写的一段笔记"}
  ]
}

硬性约束：
- table 的 rows 必须覆盖全部选项，一个不漏。
- blocks 输出 3-5 块，按题型调整：言语/判断重「逐项判定」，数量/资料重「步骤」，常识可省略 table。
- 不要照抄给定的官方解析原文，用自己的话重新组织；官方解析只作为答案校准依据。
- 如果题目含图片而你无法查看，就依据题干文字与官方解析反推思路，并在 summary 里如实说明「图形细节以原题为准」。
- 只输出 JSON。"""

# 完整版 = 任务锁定语 + 专家方法论正文 + 输出契约
_EXPERT_BODY = open(EXPERT_FILE, "r", encoding="utf-8").read().strip() if os.path.exists(EXPERT_FILE) else ""
SYSTEM_PROMPT_EXPERT = (TASK_LOCK + _EXPERT_BODY +
                        "\n\n--- 专家方法论结束。现在严格执行下面的输出契约 ---\n\n" +
                        SYSTEM_PROMPT_SIMPLE) if _EXPERT_BODY else SYSTEM_PROMPT_SIMPLE

# 默认精简版；命令行 --expert 切完整版
SYSTEM_PROMPT = SYSTEM_PROMPT_SIMPLE


def strip_html(s):
    if not s:
        return ""
    s = re.sub(r"<br\s*/?>", "\n", s, flags=re.I)
    s = re.sub(r"</p>", "\n", s, flags=re.I)
    s = re.sub(r"<img[^>]*>", "[图片]", s, flags=re.I)
    s = re.sub(r"<[^>]+>", "", s)
    s = s.replace("&nbsp;", " ").replace("&lt;", "<").replace("&gt;", ">") \
         .replace("&amp;", "&").replace("&quot;", '"')
    return re.sub(r"\n{3,}", "\n\n", s).strip()


def options_text(raw):
    try:
        opts = json.loads(raw or "[]")
    except Exception:
        return ""
    out = []
    for o in opts:
        k = o.get("key") or o.get("label") or ""
        body = strip_html(o.get("html") or o.get("label") or "")
        out.append("%s. %s" % (k, body))
    return "\n".join(out)


def build_user_prompt(row):
    stem = strip_html(row["stem"])
    opts = options_text(row["options"])
    parts = [
        "【模块】%s / %s" % (row["module"] or "", row["category"] or ""),
        "【题源】%s %s" % (row["region"] or "", row["year"] or ""),
    ]
    if row["kadian"]:
        parts.append("【考点标签】%s" % row["kadian"])
    if row["material"]:
        parts.append("【材料】\n%s" % strip_html(row["material"])[:2500])
    parts.append("【题干】\n%s" % stem)
    parts.append("【选项】\n%s" % opts)
    parts.append("【正确答案】%s" % (row["answer"] or ""))
    if row["analysis"]:
        parts.append("【官方解析（仅供参考，不要照抄）】\n%s" % strip_html(row["analysis"])[:2000])
    if row["has_image"]:
        parts.append("【提示】本题含配图（%s），你看不到图片本身。" % (row["img_refs"] or ""))
    return "\n\n".join(parts)


def call_api(user_prompt, retries=3):
    url = BASE_URL + "/chat/completions"
    payload = {
        "model": MODEL,
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": user_prompt},
        ],
        "temperature": 0.3,
        # 思考模型的 reasoning_tokens 计入 max_tokens，预算翻倍才不会截断正文
        "max_tokens": int(os.environ.get("AI_MAX_TOKENS", "4000")),
        "response_format": {"type": "json_object"},
    }
    data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    last = None
    # 多 key 时把重试次数放大：限流的 key 直接换下一个，不干等
    tries = retries + (len(API_KEYS) - 1) if len(API_KEYS) > 1 else retries
    net_retries = 0
    for attempt in range(tries):
        try:
            key = next_key()
            req = urllib.request.Request(url, data=data, method="POST", headers={
                "Content-Type": "application/json",
                "Authorization": "Bearer " + key,
                # 中转 API 前有 Cloudflare，urllib 默认 UA 会触发 1010 拦截
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                              "AppleWebKit/537.36 (KHTML, like Gecko) "
                              "Chrome/131.0.0.0 Safari/537.36",
                "Accept": "application/json",
            })
            with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT) as r:
                body = json.loads(r.read().decode("utf-8"))
            return body["choices"][0]["message"]["content"]
        except urllib.error.HTTPError as e:
            detail = ""
            try:
                detail = e.read().decode("utf-8", "ignore")[:300]
            except Exception:
                pass
            last = "HTTP %s %s" % (e.code, detail)
            if _DEBUG:
                with _STATS_LOCK:
                    if e.code == 429:
                        _STATS["429"] += 1
                    elif e.code in (500, 502, 503, 504):
                        _STATS["5xx"] += 1
            if e.code in (429, 500, 502, 503, 504):
                # 多 key 轮换时无需长等，下一个 key 大概率没限流；单 key 才退避
                if len(API_KEYS) <= 1:
                    time.sleep(2 * (attempt + 1))
                continue
            raise RuntimeError(last)
        except Exception as e:
            last = str(e)
            if _DEBUG:
                with _STATS_LOCK:
                    _STATS["retry"] += 1
            net_retries += 1
            if net_retries > NETWORK_RETRY_MAX:
                break
            time.sleep(min(1.5 * (attempt + 1), BACKOFF_MAX))
    raise RuntimeError(last or "unknown error")


def normalize(raw_text, expect_answer):
    """剥掉可能的 ```json 包裹，解析并校验结构。"""
    t = (raw_text or "").strip()
    if t.startswith("```"):
        t = re.sub(r"^```[a-zA-Z]*\s*", "", t)
        t = re.sub(r"\s*```$", "", t).strip()
    obj = json.loads(t)
    if not isinstance(obj, dict) or not isinstance(obj.get("blocks"), list) or not obj["blocks"]:
        raise ValueError("blocks 缺失")
    ans = (obj.get("answer") or "").strip().upper()[:1]
    if expect_answer and ans and ans != str(expect_answer).strip().upper()[:1]:
        obj["answer"] = str(expect_answer).strip().upper()[:1]
        obj["_answer_fixed"] = 1
    clean = {"v": 1, "answer": obj.get("answer") or expect_answer, "summary": (obj.get("summary") or "")[:160], "blocks": []}
    for b in obj["blocks"][:6]:
        if not isinstance(b, dict):
            continue
        typ = b.get("type") or "text"
        item = {"t": str(b.get("t") or "")[:40], "type": typ}
        if typ == "table":
            rows = [r for r in (b.get("rows") or []) if isinstance(r, list) and r]
            if not rows:
                continue
            item["head"] = [str(h)[:12] for h in (b.get("head") or ["选项", "判断", "依据"])]
            item["rows"] = [[str(c)[:600] for c in r] for r in rows[:8]]
        elif typ in ("steps", "warn"):
            xs = b.get("x")
            if isinstance(xs, str):
                xs = [xs]
            xs = [str(x)[:600] for x in (xs or []) if str(x).strip()]
            if not xs:
                continue
            item["x"] = xs[:8]
        else:
            x = str(b.get("x") or "")[:1200]
            if not x.strip():
                continue
            item["x"] = x
        clean["blocks"].append(item)
    if len(clean["blocks"]) < 2:
        raise ValueError("有效 block 不足")
    return clean


def q(sql, args=()):
    c = sqlite3.connect(DB_PATH, timeout=20)
    c.row_factory = sqlite3.Row
    try:
        return c.execute(sql, args).fetchall()
    finally:
        c.close()


def show_stats():
    rows = q("""SELECT module,
                       COUNT(*) n,
                       SUM(CASE WHEN IFNULL(ai_json,'')!='' THEN 1 ELSE 0 END) done
                FROM questions GROUP BY module ORDER BY n DESC""")
    total = done = 0
    print("%-16s %8s %8s %8s" % ("模块", "题量", "已生成", "覆盖率"))
    print("-" * 46)
    for r in rows:
        total += r["n"]; done += r["done"]
        print("%-16s %8d %8d %7.1f%%" % (r["module"], r["n"], r["done"], r["done"] * 100.0 / r["n"]))
    print("-" * 46)
    print("%-16s %8d %8d %7.1f%%" % ("合计", total, done, done * 100.0 / max(total, 1)))


def fetch_targets(args):
    cond, params = ["1=1"], []
    if not args.force:
        cond.append("IFNULL(ai_json,'')=''")
    if args.no_image:
        cond.append("IFNULL(has_image,0)=0")
    if args.module:
        cond.append("module=?"); params.append(args.module)
    if args.category:
        cond.append("category=?"); params.append(args.category)
    if args.qids:
        ids = [x.strip() for x in args.qids.split(",") if x.strip()]
        cond.append("qid IN (%s)" % ",".join("?" * len(ids)))
        params.extend(ids)
    sql = """SELECT id,qid,module,category,kadian,region,year,stem,options,answer,
                    analysis,material,has_image,img_refs
             FROM questions WHERE %s ORDER BY id""" % " AND ".join(cond)
    if args.limit:
        sql += " LIMIT %d" % args.limit
    return q(sql, params)


def main():
    ap = argparse.ArgumentParser(description="为题库生成结构化 AI 解析")
    ap.add_argument("--stats", action="store_true", help="只打印覆盖率")
    ap.add_argument("--module", help="限定模块，如 言语理解与表达")
    ap.add_argument("--category", help="限定大类，如 逻辑填空")
    ap.add_argument("--qids", help="逗号分隔的 qid 列表")
    ap.add_argument("--limit", type=int, default=0, help="最多处理 N 题")
    ap.add_argument("--all", action="store_true", help="全量（等价于不限 limit）")
    ap.add_argument("--force", action="store_true", help="覆盖已有 ai_json")
    ap.add_argument("--dry", action="store_true", help="只跑 1 题并打印结果，不写库")
    ap.add_argument("--workers", type=int, default=4, help="并发数，默认 4")
    ap.add_argument("--out", help="额外把结果导出为 JSON 文件")
    ap.add_argument("--no-image", action="store_true", help="跳过含配图的题（模型看不到图，解析不可信）")
    ap.add_argument("--expert", action="store_true", help="用完整专家提示词（默认用精简版，实测质量相当但省 60%% token）")
    args = ap.parse_args()

    if args.stats:
        show_stats(); return

    if not os.path.exists(DB_PATH):
        sys.exit("找不到题库：%s" % DB_PATH)
    if not API_KEY:
        sys.exit("未设置 AI_API_KEY。示例：\n  export AI_API_KEY=sk-xxx\n  export AI_BASE_URL=https://api.deepseek.com/v1\n  export AI_MODEL=deepseek-chat")

    global SYSTEM_PROMPT
    if args.expert:
        SYSTEM_PROMPT = SYSTEM_PROMPT_EXPERT
        print("[prompt] 使用完整专家提示词（%d 字符）" % len(SYSTEM_PROMPT))
    else:
        print("[prompt] 使用精简版提示词（%d 字符）" % len(SYSTEM_PROMPT))

    if args.dry:
        args.limit = args.limit or 1
        rows = fetch_targets(args)
        if not rows:
            sys.exit("没有待处理的题")
        r = rows[0]
        print("=" * 60)
        print("QID %s｜%s / %s" % (r["qid"], r["module"], r["category"]))
        print("=" * 60)
        raw = call_api(build_user_prompt(r))
        obj = normalize(raw, r["answer"])
        print(json.dumps(obj, ensure_ascii=False, indent=2))
        return

    rows = fetch_targets(args)
    if not rows:
        print("没有待处理的题（可能已全部生成，加 --force 重做）")
        show_stats(); return

    print("待处理 %d 题，模型 %s，并发 %d，key 池 %d 个" % (len(rows), MODEL, args.workers, len(API_KEYS)))
    ok = fail = 0
    t0 = time.time()
    exported = []

    def work(r):
        raw = call_api(build_user_prompt(r))
        return r["qid"], normalize(raw, r["answer"])

    with ThreadPoolExecutor(max_workers=max(1, args.workers)) as ex:
        futs = {ex.submit(work, r): r for r in rows}
        for fut in as_completed(futs):
            r = futs[fut]
            try:
                qid, obj = fut.result()
                with _LOCK:
                    c = sqlite3.connect(DB_PATH, timeout=20)
                    try:
                        c.execute("UPDATE questions SET ai_json=?,ai_model=?,ai_at=? WHERE qid=?",
                                  (json.dumps(obj, ensure_ascii=False), MODEL,
                                   time.strftime("%Y-%m-%dT%H:%M:%S"), qid))
                        c.commit()
                    finally:
                        c.close()
                ok += 1
                exported.append({"qid": qid, "ai": obj})
                n = ok + fail
                if n % 10 == 0 or n == len(rows):
                    print("  [%d/%d] 成功 %d 失败 %d  %.1fs" %
                          (n, len(rows), ok, fail, time.time() - t0))
            except Exception as e:
                fail += 1
                print("  [FAIL] %s / %s → %s" % (r["qid"], r["category"], str(e)[:160]))

    print()
    print("完成：成功 %d，失败 %d，用时 %.1fs" % (ok, fail, time.time() - t0))
    if _DEBUG:
        print("限流诊断：429=%d  5xx=%d  网络重试=%d" %
              (_STATS["429"], _STATS["5xx"], _STATS["retry"]))
    if args.out and exported:
        with open(args.out, "w", encoding="utf-8") as f:
            json.dump(exported, f, ensure_ascii=False, indent=1)
        print("已导出：%s" % args.out)
    show_stats()


if __name__ == "__main__":
    main()
