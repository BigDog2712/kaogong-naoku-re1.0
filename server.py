#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""考公间隔重复系统 - 零依赖后端 (Python 标准库)
启动:  python server.py    然后浏览器打开 http://127.0.0.1:8300
"""
import os, re, sys, json, gzip, shutil, sqlite3, datetime, mimetypes, urllib.parse, threading, email.utils, hashlib, secrets, time, base64
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import sm2
import migrate_v2

# ---------- 多用户（纯本地身份标识，最多 3 个账号） ----------
DEFAULT_UID = "u1"
MAX_USERS = 3

VAULT_ROOT = os.environ.get("KAOGONG_VAULT") or os.path.abspath(os.path.join(HERE, "..", "kaogongzhentizhengliu-main"))
DB_PATH = os.path.join(HERE, "kaogong.db")          # 题库（只读，ATTACH 为 qdb）
USERS_DB_PATH = (os.path.abspath(os.environ["KAOGONG_USER_DB"]) if os.environ.get("KAOGONG_USER_DB")
                 else os.path.join(HERE, "data", "users.db"))   # 线上固定 data/users.db；本地开发用 KAOGONG_USER_DB 指到 dev-data/

def _prepare_user_db():
    """用户库与「源码目录」分离，避免发布时把本地开发库传上去覆盖线上真实账号。

    发布是把整个项目目录打包上传（**不看 .gitignore**），所以只要用户库躺在项目里，
    每次上线都会用本地那份覆盖线上，线上新注册的账号与学习记录就全没了
    —— 这就是 v1.4.0 线上事故的根因（先发生在根目录 users.db，后又发生在 data/）。
    现在约定：
      · 线上（不带环境变量）= data/users.db，本地开发不写这个目录，因此永远不会被上传覆盖；
      · 本地开发用 KAOGONG_USER_DB 指到 dev-data/users.db（启动脚本已设好）；
      · 首次启动若只有根目录旧 users.db，则一次性迁移到当前数据文件（幂等）。
    """
    d = os.path.dirname(USERS_DB_PATH)
    if d:
        os.makedirs(d, exist_ok=True)
    legacy = os.path.join(HERE, "users.db")
    if os.path.abspath(legacy) == USERS_DB_PATH:
        return
    if os.path.exists(USERS_DB_PATH):
        # 两份并存（历史遗留：data/ 曾被误上传过）：以最近写入的那份为准，
        # 避免旧快照盖掉正在使用的新库；被淘汰的那份归档到 backups/，
        # 不再留在项目目录里——否则哪天 data/users.db 被删，它又会"复活"成线上库。
        if os.path.exists(legacy) and os.path.getsize(legacy) > 0:
            if os.path.getmtime(legacy) > os.path.getmtime(USERS_DB_PATH):
                shutil.copy2(legacy, USERS_DB_PATH)
                print(f"[db] 根目录 users.db 更新，已同步到 {USERS_DB_PATH}")
            else:
                try:
                    bkdir = os.path.join(os.path.dirname(USERS_DB_PATH), "backups")
                    os.makedirs(bkdir, exist_ok=True)
                    bk = os.path.join(bkdir, "legacy-%s.db" % datetime.datetime.now().strftime("%Y%m%d-%H%M%S"))
                    shutil.move(legacy, bk)
                    print(f"[db] 已归档历史用户库: {bk}")
                except Exception as e:
                    print("[db] 归档历史用户库失败:", e)
        return
    if os.path.exists(legacy) and os.path.getsize(legacy) > 0:
        shutil.copy2(legacy, USERS_DB_PATH)
        print(f"[db] 用户库已迁移到独立数据文件: {USERS_DB_PATH}")

_prepare_user_db()

# ---------- 用户库自动快照：防止再次被「整目录发布」覆盖 ----------
# 与 data/users.db 同目录的 backups/ 下，按需留最近 20 份；该目录同样不随发布上传，
# 所以即使线上库被覆盖，也能从快照里找回上一份。
BACKUP_DIR = os.path.join(os.path.dirname(USERS_DB_PATH), "backups")
BACKUP_KEEP = 20

def _snapshot_user_db(force=False, tag=""):
    """给当前用户库做一致性快照（sqlite backup API，不怕并发写）。
    仅当库内容有变化时才新增，避免每次重启都堆一份一样的文件。"""
    try:
        if not os.path.exists(USERS_DB_PATH) or os.path.getsize(USERS_DB_PATH) == 0:
            return None
        os.makedirs(BACKUP_DIR, exist_ok=True)
        snaps = sorted(f for f in os.listdir(BACKUP_DIR) if f.startswith("users-") and f.endswith(".db"))
        if snaps and not force:
            latest = os.path.join(BACKUP_DIR, snaps[-1])
            if (os.path.getsize(latest) == os.path.getsize(USERS_DB_PATH)
                    and os.path.getmtime(USERS_DB_PATH) <= os.path.getmtime(latest)):
                return None
        stamp = datetime.datetime.now().strftime("%Y%m%d-%H%M%S-%f")
        name = "users-%s%s.db" % (stamp, tag)
        dst = os.path.join(BACKUP_DIR, name)
        src = sqlite3.connect(USERS_DB_PATH, timeout=10)
        try:
            out = sqlite3.connect(dst)
            with out:
                src.backup(out)
            out.close()
        finally:
            src.close()
        snaps = sorted(f for f in os.listdir(BACKUP_DIR) if f.startswith("users-") and f.endswith(".db"))
        for old in snaps[:-BACKUP_KEEP]:
            try:
                os.remove(os.path.join(BACKUP_DIR, old))
            except Exception:
                pass
        print(f"[backup] 用户库快照: {dst}")
        local_path = get_setting("backup_local_path", "")
        if local_path:
            try:
                os.makedirs(local_path, exist_ok=True)
                local_dst = os.path.join(local_path, name)
                local_db = sqlite3.connect(local_dst)
                try:
                    check_src = sqlite3.connect(dst, timeout=10)
                    with local_db:
                        check_src.backup(local_db)
                    check_src.close()
                finally:
                    local_db.close()
                print(f"[backup] 本地路径副本: {local_dst}")
            except Exception as e:
                print("[backup] 本地路径副本失败:", e)
        return dst
    except Exception as e:
        print("[backup] 快照失败:", e)
        return None

def _backup_loop():
    """每 30 分钟检查一次，有变化就留一份快照（进程内后台线程）。"""
    while True:
        time.sleep(1800)
        _snapshot_user_db()

_snapshot_user_db()   # 启动即留一份

# 图片优先读本目录内的自包含副本（WebP），没有再回退到原题库
_LOCAL_IMG = os.path.join(HERE, "90-图片")
IMG_ROOT = _LOCAL_IMG if os.path.isdir(_LOCAL_IMG) else os.path.join(VAULT_ROOT, "90-图片")
STATIC = os.path.join(HERE, "static")
OPS_DIR = os.path.join(HERE, "ops")          # 运营面板静态页（与用户端完全分离）
PORT = int(os.environ.get("PORT") or os.environ.get("KAOGONG_PORT") or "8300")
mimetypes.add_type("image/webp", ".webp")

_Q_TOTAL = None               # 题库总题数缓存
_LOCK = threading.RLock()      # 进程内写串行：绝不让两条连接同时写 users.db
_conn_local = threading.local()  # 当前请求借到的那条连接

def _new_conn():
    # timeout / busy_timeout 都放到 30s：外部（备份、sqlite3 命令行、另一实例）短暂占锁时
    # 宁可等一等，也不要把 "database is locked" 直接甩给用户
    c = sqlite3.connect(USERS_DB_PATH, timeout=30, check_same_thread=False)
    c.row_factory = sqlite3.Row
    c.execute("PRAGMA busy_timeout=30000")
    # ATTACH 必须在事务外（此刻刚 connect，无未决事务）；不支持参数绑定，' 需双写转义
    c.execute("ATTACH DATABASE '%s' AS qdb" % DB_PATH.replace("'", "''"))
    return c

class _Conn:
    """一条连接的生命周期：借出 → 用 → 关掉。
    用一条新建、用完即关，换来两件事：线程之间绝不共用同一条 SQLite 连接
    （之前所有线程共用一条，交叉提交/读未提交事务正是 locked 的放大器），
    且任何异常都不会把半截事务留在进程里把库锁死。"""
    def __enter__(self):
        self._c = _new_conn()
        _conn_local.c = self._c   # 临时借用也挂到线程上：db() 后续取用不会拿到已关闭的连接
        return self._c
    def __exit__(self, et, ev, tb):
        c, self._c = self._c, None
        if c is None:
            return False
        try:
            if c.in_transaction:
                c.rollback()
        finally:
            c.close()
        if getattr(_conn_local, "c", None) is c:
            _conn_local.c = None
        return False

def db():
    """主连接 = 用户库 users.db；题库 kaogong.db 以别名 qdb ATTACH 进来。
    题库表一律写 qdb.questions 等带前缀引用；跨库 JOIN/事务由 SQLite 主日志保证。"""
    t = getattr(_conn_local, "c", None)
    if t is None:   # 未显式借用（启动校验等）→ 临时一条，语句级自动提交
        with _Conn() as c:
            return c
    return t

def borrow():
    """一个请求内复用同一条连接（含事务）。"""
    ctx = _Conn()
    _conn_local.c = ctx.__enter__()
    return ctx

def unborrow():
    c = getattr(_conn_local, "c", None)
    if c is not None:
        _conn_local.c = None
        try:
            if c.in_transaction:
                c.rollback()
        finally:
            c.close()

def today():
    return datetime.date.today().isoformat()

def now():
    return datetime.datetime.now().isoformat(timespec="seconds")

_APP_VER = {"v": None, "mtime": None}

def app_ver():
    """当前前端版本号：以 index.html 的 kg-app-ver 为唯一来源。"""
    fp = os.path.join(STATIC, "index.html")
    try:
        mt = os.stat(fp).st_mtime
        if _APP_VER["mtime"] == mt and _APP_VER["v"]:
            return _APP_VER["v"]
        with open(fp, encoding="utf-8") as f:
            m = re.search(r'name="kg-app-ver"\s+content="([^"]+)"', f.read())
        v = m.group(1) if m else "0"
        _APP_VER.update(v=v, mtime=mt)
        return v
    except Exception:
        return _APP_VER["v"] or "0"

def q_one(sql, args=()):
    r = db().execute(sql, args).fetchone()
    return dict(r) if r else None

def _int(v, d):
    """query 参数安全取整：非数字/空 → 默认值（防 ?size=abc 直接 500）"""
    try:
        return int(v)
    except (TypeError, ValueError):
        return d

def q_all(sql, args=()):
    return [dict(r) for r in db().execute(sql, args).fetchall()]

class Unauthorized(Exception):
    """未登录 / token 失效。由 do_GET / do_POST 统一捕获并返回 401。"""


class Forbidden(Exception):
    """已登录但无权限（如非管理员调用管理员接口）。统一捕获并返回 403。"""


def auth_uid(token):
    """由 token 反查账号 id；无效或缺失返回 None。
    注意：绝不采信客户端传来的 u= 参数，避免越权访问他人数据。
    多设备支持：每个登录会话在 sessions 表各占一行，互不顶掉；
    users.token 仍保留为「最近一次签发」的兼容回落。"""
    tok = (token or "").strip()
    if not tok:
        return None
    r = q_one("SELECT uid FROM sessions WHERE token=?", (tok,))
    if r and r["uid"]:
        return r["uid"]
    r = q_one("SELECT id FROM users WHERE token=? AND IFNULL(token,'')<>''", (tok,))
    return r["id"] if r else None


def need_uid(token):
    """解析 token → 账号 id；失败抛 Unauthorized（上层转 401）。"""
    uid = auth_uid(token)
    if not uid:
        raise Unauthorized()
    return uid


def user_role(uid):
    """账号角色（历史遗留列）。陪伴者已融合为普通账号功能，不再据此限制任何写操作。"""
    if not uid:
        return "student"
    r = q_one("SELECT IFNULL(role,'student') role FROM users WHERE id=?", (uid,))
    return (r["role"] if r else "student") or "student"


def is_teacher_token(token):
    """历史接口保留：陪伴者不再只读，此函数仅供旧调用点判断，不再用于拦截。"""
    uid = auth_uid(token)
    return bool(uid) and user_role(uid) == "teacher"


def is_admin(uid):
    """是否为管理员账号（role='admin'）。管理员在普通功能之外，额外拥有
    查看并管理其它账号（改名称/用户名/密码、删除）的权限。"""
    return bool(uid) and user_role(uid) == "admin"


def need_admin(token):
    """解析 token → 管理员账号 id；非管理员抛 Forbidden（上层转 403）。"""
    uid = need_uid(token)
    if not is_admin(uid):
        raise Forbidden()
    return uid


def link_ok(a, b):
    """陪伴关系是双向的：任一方建立后，双方都能看对方情况、也能互相推题。"""
    return bool(q_one("""SELECT 1 FROM teacher_links
                         WHERE (teacher_uid=? AND student_uid=?)
                            OR (teacher_uid=? AND student_uid=?)""", (a, b, b, a)))


# ---------- 陪读"正在答题"的实时状态（进程内存，单进程够用；120 秒没心跳即视为离线） ----------
_LIVE = {}
_LIVE_LOCK = threading.Lock()


def live_put(uid, data):
    with _LIVE_LOCK:
        _LIVE[uid] = dict(data, ts=int(time.time() * 1000))
        if len(_LIVE) > 400:      # 顺手清理一小时前的僵尸条目，别让字典无限涨
            cut = int(time.time() * 1000) - 3600_000
            for k in [k for k, v in _LIVE.items() if (v or {}).get("ts", 0) < cut]:
                _LIVE.pop(k, None)


def live_get(uid):
    with _LIVE_LOCK:
        d = _LIVE.get(uid)
    if not d:
        return None
    out = dict(d)
    out["age_ms"] = int(time.time() * 1000) - int(out.get("ts") or 0)
    # 只有「在答题」且心跳新鲜才算在线：切到别的页面后陪读端会主动报 idle
    out["online"] = out["age_ms"] < 120000 and out.get("status") == "answering"
    return out


def plain_text(h, n=80):
    """题目 HTML → 纯文本摘要（陪伴者的实时看板只需要一小段题干）。"""
    t = re.sub(r"<[^>]+>", " ", h or "")
    t = re.sub(r"\s+", " ", t).strip()
    return t[:n]


def ensure_user(uid):
    """确保账号存在；不存在则按默认名创建。返回用户行。"""
    r = q_one("SELECT * FROM users WHERE id=?", (uid,))
    if not r:
        db().execute("INSERT INTO users(id,name,created) VALUES(?,?,?)",
                     (uid, "用户" + uid[-1], now()))
        db().commit()
        r = q_one("SELECT * FROM users WHERE id=?", (uid,))
    return r


def init_user_srs(uid):
    """新账号初始化。
    只建账号行、不预铺 2.7 万行空白进度：以前注册要写满全库题量，
    在 180 万行的 users.db 上要一两秒且长时间占写锁 —— 既慢又是 locked 的温床。
    现在进度按需生成：取题时 auto_create=1 会给抽到的题建行，
    统计「新题剩余」用总数减已学，不再依赖预铺行。"""
    return 0


def ensure_srs_rows(uid, qids):
    """给指定题补齐空白进度行（已存在的跳过）。抽题/看详情时按需调用，
    一条语句完成、耗时毫秒级，取代过去注册时一次性铺 2.7 万行。"""
    qids = [q for q in (qids or []) if q]
    if not qids:
        return
    vals = ",".join("(?,?,?)" for _ in qids)
    args = []
    for q in qids:
        args += [q, uid, "new"]
    with _LOCK:
        try:
            db().execute("INSERT OR IGNORE INTO srs(qid,user_id,status) VALUES " + vals, args)
            db().commit()
        except Exception:
            db().rollback()
            raise


def learned_qids(uid):
    """该账号已接触过的 qid 集合（有进度行即算）。"""
    return {r["qid"] for r in q_all("SELECT qid FROM srs WHERE user_id=?", (uid,))}


def q_total():
    """题库总题数（进程内缓存，题库是只读的）。"""
    global _Q_TOTAL
    if _Q_TOTAL is None:
        _Q_TOTAL = q_one("SELECT COUNT(*) n FROM qdb.questions")["n"]
    return _Q_TOTAL


# ============ 云端账号：密码哈希 / token 鉴权 ============
def pw_hash(pw):
    salt = secrets.token_bytes(16)
    dk = hashlib.pbkdf2_hmac("sha256", pw.encode("utf-8"), salt, 200000)
    return f"{salt.hex()}$200000${dk.hex()}"


def pw_verify(pw, stored):
    try:
        salt_hex, it, hash_hex = stored.split("$")
        dk = hashlib.pbkdf2_hmac("sha256", pw.encode("utf-8"), bytes.fromhex(salt_hex), int(it))
        return secrets.compare_digest(dk.hex(), hash_hex)
    except Exception:
        return False


def new_token():
    return secrets.token_hex(24)


def cloud_uid(token):
    """由 token 反查云端账号 id（即用户名）；无效返回 None。"""
    if not token:
        return None
    r = q_one("SELECT id FROM cloud_accounts WHERE token=?", (token,))
    return r["id"] if r else None


# ============ 数据导出 / 导入（同步载体，支持本地与云端两套命名空间） ============
def _read_ns(prefix, uid_col, uid):
    """从指定命名空间（本地 srs / 云端 cloud_srs）读取某账号的全量业务数据。
    uid_col 为该命名空间的账号列名（本地为 user_id，云端为 uid）。"""
    return {
        "srs": q_all(f"""SELECT qid,status,ease,interval,repetitions,lapses,due,last_review,
                                correct,wrong,wb_status,wb_streak,last_choice
                         FROM {prefix}srs WHERE {uid_col}=?""", (uid,)),
        "reviews": q_all(f"""SELECT id,qid,grade,ts,interval_before,interval_after,ease,timeout
                           FROM {prefix}reviews WHERE {uid_col}=?""", (uid,)),
        "notes": q_all(f"SELECT qid,text,updated FROM {prefix}notes WHERE {uid_col}=?", (uid,)),
        "favorites": q_all(f"SELECT qid,added FROM {prefix}favorites WHERE {uid_col}=?", (uid,)),
        "doubt_status": q_all(f"SELECT qid,status,note,updated FROM {prefix}doubt_status WHERE {uid_col}=?", (uid,)),
        "exam_history": q_all(f"SELECT id,title,total,correct,score,duration,ts FROM {prefix}exam_history WHERE {uid_col}=?", (uid,)),
    }


def _write_ns(prefix, uid_col, uid, data):
    """把全量业务数据覆盖写入指定命名空间。全量覆盖（个人单用户、最后写入优先）。"""
    if not isinstance(data, dict):
        return
    with _LOCK:
        # 一次性长事务（原来逐表 commit，中途失败会留下半截数据）
        # srs：保留 qid 维度，按账号覆盖
        db().execute(f"DELETE FROM {prefix}srs WHERE {uid_col}=?", (uid,))
        for r in (data.get("srs") or []):
            db().execute(f"""INSERT OR REPLACE INTO {prefix}srs
                (qid,{uid_col},status,ease,interval,repetitions,lapses,due,last_review,
                 correct,wrong,wb_status,wb_streak,last_choice)
                VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                (r["qid"], uid, r.get("status", "new"), r.get("ease", 2.5), r.get("interval", 0),
                 r.get("repetitions", 0), r.get("lapses", 0), r.get("due"), r.get("last_review"),
                 r.get("correct", 0), r.get("wrong", 0), r.get("wb_status", "active"),
                 r.get("wb_streak", 0), r.get("last_choice")))
        db().execute(f"DELETE FROM {prefix}reviews WHERE {uid_col}=?", (uid,))
        for r in (data.get("reviews") or []):
            db().execute(f"""INSERT OR REPLACE INTO {prefix}reviews
                (id,qid,{uid_col},grade,ts,interval_before,interval_after,ease,timeout)
                VALUES(?,?,?,?,?,?,?,?,?)""",
                (r.get("id"), r.get("qid"), uid, r.get("grade"), r.get("ts"),
                 r.get("interval_before"), r.get("interval_after"), r.get("ease"), r.get("timeout", 0)))
        db().execute(f"DELETE FROM {prefix}notes WHERE {uid_col}=?", (uid,))
        for r in (data.get("notes") or []):
            db().execute(f"INSERT OR REPLACE INTO {prefix}notes(qid,{uid_col},text,updated) VALUES(?,?,?,?)",
                         (r["qid"], uid, r.get("text"), r.get("updated")))
        db().execute(f"DELETE FROM {prefix}favorites WHERE {uid_col}=?", (uid,))
        for r in (data.get("favorites") or []):
            db().execute(f"INSERT OR REPLACE INTO {prefix}favorites(qid,{uid_col},added) VALUES(?,?,?)",
                         (r["qid"], uid, r.get("added")))
        db().execute(f"DELETE FROM {prefix}doubt_status WHERE {uid_col}=?", (uid,))
        for r in (data.get("doubt_status") or []):
            db().execute(f"INSERT OR REPLACE INTO {prefix}doubt_status(qid,{uid_col},status,note,updated) VALUES(?,?,?,?,?)",
                         (r["qid"], uid, r.get("status"), r.get("note"), r.get("updated")))
        db().execute(f"DELETE FROM {prefix}exam_history WHERE {uid_col}=?", (uid,))
        for r in (data.get("exam_history") or []):
            db().execute(f"""INSERT OR REPLACE INTO {prefix}exam_history
                (id,title,total,correct,score,duration,ts,{uid_col}) VALUES(?,?,?,?,?,?,?,?)""",
                (r.get("id"), r.get("title"), r.get("total"), r.get("correct"),
                 r.get("score"), r.get("duration"), r.get("ts"), uid))
        db().commit()


def export_data(uid):
    """导出本地某账号（u1..u3）的全部学习数据。"""
    return _read_ns("", "user_id", uid)


def import_data(uid, data):
    """用 data 覆盖本地某账号的全部学习数据。"""
    _write_ns("", "user_id", uid, data)


def export_cloud(uid):
    """导出云端某账号的全部学习数据。"""
    return _read_ns("cloud_", "uid", uid)


def import_cloud(uid, data):
    """用 data 覆盖云端某账号的全部学习数据。"""
    _write_ns("cloud_", "uid", uid, data)


# ---------- 拆库迁移：旧版混合 kaogong.db → 纯题库 + users.db（一次性，幂等） ----------
USER_TABLES = ("users", "srs", "reviews", "notes", "favorites", "doubt_status", "settings",
               "exam_history", "cloud_accounts", "cloud_meta", "cloud_srs", "cloud_reviews",
               "cloud_notes", "cloud_favorites", "cloud_doubt_status", "cloud_exam_history")


def ensure_split():
    """首次以拆库版启动时自动迁移：把 kaogong.db 里的用户表搬到 users.db。
    单事务跨 ATTACH 库（SQLite 主日志保证原子），失败整体回滚；迁移后主库 VACUUM 收缩。
    不开 WAL——跨库原子性依赖回滚日志的 super-journal。"""
    if os.path.exists(USERS_DB_PATH):
        return  # 已拆分，幂等返回
    src = sqlite3.connect(DB_PATH, timeout=30)
    have = {r[0] for r in src.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    src.close()
    if "users" not in have:
        return  # 纯题库 + 全新用户 → ensure_tables 自建空用户库即可
    bak = DB_PATH + ".bak-" + datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
    shutil.copy2(DB_PATH, bak)
    print(f"[split] 备份原库 → {bak}")
    dst = sqlite3.connect(USERS_DB_PATH, timeout=30)
    dst.isolation_level = None  # 手动事务
    dst.execute("ATTACH DATABASE '%s' AS old" % DB_PATH.replace("'", "''"))
    try:
        dst.execute("BEGIN")
        for t in USER_TABLES:
            row = dst.execute("SELECT sql FROM old.sqlite_master WHERE type='table' AND name=?",
                              (t,)).fetchone()
            if not row:
                continue
            dst.execute(row[0])  # 原样 DDL 建入 users.db
            cols = ",".join(r[1] for r in dst.execute(f"PRAGMA old.table_info({t})"))
            dst.execute(f"INSERT INTO main.{t}({cols}) SELECT {cols} FROM old.{t}")
            n = dst.execute("SELECT changes()").fetchone()[0]
            print(f"[split] {t}: {n} 行")
        ph = ",".join("?" * len(USER_TABLES))
        for (sql,) in dst.execute("SELECT sql FROM old.sqlite_master WHERE type='index' "
                                  f"AND sql IS NOT NULL AND tbl_name IN ({ph})", USER_TABLES):
            dst.execute(sql)
        for t in USER_TABLES:
            dst.execute(f"DROP TABLE old.{t}")
        dst.execute("COMMIT")
    except Exception as e:
        dst.execute("ROLLBACK")
        dst.close()
        print(f"[split] 迁移失败已回滚（原库与 users.db 均未破坏）: {e}")
        sys.exit(1)
    dst.execute("DETACH DATABASE old")
    dst.close()
    v = sqlite3.connect(DB_PATH, timeout=30)
    v.execute("VACUUM")  # 事务外收缩主库
    v.close()
    print("[split] 题库/用户库拆分完成：kaogong.db(纯题库) + users.db")


def _warm():
    """启动预热：把首页要用的统计和整份 qid 列表先读一遍，让 OS 页缓存兜住冷读。"""
    try:
        q_all("SELECT qid FROM qdb.questions")
        q_all("SELECT module, COUNT(*) n FROM qdb.questions GROUP BY module")
    except Exception as e:
        print("[WARN] 预热失败（不影响服务）:", e)


def ensure_tables():
    migrate_v2.ensure(db())   # v2：多用户隔离 / 错题本字段 / 超时标记（幂等；含缺表兜底）
    db().executescript("""
    CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY, name TEXT, created TEXT);
    CREATE TABLE IF NOT EXISTS sessions(
        token TEXT PRIMARY KEY, uid TEXT NOT NULL, created TEXT);
    CREATE TABLE IF NOT EXISTS notes(
        qid TEXT PRIMARY KEY, text TEXT, updated TEXT);
    CREATE TABLE IF NOT EXISTS favorites(
        qid TEXT PRIMARY KEY, added TEXT);
    CREATE TABLE IF NOT EXISTS doubt_status(
        qid TEXT PRIMARY KEY, status TEXT, note TEXT, updated TEXT);
    CREATE TABLE IF NOT EXISTS settings(
        key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE IF NOT EXISTS user_settings(
        uid TEXT NOT NULL, key TEXT NOT NULL, value TEXT, PRIMARY KEY(uid,key));
    CREATE TABLE IF NOT EXISTS exam_history(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT, total INT, correct INT, score REAL, duration INT, ts TEXT);
    CREATE TABLE IF NOT EXISTS study_time(
        uid TEXT NOT NULL, day TEXT NOT NULL, ms INTEGER DEFAULT 0,
        PRIMARY KEY(uid, day));
    -- 丢弃的题：练习题里「我不想再做这道」的题，抽题时全部排除；
    -- 记录保留在这里，真题浏览的「已丢弃」列表里随时能找回并恢复。
    CREATE TABLE IF NOT EXISTS discarded(
        uid TEXT NOT NULL, qid TEXT NOT NULL, ts TEXT,
        PRIMARY KEY(uid, qid));
    """)
    if not q_one("SELECT value FROM settings WHERE key='daily_goal'"):
        db().execute("INSERT INTO settings(key,value) VALUES('daily_goal','120')")
    # 每日目标默认值由旧版 20 题调整为 120 题（只迁移一次，用户改过的值不再覆盖）
    if not q_one("SELECT value FROM settings WHERE key='goal_default_v2'"):
        cur = q_one("SELECT value FROM settings WHERE key='daily_goal'")
        if (not cur) or str(cur["value"]).strip() == '20':
            db().execute("INSERT OR REPLACE INTO settings(key,value) VALUES('daily_goal','120')")
        db().execute("INSERT OR REPLACE INTO settings(key,value) VALUES('goal_default_v2','1')")
    db().commit()
    # 游客(匿名)账号标记：anon=1 表示免注册账号，退出时一并清除数据
    try:
        db().execute("ALTER TABLE users ADD COLUMN anon INTEGER DEFAULT 0")
        db().commit()
    except Exception:
        pass
    # ---------- 陪伴者：不再是独立角色，而是普通账号的一个功能 ----------
    # 每个账号可自设 2-8 位「链接码」；别人用「用户名 + 链接码」即可加我为陪伴对象。
    # 保留 role 列兼容旧数据（旧 teacher 账号仍能登录，只是不再是只读角色）。
    try:
        db().execute("ALTER TABLE users ADD COLUMN link_code TEXT DEFAULT ''")
        db().commit()
    except Exception:
        pass
    # 推题：任意习题界面可把题目推给陪伴关系中的另一方（双向）。
    # from_uid/to_uid 是「谁推给谁」，qid 是题库 qid，note 是推题留言，read_ts 为接收方已读时间。
    db().executescript("""
    CREATE TABLE IF NOT EXISTS pushed_questions(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        from_uid TEXT NOT NULL,
        to_uid TEXT NOT NULL,
        qid TEXT NOT NULL,
        note TEXT DEFAULT '',
        ts TEXT,
        read_ts TEXT DEFAULT '');
    """)
    db().execute("CREATE INDEX IF NOT EXISTS idx_push_to ON pushed_questions(to_uid, id)")
    db().execute("CREATE INDEX IF NOT EXISTS idx_push_from ON pushed_questions(from_uid, id)")
    db().commit()
    # ---------- 陪伴者账号（只读督导）：role=teacher 的账号只能看，不能改 ----------
    try:
        db().execute("ALTER TABLE users ADD COLUMN role TEXT DEFAULT 'student'")
        db().commit()
    except Exception:
        pass
    db().executescript("""
    CREATE TABLE IF NOT EXISTS teacher_links(
        teacher_uid TEXT NOT NULL, student_uid TEXT NOT NULL, created TEXT,
        PRIMARY KEY(teacher_uid, student_uid));
    CREATE TABLE IF NOT EXISTS encouragements(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        teacher_uid TEXT NOT NULL,
        student_uid TEXT NOT NULL DEFAULT '*',
        text TEXT, image TEXT, ts TEXT);
    """)
    db().execute("CREATE INDEX IF NOT EXISTS idx_link_teacher ON teacher_links(teacher_uid)")
    db().execute("CREATE INDEX IF NOT EXISTS idx_link_student ON teacher_links(student_uid)")
    db().execute("CREATE INDEX IF NOT EXISTS idx_enc_student ON encouragements(student_uid, id)")
    # ---------- 寄语可回复：一条寄语 = 一个会话线程 ----------
    # parent_id=0 是陪伴者发的根留言，>0 是跟在这条留言下的往来消息；
    # role 记消息作者身份（teacher / student），teacher_uid 始终是「这条线程属于哪位陪伴者」，
    # 陪读的回复也照抄根的 teacher_uid，这样按陪伴者查列表的口径不用改。
    for _col, _ddl in (
        ("parent_id", "ALTER TABLE encouragements ADD COLUMN parent_id INTEGER DEFAULT 0"),
        ("author_uid", "ALTER TABLE encouragements ADD COLUMN author_uid TEXT DEFAULT ''"),
        ("role", "ALTER TABLE encouragements ADD COLUMN role TEXT DEFAULT 'teacher'"),
        ("read_ts", "ALTER TABLE encouragements ADD COLUMN read_ts TEXT DEFAULT ''"),
    ):
        try:
            db().execute(_ddl)
            db().commit()
        except Exception:
            pass
    db().execute("CREATE INDEX IF NOT EXISTS idx_enc_parent ON encouragements(parent_id, id)")
    # ---------- 今日回溯：一次练习 = 一组，逐题记录「对答案那一刻」的选择与正误 ----------
    # practice_groups 记组（模式 / 范围 / 起止时间），practice_items 记组内每题的状态。
    # 先答后对交卷时才判分，因此这里存的是交卷瞬间的选择，之后再怎么复看/自评都不会改它。
    db().executescript("""
    CREATE TABLE IF NOT EXISTS practice_groups(
        gid TEXT PRIMARY KEY,
        uid TEXT NOT NULL,
        mode TEXT,
        answer_mode TEXT,
        title TEXT,
        scope TEXT,
        size INTEGER DEFAULT 0,
        started TEXT,
        ended TEXT,
        total_ms INTEGER DEFAULT 0,
        state TEXT DEFAULT 'open');
    CREATE TABLE IF NOT EXISTS practice_items(
        gid TEXT NOT NULL,
        uid TEXT NOT NULL,
        qid TEXT NOT NULL,
        pos INTEGER DEFAULT 0,
        choice TEXT,
        answer TEXT,
        correct INTEGER DEFAULT 0,
        timeout INTEGER DEFAULT 0,
        ms INTEGER DEFAULT 0,
        graded_at TEXT,
        PRIMARY KEY(gid, qid));
    """)
    db().execute("CREATE INDEX IF NOT EXISTS idx_pg_uid_day ON practice_groups(uid, started)")
    db().execute("CREATE INDEX IF NOT EXISTS idx_pi_gid ON practice_items(gid, pos)")
    db().commit()
    # ---------- 云端账号体系（与本地纯昵称账号并存，互不影响） ----------
    db().executescript("""
    CREATE TABLE IF NOT EXISTS cloud_accounts(
        id TEXT PRIMARY KEY, username TEXT UNIQUE,
        pw_hash TEXT, token TEXT, created TEXT);
    CREATE TABLE IF NOT EXISTS cloud_meta(uid TEXT PRIMARY KEY, last_sync TEXT);
    CREATE TABLE IF NOT EXISTS cloud_srs(
        qid TEXT NOT NULL, uid TEXT NOT NULL,
        status TEXT DEFAULT 'new', ease REAL DEFAULT 2.5,
        interval INTEGER DEFAULT 0, repetitions INTEGER DEFAULT 0,
        lapses INTEGER DEFAULT 0, due TEXT, last_review TEXT,
        correct INTEGER DEFAULT 0, wrong INTEGER DEFAULT 0,
        wb_status TEXT DEFAULT 'active', wb_streak INTEGER DEFAULT 0,
        last_choice TEXT, PRIMARY KEY(qid, uid));
    CREATE TABLE IF NOT EXISTS cloud_reviews(
        id INTEGER PRIMARY KEY AUTOINCREMENT, qid TEXT, uid TEXT NOT NULL,
        grade INT, ts TEXT, interval_before INT, interval_after INT, ease REAL,
        timeout INTEGER DEFAULT 0);
    CREATE TABLE IF NOT EXISTS cloud_notes(
        qid TEXT NOT NULL, uid TEXT NOT NULL, text TEXT, updated TEXT,
        PRIMARY KEY(qid, uid));
    CREATE TABLE IF NOT EXISTS cloud_favorites(
        qid TEXT NOT NULL, uid TEXT NOT NULL, added TEXT, PRIMARY KEY(qid, uid));
    CREATE TABLE IF NOT EXISTS cloud_doubt_status(
        qid TEXT NOT NULL, uid TEXT NOT NULL, status TEXT, note TEXT, updated TEXT,
        PRIMARY KEY(qid, uid));
    CREATE TABLE IF NOT EXISTS cloud_exam_history(
        id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT, total INT, correct INT,
        score REAL, duration INT, ts TEXT, uid TEXT);
    CREATE INDEX IF NOT EXISTS idx_cloud_srs ON cloud_srs(uid);
    CREATE INDEX IF NOT EXISTS idx_cloud_rev ON cloud_reviews(uid);
    """)


# ---------- 管理员基线：一次性清空所有账号，仅保留 admin/123456 ----------
# 需求：初始化时清空当前所有账号，仅新增管理员账号（用户名 admin / 密码 123456）。
# 关键约束（防止其它 agent 误操作导致线上数据被清）：
#   · 幂等 & 一次性：用 settings 里的标志位 `admin_baseline_done` 记录已执行，之后永不再清；
#   · 可逆：清空前强制对用户库做一份带标签的快照（data/backups/users-*-prebaseline.db），
#     万一是误触发，也能从快照恢复；
#   · 可关闭：设环境变量 KAOGONG_SKIP_BASELINE=1 可整段跳过（迁移/排障时用）。
# 若后续需要「再次强制重置为仅 admin」，请显式设 KAOGONG_FORCE_BASELINE=1 启动一次。
ADMIN_USERNAME = "admin"
ADMIN_PASSWORD = "123456"
_USER_SCOPED_TABLES_UID = ("study_time", "discarded", "user_settings", "sessions",
                           "practice_items", "practice_groups")
_USER_SCOPED_TABLES_USERID = ("srs", "reviews", "notes", "favorites",
                              "doubt_status", "exam_history")


def _wipe_all_accounts():
    """清空所有账号及其全部业务数据（题库 kaogong.db 只读、完全不动）。"""
    c = db()
    for t in _USER_SCOPED_TABLES_USERID:
        try:
            c.execute(f"DELETE FROM {t}")
        except Exception:
            pass
    for t in _USER_SCOPED_TABLES_UID:
        try:
            c.execute(f"DELETE FROM {t}")
        except Exception:
            pass
    for t in ("teacher_links", "pushed_questions", "encouragements",
              "cloud_accounts", "cloud_meta", "cloud_srs", "cloud_reviews",
              "cloud_notes", "cloud_favorites", "cloud_doubt_status", "cloud_exam_history"):
        try:
            c.execute(f"DELETE FROM {t}")
        except Exception:
            pass
    c.execute("DELETE FROM users")


def ensure_admin_baseline():
    """一次性基线初始化：清空当前所有账号，仅新增管理员账号 admin/123456。

    幂等：只在首次（标志位未写）或显式 KAOGONG_FORCE_BASELINE=1 时执行；
    其余任何启动都只做「确保 admin 存在且为 admin 角色」的温和补齐，绝不清库。"""
    if os.environ.get("KAOGONG_SKIP_BASELINE") == "1":
        return
    done = get_setting("admin_baseline_done")
    force = os.environ.get("KAOGONG_FORCE_BASELINE") == "1"
    existing = q_one("SELECT COUNT(*) n FROM users")
    # Upgrade safety: an unmarked but populated legacy DB is not a fresh install.
    # Preserve its accounts and records; only add admin and mark baseline complete.
    if not done and not force and existing and existing["n"] > 0:
        existing_admin = q_one("SELECT id FROM users WHERE IFNULL(role,'student')='admin' LIMIT 1")
        if not existing_admin:
            with _LOCK:
                db().execute(
                    "INSERT INTO users(id,name,username,pw_hash,token,created,anon,role) "
                    "VALUES(?,?,?,?,?,?,0,'admin')",
                    ("u" + secrets.token_hex(8), "管理员", ADMIN_USERNAME,
                     pw_hash(ADMIN_PASSWORD), "", now()))
                db().commit()
        else:
            with _LOCK:
                db().execute("UPDATE users SET role='admin' WHERE id=?", (existing_admin["id"],))
                db().commit()
        with _LOCK:
            db().execute("INSERT OR REPLACE INTO settings(key,value) VALUES('admin_baseline_done',?)", (now(),))
            db().commit()
        print("[baseline] 检测到已有账号数据，升级安全模式已保留原账号并补建 admin")
        return
    if done and not force:
        # 已初始化过：仅兜底保证 admin 账号存在（被误删时自动重建，不动其它账号）
        if not q_one("SELECT 1 FROM users WHERE username=?", (ADMIN_USERNAME,)):
            with _LOCK:
                db().execute(
                    "INSERT INTO users(id,name,username,pw_hash,token,created,anon,role) "
                    "VALUES(?,?,?,?,?,?,0,'admin')",
                    ("u" + secrets.token_hex(8), "管理员", ADMIN_USERNAME,
                     pw_hash(ADMIN_PASSWORD), "", now()))
                db().commit()
            print("[baseline] 检测到 admin 缺失，已重建管理员账号（未触碰其它账号）")
        else:
            # 确保既有 admin 账号的角色是 admin（历史数据兜底）
            with _LOCK:
                db().execute("UPDATE users SET role='admin' WHERE username=?", (ADMIN_USERNAME,))
                db().commit()
        return
    # 首次 / 强制：清空前必须留一份可恢复快照，失败时绝不清库。
    snap = _snapshot_user_db(force=True, tag="-prebaseline")
    if os.path.exists(USERS_DB_PATH) and os.path.getsize(USERS_DB_PATH) > 0 and not snap:
        raise RuntimeError("管理员基线初始化已取消：无法创建清库前快照")
    with _LOCK:
        try:
            _wipe_all_accounts()
            db().execute(
                "INSERT INTO users(id,name,username,pw_hash,token,created,anon,role) "
                "VALUES(?,?,?,?,?,?,0,'admin')",
                ("u" + secrets.token_hex(8), "管理员", ADMIN_USERNAME,
                 pw_hash(ADMIN_PASSWORD), "", now()))
            db().execute("INSERT OR REPLACE INTO settings(key,value) VALUES('admin_baseline_done',?)",
                         (now(),))
            db().commit()
        except Exception:
            db().rollback()
            raise
    print(f"[baseline] 已清空所有账号并重建管理员：{ADMIN_USERNAME}/{ADMIN_PASSWORD}")


def get_setting(key, default=None):
    r = q_one("SELECT value FROM settings WHERE key=?", (key,))
    return r["value"] if r else default


def _backup_config():
    raw = get_setting("backup_local_path", "") or ""
    return {"path": os.path.abspath(os.path.expanduser(raw)) if raw else ""}


def _list_user_snapshots():
    files = []
    dirs = [BACKUP_DIR]
    local = _backup_config().get("path")
    if local and os.path.isdir(local):
        dirs.append(local)
    seen = set()
    for folder in dirs:
        try:
            for name in os.listdir(folder):
                full = os.path.join(folder, name)
                if name.startswith("users-") and name.endswith(".db") and os.path.isfile(full):
                    mtime = os.path.getmtime(full)
                    location = "local" if folder == local else "server"
                    if name in seen:
                        for item in files:
                            if item["name"] == name and location == "local":
                                item["location"] = "server + local"
                                break
                        continue
                    seen.add(name)
                    files.append({"name": name, "size": os.path.getsize(full), "mtime": mtime,
                                  "location": location})
        except OSError:
            continue
    return sorted(files, key=lambda x: x["mtime"], reverse=True)


def set_setting(key, value):
    db().execute("INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)", (key, str(value)))


def _delete_account_data(uid):
    for table, col in (("srs", "user_id"), ("reviews", "user_id"), ("notes", "user_id"),
                       ("favorites", "user_id"), ("doubt_status", "user_id"), ("exam_history", "user_id"),
                       ("practice_items", "uid"), ("practice_groups", "uid"), ("study_time", "uid"),
                       ("discarded", "uid"), ("user_settings", "uid"), ("sessions", "uid")):
        db().execute("DELETE FROM %s WHERE %s=?" % (table, col), (uid,))
    db().execute("DELETE FROM teacher_links WHERE teacher_uid=? OR student_uid=?", (uid, uid))
    db().execute("DELETE FROM pushed_questions WHERE from_uid=? OR to_uid=?", (uid, uid))
    db().execute("DELETE FROM encouragements WHERE teacher_uid=? OR student_uid=?", (uid, uid))


def get_user_setting(uid, key, default=None):
    """按账号读取设置，缺省回落到全局默认值（每日目标等必须按账号隔离，否则多账号互相影响）。"""
    r = q_one("SELECT value FROM user_settings WHERE uid=? AND key=?", (uid, key))
    return r["value"] if r else default


def set_user_setting(uid, key, value):
    db().execute("INSERT OR REPLACE INTO user_settings(uid,key,value) VALUES(?,?,?)",
                 (uid, key, str(value)))

def resolve_qid(qid_int):
    r = q_one("SELECT qid FROM qdb.questions WHERE id=?", (qid_int,))
    return r["qid"] if r else None


def discarded_qids(uid):
    """当前账号丢弃过的 qid 列表（qid 是纯数字文本）。"""
    try:
        return [str(r["qid"]) for r in q_all("SELECT qid FROM discarded WHERE uid=?", (uid,))]
    except Exception:
        return []


def discard_filter(uid, alias="q"):
    """抽题时排除丢弃的题。

    qid 全是数字文本，这里直接内联成字面量：省掉占位符与各分支参数顺序的纠缠，
    也让这段条件可以安全拼进任意一条已有 SQL（cond 是纯字符串拼接）。
    alias 传空串即用于没有表别名的查询（FROM qdb.questions 直接写 qid）。
    """
    ids = [x for x in discarded_qids(uid) if re.fullmatch(r"\d+", x)]
    if not ids:
        return ""
    col = (alias + ".") if alias else ""
    return " AND %sqid NOT IN (%s)" % (col, ",".join("'%s'" % x for x in ids))

# 练习阶段对题干/材料做答案剧透清洗，避免直接泄露正确选项字母
_ANS_LEAK_PATTERNS = [
    # 负向断言(?!\s*项)：避免误伤题干设问，如"正确答案为D项的题目有多少道？"
    re.compile(r"正确答案[是为：: ]*[A-F](?!\s*项)"),
    re.compile(r"本题(的)?答案[是为：: ]*[A-F]"),
    re.compile(r"答案选[是为：: ]*[A-F]"),
    re.compile(r"应选[择：: ]*[A-F]"),
    re.compile(r"应当?选[择：: ]*[A-F]"),
    re.compile(r"因此?选[是为：: ]*[A-F]"),
    re.compile(r"故(而)?选[是为：: ]*[A-F]"),
]


def mask_answer_leak(text):
    """把题干/材料里直接点出正确选项的句式替换为占位，避免练习时剧透。
    仅作用于做题阶段(reveal=False)；作答后看解析(reveal=True)保留原文。"""
    if not text:
        return text
    for p in _ANS_LEAK_PATTERNS:
        text = p.sub("【答案已隐藏】", text)
    return text


# ---- 整块泄露剥离：材料里混入的「疑点/官方解析」备注会直接写出"答案X" ----
# Obsidian callout 块：'> [!warning] 标题' 及其后续连续的 '>' 行
_LEAK_CALLOUT = re.compile(r"^[ \t]*>[^\n]*(?:\n[ \t]*>[^\n]*)*", re.M)
# HTML 引用块
_LEAK_BLOCKQUOTE = re.compile(r"<blockquote\b[\s\S]*?</blockquote>", re.I)
# 行内强解析信号（用于兜底清理不带 callout 标记的裸解析段落）
_LEAK_LINE = re.compile(
    r"(官方解析|疑点|待人工复核|人工复核"
    r"|不影响\s*(正确)?答案|不影响结论|不影响本题"
    r"|与答案\s*[：:]?\s*[A-F]|答案\s*[：:]?\s*[A-F]\s*(无误|一致|不受影响)"
    r"|以\s*[A-F]\s*作答为准|解析笔误|应为笔误|结论\s*无误)")


def strip_leak_blocks(text):
    """剥离材料里混入的解析/疑点备注块（做题阶段调用）。
    这些块形如 '> [!warning] 疑点（官方解析可能有误…）' 并在正文中直接写明"答案B"，
    属于解析范畴，作答前展示等于剧透。看解析(reveal=True)时保留原文。"""
    if not text:
        return text
    s = _LEAK_BLOCKQUOTE.sub("", text)
    s = _LEAK_CALLOUT.sub("", s)          # 覆盖 190 条 callout 材料
    # 兜底：整行含强解析信号的（且不含图片标签）直接剔除，避免裸解析段落残留
    out = []
    for line in s.split("\n"):
        plain = re.sub(r"<[^>]+>", "", line)
        if plain.strip() and not re.search(r"<img|<p>|</p>", line, re.I) \
                and _LEAK_LINE.search(plain):
            continue
        out.append(line)
    s = "\n".join(out)
    s = re.sub(r"\n{3,}", "\n\n", s).strip()
    return s


def safe_material(text, mask=True):
    """做题阶段展示材料：先剥离泄露块，再打码残留句式。"""
    if not text:
        return text
    s = strip_leak_blocks(text)
    return mask_answer_leak(s) if mask else s


def clean_card(row, reveal=False, uid=DEFAULT_UID):
    d = {
        "id": row["id"], "qid": row["qid"], "module": row["module"],
        "category": row["category"], "kadian": row["kadian"],
        "region": row["region"], "year": row["year"], "paper": row["paper"],
        "ask_model": row["ask_model"],
        # 做题阶段(reveal=False)才清洗；看解析时还原原题原文
        "stem": mask_answer_leak(row["stem"]) if not reveal else row["stem"],
        "options": json.loads(row["options"] or "[]"),
        "material": safe_material(row["material"]) if not reveal else row["material"],
        "material_ref": row.get("material_ref", ""),
    }
    if not reveal:
        for o in d["options"]:
            o["is_answer"] = False
    else:
        d.update({
            "answer": row["answer"], "reasoning": row["reasoning"],
            "fastest": row["fastest"], "pitfalls": row["pitfalls"],
            "mother": row["mother"], "analysis": row["analysis"],
            "doubt": clean_doubt(row["doubt"]), "related": row["related"],
        })
        eqid = row["qid"]
        nt = q_one("SELECT text,updated FROM notes WHERE qid=? AND user_id=?", (eqid, uid))
        d["note"] = nt["text"] if nt else ""
        d["note_updated"] = nt["updated"] if nt else ""
        d["fav"] = 1 if q_one("SELECT qid FROM favorites WHERE qid=? AND user_id=?", (eqid, uid)) else 0
        ds = q_one("SELECT status,note FROM doubt_status WHERE qid=? AND user_id=?", (eqid, uid))
        d["doubt_status"] = ds["status"] if ds else ""
        d["srs_wrong"] = (q_one("SELECT wrong FROM srs WHERE qid=? AND user_id=?", (eqid, uid)) or {}).get("wrong", 0)
    vr = q_one("SELECT * FROM qdb.review_verified WHERE qid=?", (row["qid"],))
    if vr:
        # 做题阶段仅给"已复核"标记，不剧透答案；作答后(reveal)才给完整核实详情
        d["verified"] = {"status": vr["status"]} if not reveal else {
            "status": vr["status"], "answer": vr["verified_answer"],
            "supplement": vr["supplement"], "source_name": vr["source_name"],
            "source_url": vr["source_url"], "reasoning": vr["reasoning"],
        }
    else:
        d["verified"] = None
    return d

def plain_text(html, n=None):
    """题干/材料去 HTML 标签，取纯文本（导出与搜索摘要用）。"""
    s = re.sub(r"<[^>]+>", " ", html or "")
    s = re.sub(r"&(nbsp|amp|lt|gt|quot);?", " ", s)
    s = re.sub(r"\s+", " ", s).strip()
    return s[:n] if n else s


def brief_text(html, n=None):
    """给陪伴者看板用的摘要：图片留一个占位，别让图形题/带图材料变成空白。"""
    s = re.sub(r"<img[^>]*>", " ［图］ ", html or "", flags=re.I)
    s = re.sub(r"<br\s*/?>", "\n", s, flags=re.I)
    s = re.sub(r"</(p|div|li|tr)>", "\n", s, flags=re.I)
    s = re.sub(r"<[^>]+>", " ", s)
    s = re.sub(r"&(nbsp|amp|lt|gt|quot);?", " ", s)
    s = re.sub(r"[ \t]+", " ", s)
    s = re.sub(r"\n\s*\n+", "\n", s).strip()
    return s[:n] if n else s


_DOUBT_HEAD = re.compile(r"^\s*\[![a-zA-Z]+\]\s*(疑点\s*（[^）]*）\s*)?", re.I)


def clean_doubt(s):
    """疑点正文来自题库的 Obsidian callout，去掉 '[!warning] 疑点（官方解析可能有误，待人工复核）'
    这类给编辑器看的前缀，只留真正的疑点内容。"""
    t = _DOUBT_HEAD.sub("", (s or "").strip()).strip()
    return t or (s or "").strip()


def build_where(module, category, kadian):
    cond, args = [], []
    if module:
        cond.append("q.module=?"); args.append(module)
    if category:
        cond.append("q.category=?"); args.append(category)
    if kadian:
        cond.append("q.kadian LIKE ?"); args.append("%" + kadian + "%")
    return (" AND " + " AND ".join(cond)) if cond else "", args


# ============ 只读运营面板（/ops）============
# 设计约束：
# 1. 口令只从环境变量 OPS_TOKEN 取，不落库、不进代码库；未配置则整个面板不可用（默认关闭）。
# 2. 会话令牌只存在进程内存（重启即失效），与用户 token 体系完全隔离 —— 普通用户 token 进不来。
# 3. 全部接口只读：只做 SELECT，没有任何写库路径。
OPS_TOKEN = (os.environ.get("OPS_TOKEN") or "").strip()
_OPS_SESS = {}            # sid -> (expire_ts, ua_hash)
_OPS_TTL = 8 * 3600
_OPS_TRIES = {}           # ip -> [timestamps]，失败口令限流
_OPS_HIDE_ANON = os.environ.get("OPS_HIDE_ANON", "1") != "0"   # 默认不把游客算进活跃


def ops_enabled():
    """口令至少 16 位才启用 —— 短口令等同没口令，宁可面板不可用。"""
    return len(OPS_TOKEN) >= 16


def _ops_rate_ok(ip):
    """同一 IP 10 分钟内最多 8 次失败，防暴力猜口令。"""
    now_ts = time.time()
    lst = [t for t in _OPS_TRIES.get(ip, []) if now_ts - t < 600]
    _OPS_TRIES[ip] = lst
    return len(lst) < 8


def _ops_fail(ip):
    _OPS_TRIES.setdefault(ip, []).append(time.time())


def ops_issue():
    sid = secrets.token_urlsafe(32)
    _OPS_SESS[sid] = (time.time() + _OPS_TTL, None)
    if len(_OPS_SESS) > 32:      # 会话上限，防内存被刷
        for k in sorted(_OPS_SESS, key=lambda k: _OPS_SESS[k][0])[:len(_OPS_SESS) - 32]:
            _OPS_SESS.pop(k, None)
    return sid


def ops_check(sid):
    rec = _OPS_SESS.get(sid or "")
    if not rec:
        return False
    if rec[0] < time.time():
        _OPS_SESS.pop(sid, None)
        return False
    return True


def ops_drop(sid):
    _OPS_SESS.pop(sid or "", None)


def ops_overview(days=30):
    days = max(1, min(365, int(days)))
    anon_cond = " AND IFNULL(u.anon,0)=0" if _OPS_HIDE_ANON else ""
    t = today()
    c = db()
    one = lambda sql, a=(): (c.execute(sql, a).fetchone() or [0])[0]

    # --- 账号 ---
    total_users = one("SELECT COUNT(*) FROM users")
    real_users = one("SELECT COUNT(*) FROM users WHERE IFNULL(anon,0)=0")
    anon_users = total_users - real_users
    new_today = one("SELECT COUNT(*) FROM users WHERE date(created)=?", (t,))
    new_7 = one("SELECT COUNT(*) FROM users WHERE date(created)>=date(?,'-6 day')", (t,))

    # --- 活跃（有答题记录 = 真学过的证据）---
    def active_users(d0):
        return one(f"""SELECT COUNT(DISTINCT r.user_id) FROM reviews r JOIN users u ON u.id=r.user_id
                       WHERE date(r.ts)>=date(?,'-{d0} day'){anon_cond}""", (t,))
    act_today = one(f"""SELECT COUNT(DISTINCT r.user_id) FROM reviews r JOIN users u ON u.id=r.user_id
                        WHERE date(r.ts)=?{anon_cond}""", (t,))
    act_7, act_30 = active_users(6), active_users(29)

    # --- 答题量 ---
    ans_today = one("SELECT COUNT(*) FROM reviews WHERE date(ts)=?", (t,))
    ans_7 = one("SELECT COUNT(*) FROM reviews WHERE date(ts)>=date(?,'-6 day')", (t,))
    ans_all = one("SELECT COUNT(*) FROM reviews")

    # --- 日期轴先铺满（没数据的日期补 0），否则柱子会挤在一侧、刻度也对不上 ---
    d0 = (datetime.date.today() - datetime.timedelta(days=days - 1)).isoformat()
    axis = [(datetime.date.fromisoformat(d0) + datetime.timedelta(days=i)).isoformat()
            for i in range(days)]

    # --- 每日趋势 ---
    rows = {r["d"]: dict(r) for r in c.execute(f"""
        SELECT date(r.ts) d, COUNT(DISTINCT r.user_id) users, COUNT(*) answers,
               SUM(CASE WHEN r.grade>=3 THEN 1 ELSE 0 END) right_n
        FROM reviews r JOIN users u ON u.id=r.user_id
        WHERE date(r.ts)>=date(?,'-{days - 1} day'){anon_cond}
        GROUP BY d ORDER BY d""", (t,))}
    trend = [rows.get(d) or {"d": d, "users": 0, "answers": 0, "right_n": 0} for d in axis]

    # --- 新增账号趋势 ---
    rrows = {r["d"]: dict(r) for r in c.execute(f"""
        SELECT date(u.created) d, COUNT(*) n,
               SUM(CASE WHEN IFNULL(u.anon,0)=0 THEN 1 ELSE 0 END) real_n
        FROM users u WHERE date(u.created)>=date(?,'-{days - 1} day')
        GROUP BY d ORDER BY d""", (t,))}
    reg = [rrows.get(d) or {"d": d, "n": 0, "real_n": 0} for d in axis]

    # --- 用户粘性分布 ---
    stick = [dict(r) for r in c.execute(f"""
        SELECT CASE WHEN n>=100 THEN '100+ 题' WHEN n>=30 THEN '30-99 题'
                    WHEN n>=10 THEN '10-29 题' WHEN n>=1 THEN '1-9 题' ELSE '0 题' END b,
               COUNT(*) n FROM (
            SELECT u.id, COUNT(r.user_id) n FROM users u
            LEFT JOIN reviews r ON r.user_id=u.id WHERE 1=1{anon_cond} GROUP BY u.id)
        GROUP BY b""")]

    # --- 最近活跃账号（只显示昵称与量级，不含任何学习内容）---
    recent = [dict(r) for r in c.execute(f"""
        SELECT u.name, IFNULL(u.anon,0) anon, MAX(r.ts) last_ts, COUNT(*) answers
        FROM reviews r JOIN users u ON u.id=r.user_id
        WHERE date(r.ts)>=date(?,'-6 day'){anon_cond}
        GROUP BY u.id ORDER BY last_ts DESC LIMIT 12""", (t,))]

    return {
        "today": t,
        "accounts": {"total": total_users, "real": real_users, "anon": anon_users,
                     "new_today": new_today, "new_7": new_7},
        "active": {"today": act_today, "d7": act_7, "d30": act_30},
        "answers": {"today": ans_today, "d7": ans_7, "all": ans_all},
        "trend": trend, "reg": reg, "stick": stick, "recent": recent,
        "scope": "正式账号" if _OPS_HIDE_ANON else "含游客",
    }


# 完整性自检很贵：1.8GB 的 users.db 上 PRAGMA quick_check 实测要分钟级，
# 且 journal_mode=delete 下它会持共享锁把并发写全堵住（曾导致游客登录 database is locked）。
# 结论：这个操作不属于 HTTP 请求，也不该跟服务跑在同一个连接/线程里。
# 做法：接口只报告 state 文件；真正的检查由独立进程（运维脚本/低峰期 cron）写文件。
_INTEG_FILE = os.path.join(HERE, "kaogong-integrity.json")
_INTEG_CACHE = {"mtime": None, "data": None}


def _integrity_read():
    """读最近一次自检结果（独立进程写入的文件），带 mtime 缓存，绝不触发实际检查。"""
    try:
        st = os.stat(_INTEG_FILE)
    except Exception:
        return {"state": "未执行", "at": None, "took": None,
                "how": "由服务器定时任务或手动执行 check_integrity.py 生成"}
    if _INTEG_CACHE["mtime"] == st.st_mtime:
        return _INTEG_CACHE["data"]
    try:
        with open(_INTEG_FILE, encoding="utf-8") as f:
            data = json.load(f)
    except Exception as e:
        data = {"state": "读取失败: " + str(e)[:60], "at": None, "took": None}
    _INTEG_CACHE.update(mtime=st.st_mtime, data=data)
    return data


def ops_health():
    """题库与库文件健康度（只读，全部走计数与缓存，不做重活）。"""
    c = db()
    out = {"questions": q_one("SELECT COUNT(*) n FROM qdb.questions")["n"]}
    ig = _integrity_read()
    out["integrity"] = ig.get("state") or "未执行"
    out["integrity_at"] = ig.get("at")
    out["integrity_took"] = ig.get("took")
    try:
        out["users_db_mb"] = round(os.path.getsize(USERS_DB_PATH) / 1048576)
        out["qbank_mb"] = round(os.path.getsize(DB_PATH) / 1048576)
    except Exception:
        pass
    out["srs_rows"] = q_one("SELECT COUNT(*) n FROM srs")["n"]
    out["no_analysis"] = q_one("SELECT COUNT(*) n FROM qdb.questions WHERE IFNULL(analysis,'')=''")["n"]
    out["no_image_flag"] = q_one("SELECT COUNT(*) n FROM qdb.questions WHERE has_image=1")["n"]
    out["by_module"] = q_all("SELECT module m, COUNT(*) n FROM qdb.questions GROUP BY module ORDER BY n DESC")
    out["db_journal_mode"] = c.execute("PRAGMA journal_mode").fetchone()[0]
    out["ops_scope"] = "正式账号" if _OPS_HIDE_ANON else "含游客"
    return out


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *a):
        pass

    # gzip 压缩结果缓存（静态文件按 path+mtime 复用，避免每请求重复压缩）
    _GZ_CACHE = {}
    _GZ_TYPES = ("text/", "application/json", "application/javascript")

    def _send(self, code, body, ctype="application/json; charset=utf-8", extra=None, gz_key=None):
        if isinstance(body, (dict, list)):
            body = json.dumps(body, ensure_ascii=False).encode("utf-8")
        elif isinstance(body, str):
            body = body.encode("utf-8")
        self.send_response(code)
        # gzip：文本类响应 + 客户端支持 + 超过阈值才压（304/HEAD/小响应自动跳过）；
        # 必须在 send_response（状态行）之后、end_headers 之前发头
        if (code == 200 and gz_key is not False and len(body) > 512
                and "gzip" in (self.headers.get("Accept-Encoding") or "").lower()
                and any(t in ctype for t in self._GZ_TYPES)):
            if gz_key:
                hit = self._GZ_CACHE.get(gz_key)
                if hit and hit[0] == gz_key[1]:
                    body = hit[1]
                else:
                    body = gzip.compress(body, 6)
                    if len(self._GZ_CACHE) > 64:
                        self._GZ_CACHE.clear()
                    self._GZ_CACHE[gz_key] = (gz_key[1], body)
            else:
                body = gzip.compress(body, 6)
            self.send_header("Content-Encoding", "gzip")
            self.send_header("Vary", "Accept-Encoding")
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        # 跨域：云端服务器常与本机应用不同源（不同主机/端口），需放行 CORS
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        # 默认禁用缓存；但若 extra 已提供 Cache-Control（如静态资源/图片长缓存），
        # 则不再叠加 no-store，避免两个 Cache-Control 头互相冲突导致缓存失效。
        if not extra or "Cache-Control" not in extra:
            self.send_header("Cache-Control", "no-store")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _download_file(self, path, filename):
        """流式下载受保护的数据库快照，避免大用户库被整体读入内存。"""
        try:
            size = os.path.getsize(path)
            stream = open(path, "rb")
        except OSError:
            return self._send(404, {"error": "备份文件不存在"})
        self.send_response(200)
        self.send_header("Content-Type", "application/octet-stream")
        self.send_header("Content-Length", str(size))
        self.send_header("Content-Disposition", 'attachment; filename="%s"' % filename)
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        if self.command != "HEAD":
            try:
                shutil.copyfileobj(stream, self.wfile, 1024 * 1024)
            except (BrokenPipeError, ConnectionResetError):
                pass
        stream.close()

    def _file(self, path, cache=True, max_age=86400, revalidate=False):
        """发送磁盘文件；静态资源/图片默认长缓存(强缓存+ETag+304)，
        避免资料分析材料展开时几十张公式图反复向服务端拉取导致卡顿。
        revalidate=True → 只发 `no-cache`（仍带 ETag，未变更返回 304），
        用于 index.html / app.js / style.css，保证改版后浏览器立即拿到新文件。"""
        try:
            st = os.stat(path)
        except Exception:
            return self._send(404, {"error": "not found"})
        with open(path, "rb") as f:
            data = f.read()
        ctype = mimetypes.guess_type(path)[0] or "application/octet-stream"
        if ctype.startswith("text/"):
            ctype += "; charset=utf-8"
        extra = {}
        if cache:
            etag = f'"{st.st_size:x}-{int(st.st_mtime):x}"'
            extra["Cache-Control"] = "no-cache" if revalidate else f"public, max-age={max_age}"
            extra["Last-Modified"] = email.utils.formatdate(st.st_mtime, usegmt=True)
            extra["ETag"] = etag
            inm = self.headers.get("If-None-Match")
            ims = self.headers.get("If-Modified-Since")
            if inm and inm.strip('"') == etag.strip('"'):
                return self._send(304, b"", extra=extra)
            if ims and not inm:
                try:
                    its = email.utils.parsedate_to_datetime(ims)
                    if its.tzinfo is None:
                        its = its.replace(tzinfo=datetime.timezone.utc)
                    if st.st_mtime <= its.timestamp() + 1:
                        return self._send(304, b"", extra=extra)
                except Exception:
                    pass
        self._send(200, data, ctype, extra=extra, gz_key=(path, int(st.st_mtime)))

    def do_GET(self):
        u = urllib.parse.urlparse(self.path)
        path = urllib.parse.unquote(u.path)
        qs = urllib.parse.parse_qs(u.query)
        g = lambda k, d="": (qs.get(k) or [d])[0]

        if path == "/" or path == "/index.html":
            return self._file(os.path.join(STATIC, "index.html"), cache=True, revalidate=True)
        if path == "/ops" or path == "/ops/":
            # 未配置口令 → 404，连"这里有个后台"都不暴露
            if not ops_enabled():
                return self._send(404, {"error": "no route"})
            fp = os.path.join(OPS_DIR, "index.html")
            return self._file(fp, cache=False)
        if path.startswith("/ops/api/"):
            return self.ops_api(path[len("/ops/api/"):], g)

        if path == "/favicon.ico":
            return self._send(200, b"", "image/x-icon")
        if path == "/sw.js":
            # Service Worker 必须从根路径发出，作用域才能覆盖整站；
            # 同时给 Service-Worker-Allowed 兜底，并禁止缓存以便随时更新策略。
            try:
                with open(os.path.join(STATIC, "sw.js"), "rb") as f:
                    data = f.read()
                # SW 版本号以 index.html 的 kg-app-ver 为唯一来源，避免三处手改漏一处
                data = data.replace(b"__APP_VER__", app_ver().encode())
            except Exception:
                return self._send(404, {"error": "not found"})
            return self._send(200, data, "application/javascript; charset=utf-8",
                              extra={"Cache-Control": "no-cache", "Service-Worker-Allowed": "/"})
        if path.startswith("/static/"):
            fp = os.path.normpath(os.path.join(STATIC, path[len("/static/"):]))
            if not fp.startswith(STATIC):
                return self._send(403, {"error": "forbidden"})
            # 页面脚本/样式：内容随 ?v= 版本串变化 → 强缓存 30 天，版本升级即换 URL 必回源，
            # 日常访问零协商 RTT（此前 no-cache 每次都多付一个往返）
            if fp.endswith(".js") or fp.endswith(".css"):
                return self._file(fp, cache=True, max_age=2592000)
            return self._file(fp, cache=True, max_age=600)
        if path.startswith("/90-图片/"):
            rel = path[len("/90-图片/"):]
            fp = os.path.normpath(os.path.join(IMG_ROOT, rel))
            if not fp.startswith(IMG_ROOT):
                return self._send(403, {"error": "forbidden"})
            if not os.path.exists(fp):  # 缺图兜底：返回"图片暂缺"占位 WebP，避免破图图标
                fp = os.path.join(IMG_ROOT, "__missing__.webp")
            return self._file(fp, cache=True, max_age=2592000)  # 图片内容不变，长缓存省回源
        if path.startswith("/api/"):
            borrow()   # 本请求独占一条连接（多线程不再共用，杜绝 database is locked）
            try:
                return self.api(path, g)
            except Unauthorized:
                return self._send(401, {"error": "未登录或登录已失效，请重新登录"})
            except Forbidden:
                return self._send(403, {"error": "无权限：仅管理员可执行此操作"})
            except Exception as e:
                import traceback; traceback.print_exc()
                return self._send(500, {"error": str(e)})
            finally:
                unborrow()
        return self._send(404, {"error": "no route"})

    def do_POST(self):
        u = urllib.parse.urlparse(self.path)
        path = urllib.parse.unquote(u.path)
        n = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(n) if n else b"{}"
        try:
            payload = json.loads(raw.decode("utf-8"))
        except Exception:
            payload = {}
        if path in ("/ops/api/login", "/ops/api/logout"):
            return self.ops_post(path, payload)

        routes = {
            "/api/grade": self.api_grade,
            # 今日回溯：组 / 逐题作答状态
            "/api/practice/start": self.api_practice_start,
            "/api/practice/mark": self.api_practice_mark,
            "/api/practice/end": self.api_practice_end,
            "/api/note": self.api_note,
            "/api/fav": self.api_fav,
            "/api/discard": self.api_discard,
            "/api/import/mydata": self.api_import_mydata,
            "/api/goal": self.api_goal,
            "/api/pacing": self.api_pacing,
            "/api/doubt": self.api_doubt,
            "/api/exam/submit": self.api_exam_submit,
            "/api/users/rename": self.api_users_rename,
            "/api/users/delete": self.api_users_delete,
            "/api/account/reset-practice": self.api_account_reset,
            "/api/study-time": self.api_study_time,
            "/api/prefs": self.api_prefs,
            # 陪伴者（只读督导）
            "/api/live/ping": self.api_live_ping,
            "/api/teacher/register": self.api_teacher_register,
            "/api/teacher/link": self.api_teacher_link,
            "/api/teacher/unlink": self.api_teacher_unlink,
            "/api/teacher/detach": self.api_teacher_detach,
            "/api/teacher/encourage": self.api_teacher_encourage,
            "/api/teacher/encourage/delete": self.api_teacher_encourage_delete,
            "/api/linkcode": self.api_linkcode,
            "/api/push": self.api_push,
            "/api/push/read": self.api_push_read,
            "/api/encourage/reply": self.api_encourage_reply,
            # 账号：注册 / 登录 / 退出 / 改密码 / 老账号补设密码
            "/api/auth/register": self.api_auth_register,
            "/api/auth/login": self.api_auth_login,
            "/api/auth/logout": self.api_auth_logout,
            "/api/auth/guest": self.api_auth_guest,
            "/api/auth/upgrade": self.api_auth_upgrade,
            "/api/auth/password": self.api_auth_password,
            "/api/auth/claim": self.api_auth_claim,
            # 管理员：管理其它账号（改名称/用户名/密码、删除）
            "/api/admin/account/update": self.api_admin_account_update,
            "/api/admin/account/delete": self.api_admin_account_delete,
            "/api/backup/config": self.api_backup_config,
            "/api/backup/run": self.api_backup_run,
            "/api/backup/restore": self.api_backup_restore,
        }
        fn = routes.get(path)
        if fn:
            borrow()   # 同上：注册/登录/游客等写操作各用各的连接
            try:
                return fn(payload)
            except Unauthorized:
                return self._send(401, {"error": "未登录或登录已失效，请重新登录"})
            except Forbidden:
                return self._send(403, {"error": "无权限：仅管理员可执行此操作"})
            except Exception as e:
                import traceback; traceback.print_exc()
                return self._send(500, {"error": str(e)})
            finally:
                unborrow()
        return self._send(404, {"error": "no route"})

    def do_OPTIONS(self):
        """CORS 预检：云端接口跨源调用时浏览器会先发 OPTIONS。"""
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Content-Length", "0")
        self.end_headers()

    # ---------- GET API ----------
    # ---------- 只读运营面板 ----------
    def _ops_sid(self, g):
        sid = g("sid") or self.headers.get("X-Ops-Sid") or ""
        if not sid:
            ck = self.headers.get("Cookie") or ""
            for part in ck.split(";"):
                k, _, v = part.strip().partition("=")
                if k == "kg_ops":
                    sid = v
        return sid

    def _ops_guard(self, g):
        """返回 True 表示已鉴权；否则已自行响应 401/429，调用方直接 return。"""
        if not ops_enabled():
            self._send(404, {"error": "no route"})
            return False
        if not ops_check(self._ops_sid(g)):
            self._send(401, {"error": "需要运营口令"})
            return False
        return True

    def ops_post(self, path, p):
        ip = self.client_address[0]
        if not ops_enabled():
            return self._send(404, {"error": "no route"})
        if path == "/ops/api/logout":
            ops_drop(self._ops_sid(lambda k, d="": (p.get(k) or d)))
            return self._send(200, {"ok": True}, extra={
                "Set-Cookie": "kg_ops=; Path=/ops; Max-Age=0; HttpOnly; SameSite=Strict"})
        # 登录
        if not _ops_rate_ok(ip):
            return self._send(429, {"error": "尝试过于频繁，请 10 分钟后再试"})
        got = (p.get("token") or "").strip()
        if not got or not secrets.compare_digest(got, OPS_TOKEN):
            _ops_fail(ip)
            time.sleep(0.4)          # 拖慢暴力猜解
            return self._send(401, {"error": "口令不正确"})
        sid = ops_issue()
        return self._send(200, {"ok": True}, extra={
            "Set-Cookie": "kg_ops=%s; Path=/ops; Max-Age=%d; HttpOnly; SameSite=Strict" % (sid, _OPS_TTL)})

    def ops_api(self, name, g):
        if not self._ops_guard(g):
            return
        borrow()          # 只读也要独立连接：不与主站请求抢同一条连接
        try:
            if name == "overview":
                return self._send(200, ops_overview(_int(g("days"), 30)))
            if name == "health":
                return self._send(200, ops_health())
            if name == "session":
                return self._send(200, {"ok": True, "scope": "正式账号" if _OPS_HIDE_ANON else "含游客"})
            return self._send(404, {"error": "no such ops api"})
        except Exception as e:
            import traceback; traceback.print_exc()
            return self._send(500, {"error": str(e)})
        finally:
            unborrow()

    def api(self, path, g):
        # 完整数据备份（导出）
        if path == "/api/export/mydata":
            return self.api_export_mydata({"token": g("token")})
        if path == "/api/bootstrap":
            mods = q_all("SELECT module, COUNT(*) n FROM qdb.questions GROUP BY module ORDER BY n DESC")
            cats = q_all("SELECT module, category, COUNT(*) n FROM qdb.questions GROUP BY module,category ORDER BY n DESC")
            total = q_one("SELECT COUNT(*) n FROM qdb.questions")["n"]
            return self._send(200, {"total": total, "modules": mods, "categories": cats, "today": today()})

        # ---------- 复习计划：未来逐日到期题数 ----------
        if path == "/api/review/plan":
            return self.api_review_plan({"token": g("token")})

        # ---------- 今日回溯：按组回看当天练过的题，以及「对答案那一刻」的状态 ----------
        if path == "/api/practice/today":
            uid = need_uid(g("token"))
            day = (g("date") or "").strip()
            try:
                d0 = datetime.date.fromisoformat(day) if day else datetime.date.today()
            except Exception:
                d0 = datetime.date.today()
            span = (datetime.date.today() - d0).days
            if span < 0 or span > 31:          # 只开放最近 31 天，避免随意翻库
                d0 = datetime.date.today()
            day = d0.isoformat()
            rows = q_all("""SELECT gp.gid, gp.mode, gp.answer_mode, gp.title, gp.scope, gp.size,
                                   gp.started, gp.ended, IFNULL(gp.total_ms,0) total_ms,
                                   IFNULL(gp.state,'open') state,
                                   COUNT(it.qid) n,
                                   SUM(CASE WHEN it.graded_at IS NOT NULL THEN 1 ELSE 0 END) answered,
                                   SUM(CASE WHEN IFNULL(it.correct,0)=1 THEN 1 ELSE 0 END) right_n,
                                   SUM(CASE WHEN it.graded_at IS NOT NULL AND IFNULL(it.correct,0)=0
                                            THEN 1 ELSE 0 END) wrong_n,
                                   SUM(IFNULL(it.timeout,0)) timeout_n,
                                   SUM(IFNULL(it.ms,0)) spent_ms
                            FROM practice_groups gp LEFT JOIN practice_items it ON it.gid=gp.gid
                            WHERE gp.uid=? AND date(gp.started)=?
                            GROUP BY gp.gid ORDER BY gp.started DESC""", (uid, day))
            groups = []
            for r in rows:
                r["n"] = int(r["n"] or 0)
                r["answered"] = int(r["answered"] or 0)
                r["right_n"] = int(r["right_n"] or 0)
                r["wrong_n"] = int(r["wrong_n"] or 0)
                r["timeout_n"] = int(r["timeout_n"] or 0)
                r["spent_ms"] = int(r["spent_ms"] or 0)
                r["total_ms"] = int(r["total_ms"] or 0)
                r["legacy"] = False
                groups.append(r)
            # 今天之前上线、没有分组记录的旧作答：合成一个「历史记录」组，如实标注未保存选项
            legacy = q_all("""SELECT r.qid, r.grade, r.ts, IFNULL(r.timeout,0) timeout,
                                     s.id, s.module, s.category, s.stem, s.answer
                              FROM reviews r JOIN qdb.questions s ON s.qid=r.qid
                              WHERE r.user_id=? AND date(r.ts)=?
                                AND r.id=(SELECT MAX(r2.id) FROM reviews r2
                                          WHERE r2.user_id=r.user_id AND r2.qid=r.qid AND date(r2.ts)=?)
                                AND r.qid NOT IN (SELECT it.qid FROM practice_items it
                                                  JOIN practice_groups gp ON gp.gid=it.gid
                                                  WHERE gp.uid=? AND date(gp.started)=?)
                              ORDER BY r.id""", (uid, day, day, uid, day))
            if legacy:
                items = []
                for i, r in enumerate(legacy, 1):
                    items.append({"qid": r["qid"], "id": r["id"], "pos": i,
                                  "module": r["module"], "category": r["category"],
                                  "stem": plain_text(r["stem"], 140), "answer": r["answer"],
                                  "choice": "", "correct": 1 if int(r["grade"] or 0) >= 3 else 0,
                                  "timeout": r["timeout"], "ms": 0, "graded_at": r["ts"]})
                right_n = sum(1 for x in items if x["correct"])
                groups.append({"gid": "legacy-" + day, "mode": "legacy", "answer_mode": "instant",
                               "title": "未分组的作答记录", "scope": "", "size": len(items),
                               "started": legacy[0]["ts"], "ended": legacy[-1]["ts"],
                               "total_ms": 0, "state": "done", "n": len(items),
                               "answered": len(items), "right_n": right_n,
                               "wrong_n": len(items) - right_n, "timeout_n": sum(1 for x in items if x["timeout"]),
                               "spent_ms": 0, "legacy": True, "items": items})
            summary = {
                "groups": len(groups),
                "questions": sum(x["n"] for x in groups),
                "answered": sum(x["answered"] for x in groups),
                "right": sum(x["right_n"] for x in groups),
                "wrong": sum(x["wrong_n"] for x in groups),
                "timeout": sum(x["timeout_n"] for x in groups),
                "ms": sum(x["spent_ms"] for x in groups),
            }
            return self._send(200, {"ok": True, "date": day, "summary": summary, "groups": groups})

        if path == "/api/practice/group":
            uid = need_uid(g("token"))
            gid = (g("gid") or "").strip()
            gp = q_one("SELECT * FROM practice_groups WHERE gid=? AND uid=?", (gid, uid))
            if not gp:
                return self._send(404, {"error": "没有这组练习记录"})
            items = q_all("""SELECT it.qid, it.pos, it.choice, IFNULL(it.answer, s.answer) answer,
                                    IFNULL(it.correct,0) correct, IFNULL(it.timeout,0) timeout,
                                    IFNULL(it.ms,0) ms, it.graded_at,
                                    s.id, s.module, s.category, s.kadian, s.stem
                             FROM practice_items it LEFT JOIN qdb.questions s ON s.qid=it.qid
                             WHERE it.gid=? ORDER BY it.pos, it.rowid""", (gid,))
            for x in items:
                x["stem"] = plain_text(x["stem"], 140)
            # full=1：把每题的完整卡片（材料/选项/官方解析/收藏）一起带回，
            # 让回溯能直接复用「交卷后解析」那套界面，不用逐题再请求
            if g("full") == "1":
                ids = [x["id"] for x in items if x.get("id")]
                cards = {}
                if ids:
                    ph = ",".join("?" * len(ids))
                    for r in q_all(f"SELECT * FROM qdb.questions WHERE id IN ({ph})", ids):
                        cards[r["id"]] = clean_card(r, reveal=True, uid=uid)
                for x in items:
                    x["card"] = cards.get(x.get("id"))
            gp["legacy"] = False
            return self._send(200, {"ok": True, "group": gp, "items": items})

        # ---------- 陪伴者（只读督导）：陪读列表 / 陪读详情 / 实时看板 / 鼓励信息 ----------
        if path == "/api/teacher/students":
            uid = need_uid(g("token"))
            # 双向：我作为「陪伴者」绑的人 + 我作为「被陪伴者」绑我的人，都算我陪伴圈里的人
            rows = q_all("""SELECT u.id, u.name, u.username, MIN(l.created) linked,
                                   MAX(CASE WHEN l.teacher_uid=? THEN 1 ELSE 0 END) is_mine
                            FROM teacher_links l JOIN users u
                              ON u.id = CASE WHEN l.teacher_uid=? THEN l.student_uid ELSE l.teacher_uid END
                            WHERE l.teacher_uid=? OR l.student_uid=?
                            GROUP BY u.id ORDER BY linked DESC""", (uid, uid, uid, uid))
            out = []
            for r in rows:
                b = self._student_brief(r["id"])
                b.update({"id": r["id"], "name": r["name"], "username": r["username"], "linked": r["linked"]})
                out.append(b)
            out.sort(key=lambda x: str(x.get("last_ts") or ""), reverse=True)
            out.sort(key=lambda x: 0 if x.get("online") else 1)   # 正在答题的排最前
            return self._send(200, {"ok": True, "students": out})

        if path == "/api/teacher/student":
            uid = need_uid(g("token"))
            sid = (g("uid") or "").strip()
            if not link_ok(uid, sid):
                return self._send(403, {"error": "没有该陪读的查看权限"})
            u = q_one("""SELECT id, name, username, created, IFNULL(anon,0) anon,
                                IFNULL(role,'student') role FROM users WHERE id=?""", (sid,))
            days = q_all("""SELECT day, ms FROM study_time WHERE uid=? AND day>=date(?,'-13 day') ORDER BY day""",
                         (sid, today()))
            recent = q_all("""SELECT r.ts, r.grade, IFNULL(r.timeout,0) timeout, s.id, s.qid,
                                     s.module, s.category, s.stem
                              FROM reviews r JOIN qdb.questions s ON s.qid=r.qid
                              WHERE r.user_id=? ORDER BY r.id DESC LIMIT 40""", (sid,))
            for x in recent:
                x["stem"] = plain_text(x["stem"], 120)
                x["right"] = int(x["grade"] or 0) >= 3
            wrong = q_all("""SELECT x.qid, x.wrong, x.due, x.wb_status, s.id, s.module, s.category, s.stem
                             FROM srs x JOIN qdb.questions s ON s.qid=x.qid
                             WHERE x.user_id=? AND x.wrong>0
                             ORDER BY x.wrong DESC, x.due ASC LIMIT 20""", (sid,))
            for x in wrong:
                x["stem"] = plain_text(x["stem"], 140)
            exams = q_all("""SELECT id,title,total,correct,score,duration,ts FROM exam_history
                             WHERE user_id=? ORDER BY id DESC LIMIT 10""", (sid,))
            return self._send(200, {"ok": True, "student": u, "brief": self._student_brief(sid, full=True),
                                    "days": days, "recent": recent, "wrong": wrong, "exams": exams})

        if path == "/api/teacher/question":
            # 陪伴者点开陪读做过的题：只读查看整道题（题干 / 材料 / 选项 / 答案 / 解析）
            uid = need_uid(g("token"))
            sid = (g("uid") or "").strip()
            if not link_ok(uid, sid):
                return self._send(403, {"error": "没有该陪读的查看权限"})
            qid = (g("qid") or "").strip()
            qidn = _int(g("id"), 0)
            row = (q_one("SELECT * FROM qdb.questions WHERE id=?", (qidn,)) if qidn
                   else q_one("SELECT * FROM qdb.questions WHERE qid=?", (qid,)))
            if not row:
                return self._send(404, {"error": "题目不存在"})
            srs = q_one("""SELECT status, due, interval, correct, wrong FROM srs
                            WHERE user_id=? AND qid=?""", (sid, row["qid"]))
            hist = q_all("""SELECT ts, grade, IFNULL(timeout,0) timeout FROM reviews
                            WHERE user_id=? AND qid=? ORDER BY id DESC LIMIT 10""", (sid, row["qid"]))
            for h in hist:
                h["right"] = int(h["grade"] or 0) >= 3
            return self._send(200, {"ok": True, "card": clean_card(row, reveal=True, uid=sid),
                                    "srs": srs, "history": hist})

        if path == "/api/teacher/live":
            uid = need_uid(g("token"))
            sid = (g("uid") or "").strip()
            if not link_ok(uid, sid):
                return self._send(403, {"error": "没有该陪读的查看权限"})
            return self._send(200, {"ok": True, "live": live_get(sid) or {"online": False, "status": "idle"},
                                    "student": q_one("SELECT name,username FROM users WHERE id=?", (sid,))})

        if path == "/api/teacher/encouragements":
            uid = need_uid(g("token"))
            rows = q_all("""SELECT e.id, e.text, e.ts, e.student_uid,
                                   CASE WHEN IFNULL(e.image,'')='' THEN 0 ELSE 1 END has_img,
                                   IFNULL(su.name,'全部陪读') target_name
                            FROM encouragements e LEFT JOIN users su ON su.id=e.student_uid
                            WHERE e.teacher_uid=? AND IFNULL(e.parent_id,0)=0
                            ORDER BY e.id DESC LIMIT 30""", (uid,))
            # 每条寄语下按陪读分组，给出「谁回过、回了什么、我还有几条没看」
            reps = q_all("""SELECT r.id, r.parent_id, r.text, r.ts, r.student_uid, r.role,
                                   IFNULL(r.read_ts,'') read_ts,
                                   CASE WHEN IFNULL(r.image,'')='' THEN 0 ELSE 1 END has_img,
                                   IFNULL(su.name, su.username) author_name
                            FROM encouragements r LEFT JOIN users su ON su.id=r.student_uid
                            WHERE r.teacher_uid=? AND IFNULL(r.parent_id,0)>0
                            ORDER BY r.id""", (uid,))
            by_root = {}
            for r in reps:
                if r["role"] == "student":
                    t = by_root.setdefault(r["parent_id"], {}).setdefault(
                        r["student_uid"], {"sid": r["student_uid"], "name": r["author_name"],
                                           "n": 0, "unread": 0, "last_ts": "", "last_text": ""})
                    t["n"] += 1
                    t["last_ts"] = r["ts"]
                    t["last_text"] = r["text"] or ("［图片］" if r["has_img"] else "")
                    if not r["read_ts"]:
                        t["unread"] += 1
            for e in rows:
                th = list((by_root.get(e["id"]) or {}).values())
                th.sort(key=lambda x: x["last_ts"] or "", reverse=True)
                e["threads"] = th
                e["reply_n"] = sum(t["n"] for t in th)
                e["unread"] = sum(t["unread"] for t in th)
                e["last_ts"] = th[0]["last_ts"] if th else ""
                e["last_text"] = th[0]["last_text"] if th else ""
                e["last_name"] = th[0]["name"] if th else ""
            return self._send(200, {"ok": True, "items": rows})

        if path == "/api/push/list":
            return self.api_push_list({"token": g("token"), "box": g("box", "in")})

        if path == "/api/coach/peers":
            # 陪伴者模块首页：我陪伴的人 / 我的陪伴者（双向关系各取一侧）
            uid = need_uid(g("token"))
            rows = q_all("""SELECT u.id, u.name, u.username, MIN(l.created) linked,
                                   MAX(CASE WHEN l.teacher_uid=? THEN 1 ELSE 0 END) is_mine
                            FROM teacher_links l JOIN users u
                              ON u.id = CASE WHEN l.teacher_uid=? THEN l.student_uid ELSE l.teacher_uid END
                            WHERE l.teacher_uid=? OR l.student_uid=?
                            GROUP BY u.id ORDER BY linked DESC""", (uid, uid, uid, uid))
            out = []
            for r in rows:
                b = self._student_brief(r["id"])
                b.update({"id": r["id"], "name": r["name"], "username": r["username"],
                          "linked": r["linked"], "is_mine": bool(r["is_mine"])})
                out.append(b)
            out.sort(key=lambda x: (0 if x.get("online") else 1, str(x.get("last_ts") or "")), reverse=False)
            return self._send(200, {"ok": True, "peers": out,
                                    "code": (q_one("SELECT IFNULL(link_code,'') c FROM users WHERE id=?",
                                                   (uid,)) or {}).get("c", "")})

        if path == "/api/teacher/mine":
            uid = need_uid(g("token"))
            rows = q_all("""SELECT t.id, t.name, t.username, l.created FROM teacher_links l
                            JOIN users t ON t.id=l.teacher_uid
                            WHERE l.student_uid=? ORDER BY l.created""", (uid,))
            return self._send(200, {"ok": True, "teachers": rows})

        if path == "/api/encourage":
            uid = need_uid(g("token"))
            rows = q_all("""SELECT e.id, e.text, e.ts, e.student_uid,
                                   CASE WHEN IFNULL(e.image,'')='' THEN 0 ELSE 1 END has_img,
                                   IFNULL(t.name, t.username) teacher_name
                            FROM encouragements e
                            JOIN teacher_links l ON l.teacher_uid=e.teacher_uid AND l.student_uid=?
                            LEFT JOIN users t ON t.id=e.teacher_uid
                            WHERE IFNULL(e.parent_id,0)=0 AND (e.student_uid='*' OR e.student_uid=?)
                            ORDER BY e.id DESC LIMIT 6""", (uid, uid))
            reps = q_all("""SELECT r.parent_id, r.text, r.ts, r.role, IFNULL(r.read_ts,'') read_ts,
                                   CASE WHEN IFNULL(r.image,'')='' THEN 0 ELSE 1 END has_img
                            FROM encouragements r
                            WHERE r.student_uid=? AND IFNULL(r.parent_id,0)>0
                            ORDER BY r.id""", (uid,))
            by_root = {}
            for r in reps:
                b = by_root.setdefault(r["parent_id"], {"n": 0, "unread": 0, "last_ts": "", "last_text": "", "last_role": ""})
                b["n"] += 1
                b["last_ts"] = r["ts"]
                b["last_text"] = r["text"] or ("［图片］" if r["has_img"] else "")
                b["last_role"] = r["role"]
                if r["role"] == "teacher" and not r["read_ts"]:
                    b["unread"] += 1
            for e in rows:
                b = by_root.get(e["id"]) or {"n": 0, "unread": 0, "last_ts": "", "last_text": "", "last_role": ""}
                e.update(b)
            return self._send(200, {"ok": True, "items": rows})

        if path == "/api/encourage/unread":
            # 陪读看「陪伴者回复了几条没读」，陪伴者看「陪读回复了几条没读」
            uid = need_uid(g("token"))
            if user_role(uid) == "teacher":
                n = q_one("""SELECT COUNT(*) n FROM encouragements
                             WHERE teacher_uid=? AND role='student' AND IFNULL(read_ts,'')=''
                               AND IFNULL(parent_id,0)>0""", (uid,))["n"]
            else:
                n = q_one("""SELECT COUNT(*) n FROM encouragements
                             WHERE student_uid=? AND role='teacher' AND IFNULL(read_ts,'')=''
                               AND IFNULL(parent_id,0)>0""", (uid,))["n"]
            return self._send(200, {"ok": True, "n": n})

        if path == "/api/encourage/thread":
            # 一条寄语 = 一个会话线程；陪伴者侧按 (寄语, 陪读) 打开，陪读侧就是自己那条
            uid = need_uid(g("token"))
            rid = _int(g("id"), 0)
            root = q_one("""SELECT e.id, e.text, e.ts, e.teacher_uid, e.student_uid,
                                   CASE WHEN IFNULL(e.image,'')='' THEN 0 ELSE 1 END has_img,
                                   IFNULL(t.name, t.username) teacher_name,
                                   IFNULL(su.name,'全部陪读') target_name
                            FROM encouragements e
                            LEFT JOIN users t ON t.id=e.teacher_uid
                            LEFT JOIN users su ON su.id=e.student_uid
                            WHERE e.id=? AND IFNULL(e.parent_id,0)=0""", (rid,))
            if not root:
                return self._send(404, {"error": "这条寄语不存在"})
            is_t = user_role(uid) == "teacher"
            if is_t:
                if root["teacher_uid"] != uid:
                    return self._send(403, {"error": "只能查看自己发布的寄语"})
                sid = (g("sid") or "").strip()
                if not sid and root["student_uid"] != "*":
                    sid = root["student_uid"]
                if sid and not link_ok(uid, sid):
                    return self._send(403, {"error": "没有该陪读的查看权限"})
            else:
                sid = uid
                if (root["student_uid"] not in ("*", uid)) or not link_ok(root["teacher_uid"], uid):
                    return self._send(403, {"error": "没有这条寄语的查看权限"})
            if sid:
                msgs = q_all("""SELECT r.id, r.text, r.ts, r.role, r.student_uid,
                                       CASE WHEN IFNULL(r.image,'')='' THEN 0 ELSE 1 END has_img,
                                       IFNULL(su.name, su.username) author_name
                                FROM encouragements r LEFT JOIN users su ON su.id=r.student_uid
                                WHERE r.id=? OR (r.parent_id=? AND r.student_uid=?)
                                ORDER BY r.id""", (rid, rid, sid))
            else:
                msgs = [dict(root, role="teacher", author_name=root["teacher_name"])]
            for m in msgs:
                # 陪伴者发的消息作者就是这位陪伴者；陪读发的取自己的名字
                m["author_name"] = (root["teacher_name"] if m.get("role") == "teacher"
                                    else (m.get("author_name") or "陪读"))
            # 打开即已读：只看「对端发给我的」那几条，不碰自己发的
            with _LOCK:
                if is_t and sid:
                    db().execute("""UPDATE encouragements SET read_ts=?
                                    WHERE parent_id=? AND role='student' AND student_uid=?
                                      AND IFNULL(read_ts,'')=''""", (now(), rid, sid))
                elif not is_t:
                    db().execute("""UPDATE encouragements SET read_ts=?
                                    WHERE parent_id=? AND role='teacher' AND student_uid=?
                                      AND IFNULL(read_ts,'')=''""", (now(), rid, uid))
                db().commit()
            partner = (root["target_name"] if not is_t else
                       (q_one("SELECT IFNULL(name,username) nm FROM users WHERE id=?", (sid,)) or {}).get("nm", "陪读"))
            return self._send(200, {"ok": True, "root": root, "messages": msgs,
                                    "sid": sid or "", "is_teacher": is_t, "partner": partner or "陪读"})

        if path == "/api/encourage/img":
            uid = need_uid(g("token"))
            eid = _int(g("id"), 0)
            r = q_one("SELECT id, teacher_uid, student_uid, image FROM encouragements WHERE id=?", (eid,))
            if not r or not r["image"]:
                return self._send(404, {"error": "图片不存在"})
            allowed = (r["teacher_uid"] == uid or r["student_uid"] == uid
                       or (r["student_uid"] == "*" and link_ok(r["teacher_uid"], uid)))
            if not allowed:
                return self._send(403, {"error": "没有权限"})
            m = re.match(r"data:(image/[A-Za-z0-9.+-]+);base64,(.+)", r["image"], re.S)
            if not m:
                return self._send(404, {"error": "图片格式异常"})
            try:
                data = base64.b64decode(m.group(2))
            except Exception:
                return self._send(404, {"error": "图片数据损坏"})
            return self._send(200, data, m.group(1),
                              extra={"Cache-Control": "private, max-age=86400"})

        if path == "/api/prefs":
            # 本机偏好（主题、字号、答题模式、限时、题量、宽度、右键手势、已做缓存）随应用账号走，不再依赖 WorkBuddy 云账号
            uid = need_uid(g("token"))
            raw = get_user_setting(uid, "prefs")
            data = {}
            if raw:
                try:
                    data = json.loads(raw) or {}
                except Exception:
                    data = {}
            if not isinstance(data, dict):
                data = {}
            return self._send(200, {"ok": True, "prefs": data,
                                    "updated": get_user_setting(uid, "prefs_at", "")})

        if path == "/api/stats":
            t = today(); uid = need_uid(g("token"))
            learned = q_one("SELECT COUNT(*) n FROM srs WHERE user_id=? AND status!='new'", (uid,))["n"]
            total_q = q_total()
            # 丢弃的题不会再被抽到，不能算进「未学新题」的可做池
            dropped_n = q_one("SELECT COUNT(*) n FROM discarded WHERE uid=?", (uid,))["n"]
            due_new = max(0, total_q - learned - dropped_n)   # 没进度行的题都算新题，不必预铺行
            due_rev = q_one("SELECT COUNT(*) n FROM srs WHERE user_id=? AND status!='new' AND due<=?", (uid, t))["n"]
            studied_today = q_one("SELECT COUNT(DISTINCT qid) n FROM reviews WHERE user_id=? AND date(ts)=?", (uid, t))["n"]
            # 学习时长（答题 + 看解析，由前端按秒累计后分批上报）
            st_today = q_one("SELECT ms FROM study_time WHERE uid=? AND day=?", (uid, t))
            st_total = q_one("SELECT SUM(ms) s FROM study_time WHERE uid=?", (uid,))
            wrong_n = q_one("SELECT COUNT(*) n FROM srs WHERE user_id=? AND wrong>0", (uid,))["n"]
            fav_n = q_one("SELECT COUNT(*) n FROM favorites WHERE user_id=?", (uid,))["n"]
            by_mod = q_all("""SELECT q.module m, COUNT(*) total,
                              SUM(CASE WHEN s.qid IS NOT NULL AND s.status!='new' THEN 1 ELSE 0 END) learned
                              FROM qdb.questions q LEFT JOIN srs s ON s.qid=q.qid AND s.user_id=?
                              GROUP BY q.module""", (uid,))
            due_by_mod = q_all("""SELECT q.module m, COUNT(*) n FROM srs s JOIN qdb.questions q ON q.qid=s.qid
                                  WHERE s.user_id=? AND s.status!='new' AND s.due<=? GROUP BY q.module""", (uid, t))
            mastery = q_all("SELECT interval FROM srs WHERE user_id=? AND status!='new'", (uid,))
            buckets = {"学习中": 0, "初记": 0, "短期": 0, "长期": 0, "稳固": 0}
            for r in mastery:
                buckets[sm2.mastery_bucket(r["interval"])] += 1
            return self._send(200, {
                "new": due_new, "due_review": due_rev, "learned": learned,
                "studied_today": studied_today, "by_module": by_mod,
                "due_by_module": due_by_mod, "mastery": buckets,
                "wrong": wrong_n, "fav": fav_n, "discarded": dropped_n,
                "today_ms": int((st_today or {}).get("ms") or 0),
                "total_ms": int((st_total or {}).get("s") or 0),
                "total": total_q,
            })

        if path == "/api/next":
            mode = g("mode", "mix")
            size = max(1, min(60, _int(g("size"), 10)))
            uid = need_uid(g("token"))
            cond, args = build_where(g("module"), g("category"), g("kadian"))
            # 丢弃过的题一律不再出现（任何模式：新题 / 错题重练 / 复习到期 / 收藏 / 材料）
            cond += discard_filter(uid)
            dcl_raw = discard_filter(uid, "")           # 下面两个分支的 SQL 没有表别名
            year = g("year")
            if year in {str(y) for y in range(2020, 2027)}:
                cond += " AND q.year=?"
                args.append(year)
            ref = g("ref")
            # 跨次去重：排除近期已练习过的 qid（由前端传入，限额 500，仅作用于新题补充分支）
            excl = g("exclude", "")
            excl_ids = [x for x in excl.split(",") if re.fullmatch(r"\d+", x.strip())][:500] if excl else []
            ea = args + excl_ids
            # 进度行按需生成：LEFT JOIN 让没有进度行的题也视为「新题」，
            # 不再依赖注册时预铺 2.7 万行空白记录（那是注册慢 + 写锁长的根源）
            J = "FROM qdb.questions q LEFT JOIN srs s ON s.qid=q.qid AND s.user_id=?"
            NEW = "(s.qid IS NULL OR s.status='new')"
            excl_clause = (f" AND q.qid NOT IN ({','.join('?' * len(excl_ids))})") if excl_ids else ""
            if mode == "ids":
                # 按指定 id 取题（临时标记题复盘），保持传入顺序
                ids = [int(x) for x in g("ids", "").split(",") if re.fullmatch(r"\d+", x.strip())][:200]
                if not ids:
                    rows = []
                else:
                    ph = ",".join("?" * len(ids))
                    rows = q_all(f"SELECT * FROM qdb.questions WHERE id IN ({ph}){dcl_raw}", ids)
                    order = {int(x): i for i, x in enumerate(ids)}
                    rows.sort(key=lambda r: order.get(r["id"], 9999))
            elif mode == "material":
                rows = q_all(f"SELECT * FROM qdb.questions WHERE material_ref=?{dcl_raw} ORDER BY id LIMIT ?", (ref, size))
            elif mode == "fav":
                rows = q_all(f"""SELECT q.* {J}
                                WHERE q.qid IN (SELECT qid FROM favorites WHERE user_id=?){cond}
                                ORDER BY RANDOM() LIMIT ?""", (uid, uid, *args, size))
            elif mode == "wrongredo":
                # 错题专项重练：只抽「待重练」的错题，随机打散
                # 注意：错题重练就是「再做一遍」，绝不能套用 exclude（刚做完的错题会被全部排除，
                # 表现为「今天的错题一题都抽不到」）。
                rows = q_all(f"""SELECT q.* {J}
                                WHERE s.wrong>0 AND IFNULL(s.wb_status,'active')='active'{cond}
                                ORDER BY RANDOM() LIMIT ?""", (uid, *args, size))
            elif mode == "wrong":
                rows = q_all(f"""SELECT q.* {J}
                                WHERE s.wrong>0{cond} ORDER BY s.wrong DESC, s.ease ASC LIMIT ?""",
                             (uid, *args, size))
            elif mode == "review":
                rows = q_all(f"""SELECT q.* {J}
                                WHERE s.status!='new' AND s.due<=?{cond}
                                ORDER BY s.due ASC, s.ease ASC LIMIT ?""", (uid, today(), *args, size))
            elif mode == "mix":
                # 重复练习题优先：答错 > 遗忘(lapses) > 到期复习（此池不受 exclude 限制，刚做错的也能立刻重练）；
                # 新题仅作补充，且排除近期已练过的，避免无意义重复。
                rows = q_all(f"""SELECT q.* {J}
                                WHERE 1=1{cond} AND (s.wrong>0 OR s.lapses>0 OR (s.status!='new' AND s.due<=?))
                                ORDER BY (CASE WHEN s.wrong>0 THEN 0 WHEN s.lapses>0 THEN 1 ELSE 2 END),
                                         s.due ASC, RANDOM() LIMIT ?""", (uid, today(), *args, size))
                if len(rows) < size:
                    fill = q_all(f"""SELECT q.* {J}
                                    WHERE 1=1{cond} AND {NEW}{excl_clause} ORDER BY RANDOM() LIMIT ?""",
                                 (uid, *ea, size - len(rows)))
                    rows += fill
            else:  # new / study / exam
                rows = q_all(f"""SELECT q.* {J}
                                WHERE {NEW}{cond}{excl_clause} ORDER BY RANDOM() LIMIT ?""", (uid, *ea, size))
            if rows:
                ensure_srs_rows(uid, [r["qid"] for r in rows])   # 抽到的题补齐进度行（一次事务）
            return self._send(200, {"mode": mode, "count": len(rows),
                                    "cards": [clean_card(r, reveal=False) for r in rows]})

        if path == "/api/question":
            uid = need_uid(g("token"))
            r = q_one("SELECT * FROM qdb.questions WHERE id=?", (_int(g("id"), 0),))
            if not r:
                return self._send(404, {"error": "no such question"})
            srs = q_one("SELECT * FROM srs WHERE qid=? AND user_id=?", (r["qid"], uid))
            if not srs:   # 按需生成：直接看某题也补一条空白进度，详情页/收藏才能正常标状态
                ensure_srs_rows(uid, [r["qid"]])
                srs = q_one("SELECT * FROM srs WHERE qid=? AND user_id=?", (r["qid"], uid))
            dropped = bool(q_one("SELECT 1 x FROM discarded WHERE uid=? AND qid=?", (uid, r["qid"])))
            return self._send(200, {"card": clean_card(r, reveal=True, uid=uid), "srs": srs, "dropped": dropped})

        if path == "/api/browse":
            page = max(1, _int(g("page"), 1)); size = max(1, min(100, _int(g("size"), 25)))
            uid = need_uid(g("token"))
            cond, args = build_where(g("module"), g("category"), g("kadian"))
            region = g("region"); year = g("year"); kw = g("q")
            only = g("only")  # wrong | fav | mastered | discarded
            a2, b2 = list(args), list(args)
            if only == "wrong":
                cond += " AND s.wrong>0 AND IFNULL(s.wb_status,'active')='active'"
            elif only == "mastered":
                cond += " AND s.wrong>0 AND s.wb_status='cleared'"
            elif only == "discarded":
                # 练习题里丢弃的题集中在这里，可随时恢复
                cond += " AND q.qid IN (SELECT qid FROM discarded WHERE uid=?)"
                a2.append(uid); b2.append(uid)
            elif only == "fav":
                cond += " AND q.qid IN (SELECT qid FROM favorites WHERE user_id=?)"
                a2.append(uid); b2.append(uid)
            if region:
                cond += " AND q.region=?"; a2.append(region); b2.append(region)
            if year:
                cond += " AND q.year=?"; a2.append(year); b2.append(year)
            if kw:
                cond += " AND (q.stem LIKE ? OR q.kadian LIKE ?)"; a2 += ["%" + kw + "%"] * 2; b2 += ["%" + kw + "%"] * 2
            # LEFT JOIN：没进度行的题也列出（空白进度 = 新题），不再依赖预铺行
            total = q_one(f"""SELECT COUNT(*) n FROM qdb.questions q LEFT JOIN srs s ON s.qid=q.qid AND s.user_id=?
                              WHERE 1=1{cond}""", (uid, *b2))["n"]
            rows = q_all(f"""SELECT q.id,q.qid,q.module,q.category,q.kadian,q.region,q.year,q.answer,q.has_image,q.ask_model,
                            IFNULL(s.status,'new') status,s.due,s.interval,
                            IFNULL(s.correct,0) correct,IFNULL(s.wrong,0) wrong,
                            IFNULL(s.wb_status,'active') wb_status,
                            CASE WHEN f.qid IS NOT NULL THEN 1 ELSE 0 END fav,
                            CASE WHEN d.qid IS NOT NULL THEN 1 ELSE 0 END dropped
                            FROM qdb.questions q
                            LEFT JOIN srs s ON s.qid=q.qid AND s.user_id=?
                            LEFT JOIN favorites f ON f.qid=q.qid AND f.user_id=?
                            LEFT JOIN discarded d ON d.qid=q.qid AND d.uid=?
                            WHERE 1=1{cond}
                            ORDER BY q.module,q.category,q.year DESC LIMIT ? OFFSET ?""",
                         (uid, uid, uid, *a2, size, (page - 1) * size))
            dropped_n = q_one("SELECT COUNT(*) n FROM discarded WHERE uid=?", (uid,))["n"]
            return self._send(200, {"total": total, "page": page, "size": size,
                                    "rows": rows, "discarded": dropped_n})

        if path == "/api/kadian":
            cond, args = build_where(g("module"), g("category"), "")
            rows = q_all(f"""SELECT q.kadian kd, q.module m, q.category c, COUNT(*) n,
                            MIN(q.mother) mother
                            FROM qdb.questions q WHERE 1=1{cond}
                            GROUP BY q.kadian ORDER BY n DESC LIMIT ?""", (*args, _int(g("size"), 500)))
            return self._send(200, {"rows": rows})

        if path == "/api/facets":
            return self._send(200, {
                "regions": [r["region"] for r in q_all("SELECT DISTINCT region FROM qdb.questions WHERE region!='' ORDER BY region")],
                "years": [r["year"] for r in q_all("SELECT DISTINCT year FROM qdb.questions WHERE year!='' ORDER BY year DESC")],
            })

        if path == "/api/favs":
            uid = need_uid(g("token"))
            ids = [r["qid"] for r in q_all("SELECT qid FROM favorites WHERE user_id=?", (uid,))]
            return self._send(200, {"ids": ids})

        if path == "/api/heatmap":
            days = max(30, min(365, _int(g("days"), 120)))
            uid = need_uid(g("token"))
            rows = q_all("""SELECT date(ts) d, COUNT(*) n FROM reviews WHERE user_id=?
                            GROUP BY date(ts) ORDER BY d DESC LIMIT ?""", (uid, days))
            return self._send(200, {"days": [{"d": r["d"], "n": r["n"]} for r in reversed(rows)]})

        if path == "/api/streak":
            uid = need_uid(g("token"))
            dates = [r["d"] for r in q_all("""SELECT DISTINCT date(ts) d FROM reviews
                                              WHERE user_id=? ORDER BY d DESC""", (uid,))]
            dset = set(dates)
            cur = 0
            probe = datetime.date.today()
            # 今天没学也不断签：从昨天开始数
            if probe.isoformat() not in dset and dates:
                probe = probe - datetime.timedelta(days=1)
            while probe.isoformat() in dset:
                cur += 1
                probe -= datetime.timedelta(days=1)
            # best streak
            best = 0; run = 0; prev = None
            for d in sorted(dset):
                dt = datetime.date.fromisoformat(d)
                if prev and (dt - prev).days == 1:
                    run += 1
                else:
                    run = 1
                best = max(best, run); prev = dt
            goal = int(get_user_setting(uid, "daily_goal", get_setting("daily_goal", "120")) or 120)
            today_n = q_one("SELECT COUNT(DISTINCT qid) n FROM reviews WHERE user_id=? AND date(ts)=?",
                            (uid, today()))["n"]
            return self._send(200, {"current": cur, "best": best, "goal": goal, "today": today_n})

        if path == "/api/accuracy":
            uid = need_uid(g("token"))
            def agg(col):
                return q_all(f"""SELECT q.{col} k, COUNT(*) n, SUM(s.correct) c, SUM(s.wrong) w
                                FROM qdb.questions q JOIN srs s ON s.qid=q.qid AND s.user_id=?
                                WHERE s.status!='new' GROUP BY q.{col} HAVING n>=1 ORDER BY n DESC LIMIT 40""", (uid,))
            return self._send(200, {
                "module": agg("module"), "category": agg("category"),
                "region": agg("region"), "year": agg("year"),
            })

        if path == "/api/weak":
            uid = need_uid(g("token"))
            rows = q_all("""SELECT q.kadian kd, q.module m, q.category cat, COUNT(*) seen,
                            SUM(s.correct) c, SUM(s.wrong) w, SUM(s.lapses) lp, MIN(s.ease) ease
                            FROM qdb.questions q JOIN srs s ON s.qid=q.qid AND s.user_id=?
                            WHERE s.status!='new' GROUP BY q.kadian
                            HAVING seen>=1 AND (w>0 OR lp>0)
                            ORDER BY (CAST(w AS REAL)+lp)/seen DESC, ease ASC LIMIT 30""", (uid,))
            for r in rows:
                tot = (r["c"] or 0) + (r["w"] or 0)
                r["acc"] = round((r["c"] or 0) / tot * 100, 1) if tot else 0
            return self._send(200, {"rows": rows})

        if path == "/api/materials":
            size = max(1, min(100, _int(g("size"), 50)))
            rows = q_all("""SELECT g.ref, g.n, q.id rep_id, q.material, q.kadian
                            FROM (SELECT material_ref ref, COUNT(*) n, MIN(id) rep
                                  FROM qdb.questions WHERE module='资料分析' AND material_ref!=''
                                  GROUP BY material_ref HAVING n>=2) g
                            JOIN qdb.questions q ON q.id=g.rep
                            ORDER BY g.n DESC LIMIT ?""", (size,))
            out = []
            for r in rows:
                # 先剥离疑点/解析块，避免材料组列表页剧透答案
                snippet = re.sub(r"<[^>]+>", " ", strip_leak_blocks(r["material"] or ""))
                snippet = re.sub(r"\s+", " ", snippet).strip()[:70]
                out.append({"ref": r["ref"], "n": r["n"], "rep_id": r["rep_id"], "snippet": snippet})
            return self._send(200, {"rows": out})

        if path == "/api/doubts":
            page = max(1, _int(g("page"), 1)); size = max(1, min(50, _int(g("size"), 20)))
            only = g("only")            # pending = 仅待复核；mine = 我标记过的
            sort = g("sort")            # time = 按我的标记时间倒序
            uid = auth_uid(g("token")) or ""
            cond = "q.doubt!=''"; args = []
            if only == "pending":
                cond += " AND IFNULL(ds.status,'')=''"
            elif only == "mine":
                cond += " AND ds.user_id IS NOT NULL"
            # 复核状态必须按人隔离：以前只按 qid 关联，多人标记同一题会出现重复行并串号
            join = "LEFT JOIN doubt_status ds ON ds.qid=q.qid AND ds.user_id=?"
            order = "q.module,q.category"
            if sort == "time":
                order = "(IFNULL(ds.updated,'')=''), ds.updated DESC, q.module, q.category"
            total = q_one(f"""SELECT COUNT(*) n FROM qdb.questions q {join}
                             WHERE {cond}""", [uid] + args)["n"]
            rows = q_all(f"""SELECT q.id,q.qid,q.module,q.category,q.kadian,q.region,q.year,q.doubt,
                            ds.status ds_status, ds.note ds_note, IFNULL(ds.updated,'') ds_updated
                            FROM qdb.questions q {join}
                            WHERE {cond} ORDER BY {order} LIMIT ? OFFSET ?""",
                         [uid] + args + [size, (page - 1) * size])
            for r in rows:
                r["doubt"] = clean_doubt(r["doubt"])
            mine_n = q_one("""SELECT COUNT(*) n FROM qdb.questions q
                              JOIN doubt_status ds ON ds.qid=q.qid AND ds.user_id=?
                              WHERE q.doubt!=''""", (uid,))["n"] if uid else 0
            return self._send(200, {"total": total, "page": page, "size": size,
                                    "rows": rows, "mine": mine_n})

        if path == "/api/exam/history":
            uid = need_uid(g("token"))
            rows = q_all("SELECT * FROM exam_history WHERE user_id=? ORDER BY id DESC LIMIT 30", (uid,))
            return self._send(200, {"rows": rows})

        # ---------- 账号 ----------
        if path == "/api/users":
            # 仅返回「当前登录者自己」的信息；不再列出全部账号，避免泄露他人昵称
            uid = need_uid(g("token"))
            u = q_one("SELECT id,name,username,anon,created FROM users WHERE id=?", (uid,))
            return self._send(200, {"users": [u] if u else [], "me": u, "max": 0})
        if path == "/api/backup/config":
            need_admin(g("token"))
            cfg = _backup_config()
            return self._send(200, {"ok": True, "path": cfg.get("path", ""),
                                    "snapshots": _list_user_snapshots()})

        if path == "/api/backup/download":
            need_admin(g("token"))
            name = str(g("name") or "")
            if not name or os.path.basename(name) != name:
                return self._send(400, {"error": "快照名称无效"})
            folders = [BACKUP_DIR]
            local = _backup_config().get("path")
            if local:
                folders.append(local)
            source = next((os.path.join(folder, name) for folder in folders
                           if os.path.isfile(os.path.join(folder, name))), None)
            if not source:
                return self._send(404, {"error": "找不到该快照"})
            return self._download_file(source, name)

        if path == "/api/auth/me":
            uid = auth_uid(g("token"))
            if not uid:
                return self._send(200, {"ok": False})
            u = q_one("""SELECT id,name,username,anon,IFNULL(role,'student') role,
                                IFNULL(link_code,'') link_code FROM users WHERE id=?""", (uid,))
            if u:
                u["role"] = u["role"] or "student"
            return self._send(200, {"ok": True, "user": u})

        # ---------- 管理员：查看所有账号 ----------
        if path == "/api/admin/users":
            need_admin(g("token"))
            rows = q_all("""SELECT id, IFNULL(name,'') name, IFNULL(username,'') username,
                                   IFNULL(anon,0) anon, IFNULL(role,'student') role,
                                   IFNULL(created,'') created,
                                   (pw_hash IS NOT NULL AND pw_hash<>'') has_pw
                            FROM users ORDER BY (role='admin') DESC, created""")
            for r in rows:
                r["anon"] = bool(r["anon"])
                r["has_pw"] = bool(r["has_pw"])
                # 每账号的学习量摘要，便于管理员识别账号活跃度（纯读）
                try:
                    r["srs"] = q_one("SELECT COUNT(*) n FROM srs WHERE user_id=?", (r["id"],))["n"]
                    r["reviews"] = q_one("SELECT COUNT(*) n FROM reviews WHERE user_id=?", (r["id"],))["n"]
                except Exception:
                    r["srs"] = r["reviews"] = 0
            return self._send(200, {"ok": True, "users": rows, "count": len(rows)})

        # ---------- 功能1：错题本统计 ----------
        if path == "/api/wrongbook/stats":
            uid = need_uid(g("token"))
            total = q_one("SELECT COUNT(*) n FROM srs WHERE user_id=? AND wrong>0", (uid,))["n"]
            mastered = q_one("""SELECT COUNT(*) n FROM srs WHERE user_id=? AND wrong>0
                                AND wb_status='cleared'""", (uid,))["n"]
            return self._send(200, {"total": total, "mastered": mastered, "pending": total - mastered})

        # ---------- 错题/收藏逐题翻阅：返回同序 id 列表，供详情页「上一题 / 下一题」 ----------
        if path == "/api/idseq":
            uid = need_uid(g("token"))
            only = g("only") or "wrong"
            if only == "fav":
                rows = q_all("""SELECT q.id FROM qdb.questions q
                                JOIN favorites f ON f.qid=q.qid AND f.user_id=?
                                ORDER BY q.module,q.category,q.year DESC, q.id LIMIT 2000""", (uid,))
                return self._send(200, {"ids": [r["id"] for r in rows]})
            if only in ("today_review", "today_wrong"):
                # 空池兜底：今天已经练过 / 今天答错的题，允许立刻再过一遍
                t = today()
                if only == "today_review":
                    qids = [r["qid"] for r in q_all(
                        """SELECT qid, MAX(ts) mt FROM reviews WHERE user_id=? AND date(ts)=?
                           GROUP BY qid ORDER BY mt DESC LIMIT 200""", (uid, t))]
                else:
                    a = q_all("""SELECT DISTINCT pi.qid FROM practice_items pi
                                 JOIN practice_groups pg ON pg.gid=pi.gid
                                 WHERE pi.uid=? AND date(pg.started)=?
                                   AND IFNULL(pi.choice,'')!='' AND pi.correct=0""", (uid, t))
                    b = q_all("""SELECT DISTINCT qid FROM reviews WHERE user_id=? AND date(ts)=?
                                 AND (grade<=2 OR timeout=1)""", (uid, t))
                    qids = list(dict.fromkeys([r["qid"] for r in a] + [r["qid"] for r in b]))[:200]
                ids = []
                if qids:
                    ph = ",".join("?" * len(qids))
                    mp = {r["qid"]: r["id"] for r in q_all(
                        f"SELECT id,qid FROM qdb.questions WHERE qid IN ({ph})", qids)}
                    ids = [mp[q] for q in qids if q in mp]   # 保持「最近先重练」的顺序
                return self._send(200, {"ids": ids})
            # 与「错题本」列表同序（browse?only=wrong）
            rows = q_all("""SELECT q.id FROM qdb.questions q
                            LEFT JOIN srs s ON s.qid=q.qid AND s.user_id=?
                            WHERE s.wrong>0 AND IFNULL(s.wb_status,'active')='active'
                            ORDER BY q.module,q.category,q.year DESC, q.id LIMIT 2000""", (uid,))
            return self._send(200, {"ids": [r["id"] for r in rows]})

        # ---------- 功能4：题干关键词搜题 ----------
        if path == "/api/search":
            uid = need_uid(g("token"))
            kw = (g("q") or "").strip()
            size = max(1, min(60, _int(g("size"), 30)))
            if not kw:
                return self._send(200, {"total": 0, "rows": []})
            cond, args = build_where(g("module"), g("category"), "")
            like, pre = "%" + kw + "%", kw + "%"
            total = q_one(f"""SELECT COUNT(*) n FROM qdb.questions q LEFT JOIN srs s ON s.qid=q.qid AND s.user_id=?
                              WHERE (q.stem LIKE ? OR q.kadian LIKE ?){cond}""",
                          (uid, like, like, *args))["n"]
            rows = q_all(f"""SELECT q.id,q.qid,q.module,q.category,q.kadian,q.region,q.year,q.stem,
                                    q.answer,q.ask_model,s.wrong,IFNULL(s.status,'new') status,
                                    (SELECT 1 FROM favorites f WHERE f.qid=q.qid AND f.user_id=?) fav
                             FROM qdb.questions q LEFT JOIN srs s ON s.qid=q.qid AND s.user_id=?
                             WHERE (q.stem LIKE ? OR q.kadian LIKE ?){cond}
                             ORDER BY (CASE WHEN q.stem LIKE ? THEN 0 ELSE 1 END), q.id LIMIT ?""",
                         (uid, uid, like, like, *args, pre, size))
            out = []
            for r in rows:
                d = {k: r[k] for k in ("id", "qid", "module", "category", "kadian",
                                       "region", "year", "answer", "wrong", "status", "fav")}
                d["snippet"] = plain_text(r["stem"], 20)      # 题干前 20 字摘要
                out.append(d)
            return self._send(200, {"total": total, "rows": out})

        # ---------- 功能5：Markdown 导出 ----------
        if path == "/api/export/wrongbook":
            uid = need_uid(g("token"))
            rows = q_all("""SELECT q.id,q.qid,q.module,q.category,q.kadian,q.stem,q.options,q.answer,
                                   q.analysis,q.reasoning,q.fastest,q.pitfalls,
                                   s.wrong,s.correct,s.last_choice,s.wb_status
                            FROM qdb.questions q JOIN srs s ON s.qid=q.qid AND s.user_id=?
                            WHERE s.wrong>0 ORDER BY q.module, s.wrong DESC, q.id""", (uid,))
            bymod = {}
            for r in rows:
                bymod.setdefault(r["module"] or "未分类", []).append(r)
            L = [f"# 错题本 · {today()}", "",
                 f"> 共 {len(rows)} 题 · 待重练 {sum(1 for r in rows if (r['wb_status'] or 'active') != 'cleared')} "
                 f"· 已掌握 {sum(1 for r in rows if r['wb_status'] == 'cleared')}", ""]
            for mod, items in bymod.items():
                L.append(f"## {mod}（{len(items)} 题）")
                for i, r in enumerate(items, 1):
                    L.append(f"\n### {i}. {plain_text(r['kadian'], 40) or '未命名考点'}")
                    L.append(f"- **题干**：{plain_text(r['stem'], 300)}")
                    try:
                        opts = json.loads(r["options"] or "[]")
                    except Exception:
                        opts = []
                    if opts:
                        L.append("- **选项**：" + " / ".join(
                            f"{o.get('key','')}. {plain_text(o.get('html') or o.get('label',''), 60)}" for o in opts))
                    L.append(f"- **你的答案**：{r['last_choice'] or '—'}")
                    L.append(f"- **正确答案**：{r['answer'] or '—'}")
                    L.append(f"- **错误次数**：{r['wrong'] or 0}　**答对次数**：{r['correct'] or 0}")
                    L.append(f"- **状态**：{'✅ 已掌握（已移出待重练）' if r['wb_status']=='cleared' else '🔁 待重练'}")
                    if r["analysis"]:
                        L.append(f"- **官方解析**：{plain_text(r['analysis'], 500)}")
                    elif r["reasoning"]:
                        L.append(f"- **推理链**：{plain_text(r['reasoning'], 500)}")
                    if r["pitfalls"]:
                        L.append(f"- **易错点**：{plain_text(r['pitfalls'], 300)}")
                    L.append(f"- [查看详情](#/detail?id={r['id']})")
            return self._send(200, {"filename": f"错题本_{today().replace('-','')}.md",
                                    "count": len(rows), "text": "\n".join(L) + "\n"})

        if path == "/api/export/notes":
            uid = need_uid(g("token"))
            rows = q_all("""SELECT q.id,q.qid,q.module,q.kadian,q.stem,n.text,n.updated
                            FROM notes n JOIN qdb.questions q ON q.qid=n.qid
                            WHERE n.user_id=? AND TRIM(IFNULL(n.text,''))!=''
                            ORDER BY q.module, n.updated DESC""", (uid,))
            bymod = {}
            for r in rows:
                bymod.setdefault(r["module"] or "未分类", []).append(r)
            L = [f"# 我的笔记 · {today()}", "", f"> 共 {len(rows)} 条笔记", ""]
            for mod, items in bymod.items():
                L.append(f"## {mod}（{len(items)} 条）")
                for i, r in enumerate(items, 1):
                    L.append(f"\n### {i}. {plain_text(r['kadian'], 40) or '未命名考点'}")
                    L.append(f"- **题干摘要**：{plain_text(r['stem'], 80)}")
                    L.append(f"- **更新时间**：{r['updated'] or '—'}")
                    L.append(f"\n{r['text']}\n")
            return self._send(200, {"filename": f"我的笔记_{today().replace('-','')}.md",
                                    "count": len(rows), "text": "\n".join(L) + "\n"})

        return self._send(404, {"error": "no api"})

    # ---------- POST API ----------
    def _apply_grade(self, eqid, grade, uid=DEFAULT_UID, timeout=0, choice=None):
        """写入一次评分。含错题本状态机：连续 2 次自评「一般/熟悉」自动移出错题本。"""
        st = q_one("SELECT * FROM srs WHERE qid=? AND user_id=?", (eqid, uid))
        if not st:
            return None
        before = st["interval"]
        pacing = get_user_setting(uid, "review_pacing", "std") or "std"
        new = sm2.grade_state(st, grade, pacing)
        correct = 1 if grade >= 3 else 0
        wrong_now = (st["wrong"] or 0) + (0 if correct else 1)
        streak = st["wb_streak"] or 0
        wb = st["wb_status"] or "active"
        if wrong_now > 0:                      # 只有错过题的题才在错题本里
            if correct and grade >= 4:         # 一般(4) / 熟悉(5)
                streak += 1
                if streak >= 2:
                    wb = "cleared"             # 连续两次掌握 → 移出错题本
            else:
                streak = 0
                wb = "active"                  # 又答错/遗忘 → 回到待重练
        db().execute("""UPDATE srs SET status=?,ease=?,interval=?,repetitions=?,lapses=?,due=?,
                        last_review=?, correct=correct+?, wrong=wrong+?, wb_status=?, wb_streak=?,
                        last_choice=COALESCE(?,last_choice)
                        WHERE qid=? AND user_id=?""",
                     (new["status"], new["ease"], new["interval"], new["repetitions"], new["lapses"],
                      new["due"], now(), correct, 0 if correct else 1, wb, streak, choice, eqid, uid))
        db().execute("""INSERT INTO reviews(qid,user_id,grade,ts,interval_before,interval_after,ease,timeout)
                        VALUES(?,?,?,?,?,?,?,?)""",
                     (eqid, uid, grade, now(), before, new["interval"], new["ease"], 1 if timeout else 0))
        return new

    # ---------- 今日回溯：练习分组 / 逐题对答案状态 ----------
    def api_practice_start(self, p):
        """开始一组练习：先落组与题目骨架，未作答的题也能在回溯里显示为「未答」。"""
        uid = need_uid(p.get("token"))
        qids = [str(x).strip() for x in (p.get("qids") or []) if str(x).strip()][:300]
        if not qids:
            return self._send(400, {"error": "这一组没有题目"})
        gid = "g" + secrets.token_hex(8)
        mode = (p.get("mode") or "mix").strip()[:20]
        am = "deferred" if (p.get("answer_mode") == "deferred") else "instant"
        title = (p.get("title") or "").strip()[:40]
        scope = (p.get("scope") or "").strip()[:80]
        with _LOCK:
            db().execute("""INSERT INTO practice_groups(gid,uid,mode,answer_mode,title,scope,size,started,state)
                            VALUES(?,?,?,?,?,?,?,?,'open')""",
                         (gid, uid, mode, am, title, scope, len(qids), now()))
            for i, q in enumerate(qids, 1):
                db().execute("INSERT OR IGNORE INTO practice_items(gid,uid,qid,pos) VALUES(?,?,?,?)",
                             (gid, uid, q, i))
            db().commit()
        return self._send(200, {"ok": True, "gid": gid})

    def api_practice_mark(self, p):
        """写入某组若干题的作答状态。choice 非空时以后端算的客观正误为准。"""
        uid = need_uid(p.get("token"))
        gid = (p.get("gid") or "").strip()
        gp = q_one("SELECT gid FROM practice_groups WHERE gid=? AND uid=?", (gid, uid))
        if not gp:
            return self._send(404, {"error": "没有这组练习记录"})
        items = p.get("items") or []
        ts = now()
        with _LOCK:
            for it in items[:400]:
                qid = str(it.get("qid") or "").strip()
                if not qid:
                    continue
                row = q_one("SELECT answer FROM qdb.questions WHERE qid=?", (qid,))
                if not row:
                    continue
                ans = (row["answer"] or "").strip()
                choice = (it.get("choice") or "").strip()[:8]
                timeout = 1 if it.get("timeout") else 0
                if choice:
                    correct = 1 if choice.upper() == ans.upper() else 0
                else:                       # 复习自评 / 超时：没有选项，用前端给的判定
                    correct = 1 if it.get("correct") else 0
                ms = max(0, min(6 * 3600 * 1000, _int(it.get("ms"), 0)))
                pos = _int(it.get("pos"), 0)
                db().execute("""INSERT INTO practice_items(gid,uid,qid,pos,choice,answer,correct,timeout,ms,graded_at)
                                VALUES(?,?,?,?,?,?,?,?,?,?)
                                ON CONFLICT(gid,qid) DO UPDATE SET
                                  choice=excluded.choice, answer=excluded.answer,
                                  correct=excluded.correct, timeout=excluded.timeout,
                                  ms=excluded.ms, graded_at=excluded.graded_at,
                                  pos=CASE WHEN excluded.pos>0 THEN excluded.pos ELSE practice_items.pos END""",
                             (gid, uid, qid, pos, choice, ans, correct, timeout, ms, ts))
            if p.get("finish"):
                db().execute("""UPDATE practice_groups SET state='done', ended=?, total_ms=?
                                WHERE gid=? AND uid=?""",
                             (ts, max(0, _int(p.get("total_ms"), 0)), gid, uid))
            db().commit()
        return self._send(200, {"ok": True})

    def api_practice_end(self, p):
        """结束本组：记下结束时间与总用时（中途离开的组保持 open，回溯里显示「进行中」）。"""
        uid = need_uid(p.get("token"))
        gid = (p.get("gid") or "").strip()
        with _LOCK:
            n = db().execute("""UPDATE practice_groups SET state='done', ended=?, total_ms=?
                                WHERE gid=? AND uid=?""",
                             (now(), max(0, _int(p.get("total_ms"), 0)), gid, uid)).rowcount
            db().commit()
        if not n:
            return self._send(404, {"error": "没有这组练习记录"})
        return self._send(200, {"ok": True})

    def api_grade(self, p):
        try:
            qid_int = int(p.get("id")); grade = int(p.get("grade"))
        except Exception:
            return self._send(400, {"error": "id/grade required"})
        uid = need_uid(p.get("token"))
        timeout = 1 if p.get("timeout") else 0
        choice = (p.get("choice") or "").strip()[:4] or None
        eqid = resolve_qid(qid_int)
        if not eqid:
            return self._send(404, {"error": "no such question"})
        st = q_one("SELECT * FROM srs WHERE qid=? AND user_id=?", (eqid, uid))
        if not st:   # 按需生成：极端情况下（旧缓存页面、外部写入）也能正常评分
            ensure_srs_rows(uid, [eqid])
            st = q_one("SELECT * FROM srs WHERE qid=? AND user_id=?", (eqid, uid))
        with _LOCK:
            new = self._apply_grade(eqid, grade, uid, timeout, choice)
            db().commit()
        return self._send(200, {"ok": True, "eqid": eqid, **(new or {})})

    def api_note(self, p):
        eqid = resolve_qid(int(p.get("id", 0)))
        if not eqid:
            return self._send(404, {"error": "no question"})
        uid = need_uid(p.get("token"))
        text = (p.get("text") or "").strip()
        with _LOCK:
            if text:
                db().execute("INSERT OR REPLACE INTO notes(qid,user_id,text,updated) VALUES(?,?,?,?)",
                             (eqid, uid, text, now()))
            else:
                db().execute("DELETE FROM notes WHERE qid=? AND user_id=?", (eqid, uid))
            db().commit()
        return self._send(200, {"ok": True, "text": text})

    def api_fav(self, p):
        eqid = resolve_qid(int(p.get("id", 0)))
        if not eqid:
            return self._send(404, {"error": "no question"})
        uid = need_uid(p.get("token"))
        on = bool(p.get("on"))
        ensure_srs_rows(uid, [eqid])   # 没进度行就补一条，保证后续评分/错题本可用
        with _LOCK:
            if on:
                db().execute("INSERT OR IGNORE INTO favorites(qid,user_id,added) VALUES(?,?,?)", (eqid, uid, now()))
            else:
                db().execute("DELETE FROM favorites WHERE qid=? AND user_id=?", (eqid, uid))
            db().commit()
        return self._send(200, {"ok": True, "on": on})

    def api_discard(self, p):
        """丢弃 / 恢复一道题。

        丢弃 = 这题「我不想再做」，抽题时全部模式都排除；记录留着，真题浏览的「已丢弃」
        列表里能找回来并一键恢复，所以不需要二次确认弹窗之外的保护。
        """
        eqid = resolve_qid(int(p.get("id", 0) or 0))
        if not eqid:
            return self._send(404, {"error": "no question"})
        uid = need_uid(p.get("token"))
        on = bool(p.get("on", 1))
        with _LOCK:
            if on:
                db().execute("INSERT OR REPLACE INTO discarded(uid,qid,ts) VALUES(?,?,?)",
                             (uid, eqid, now()))
            else:
                db().execute("DELETE FROM discarded WHERE uid=? AND qid=?", (uid, eqid))
            db().commit()
        n = q_one("SELECT COUNT(*) n FROM discarded WHERE uid=?", (uid,))["n"]
        return self._send(200, {"ok": True, "on": on, "qid": eqid, "total": n})

    # ---------- 完整学习数据备份（JSON 导出 / 导入恢复） ----------
    def api_export_mydata(self, p):
        uid = need_uid(p.get("token"))
        out = {"format": "kaogong-backup-v1", "exported": now(),
               "srs": [], "reviews": [], "notes": [], "favorites": [],
               "doubt": [], "discarded": [], "exam": [], "study_time": [], "errors": []}
        try:
            u = q_one("SELECT id,IFNULL(username,'') username,IFNULL(name,'') name FROM users WHERE id=?", (uid,))
            out["user"] = dict(u) if u else {"id": uid}
        except Exception:
            out["user"] = {"id": uid}

        def dump(key, sql):
            try:
                out[key] = [dict(r) for r in q_all(sql, (uid,))]
            except Exception as e:
                out["errors"].append("%s: %s" % (key, e))

        dump("srs", "SELECT qid,status,ease,interval,repetitions,lapses,due,last_review,"
                    "correct,wrong,wb_status,wb_streak,last_choice FROM srs WHERE user_id=?")
        dump("reviews", "SELECT qid,grade,ts,interval_before,interval_after,ease,timeout "
                        "FROM reviews WHERE user_id=?")
        dump("notes", "SELECT qid,text,updated FROM notes WHERE user_id=?")
        dump("favorites", "SELECT qid,added FROM favorites WHERE user_id=?")
        dump("doubt", "SELECT qid,status,note,updated FROM doubt_status WHERE user_id=?")
        dump("exam", "SELECT title,total,correct,score,duration,ts FROM exam_history WHERE user_id=?")
        dump("discarded", "SELECT qid,ts FROM discarded WHERE uid=?")
        dump("study_time", "SELECT day,ms FROM study_time WHERE uid=?")
        out["counts"] = {k: len(out[k]) for k in ("srs", "reviews", "notes", "favorites",
                                                  "doubt", "discarded", "exam", "study_time")}
        fn = "kaogong-backup-%s.json" % today().replace("-", "")
        return self._send(200, out, extra={"Content-Disposition": 'attachment; filename="%s"' % fn})

    def api_import_mydata(self, p):
        """把备份 JSON 合并回当前账号：同一题取更晚的复习状态，计数取较大值，历史去重追加。"""
        uid = need_uid(p.get("token"))
        data = p.get("data") or {}
        if isinstance(data, str):
            try:
                data = json.loads(data)
            except Exception:
                return self._send(400, {"error": "备份内容不是合法 JSON"})
        if not isinstance(data, dict) or not str(data.get("format", "")).startswith("kaogong-backup"):
            return self._send(400, {"error": "不是本应用导出的备份文件"})
        n = {k: 0 for k in ("srs", "reviews", "notes", "favorites", "doubt", "discarded", "exam", "study_time")}
        cols = ("status", "ease", "interval", "repetitions", "lapses", "due", "last_review",
                "correct", "wrong", "wb_status", "wb_streak", "last_choice")
        with _LOCK:
            c = db()
            for r in data.get("srs") or []:
                qid = str(r.get("qid") or "")
                if not qid:
                    continue
                old = c.execute("SELECT correct,wrong,IFNULL(last_review,'') lr FROM srs WHERE qid=? AND user_id=?",
                                (qid, uid)).fetchone()
                nr = str(r.get("last_review") or "")
                if old and str(old["lr"]) > nr:
                    continue            # 现有进度更新，保留现有
                vals = [r.get(k) for k in cols]
                if old:
                    vals[cols.index("correct")] = max(int(old["correct"] or 0), int(r.get("correct") or 0))
                    vals[cols.index("wrong")] = max(int(old["wrong"] or 0), int(r.get("wrong") or 0))
                c.execute("INSERT OR REPLACE INTO srs(qid,user_id,%s) VALUES(?,?,%s)"
                          % (",".join(cols), ",".join("?" * len(cols))), [qid, uid] + vals)
                n["srs"] += 1
            for r in data.get("reviews") or []:
                qid = str(r.get("qid") or "")
                if not qid:
                    continue
                if c.execute("SELECT 1 FROM reviews WHERE user_id=? AND qid=? AND ts=?",
                             (uid, qid, r.get("ts"))).fetchone():
                    continue
                c.execute("INSERT INTO reviews(qid,user_id,grade,ts,interval_before,interval_after,ease,timeout) "
                          "VALUES(?,?,?,?,?,?,?,?)",
                          (qid, uid, r.get("grade"), r.get("ts"), r.get("interval_before"),
                           r.get("interval_after"), r.get("ease"), r.get("timeout") or 0))
                n["reviews"] += 1
            for r in data.get("notes") or []:
                qid, txt = str(r.get("qid") or ""), (r.get("text") or "")
                if not qid or not txt.strip():
                    continue
                old = c.execute("SELECT IFNULL(updated,'') u FROM notes WHERE qid=? AND user_id=?", (qid, uid)).fetchone()
                if old and str(old["u"]) > str(r.get("updated") or ""):
                    continue
                c.execute("INSERT OR REPLACE INTO notes(qid,user_id,text,updated) VALUES(?,?,?,?)",
                          (qid, uid, txt, r.get("updated") or now()))
                n["notes"] += 1
            for r in data.get("favorites") or []:
                qid = str(r.get("qid") or "")
                if not qid:
                    continue
                cur = c.execute("INSERT OR IGNORE INTO favorites(qid,user_id,added) VALUES(?,?,?)",
                                (qid, uid, r.get("added") or now()))
                n["favorites"] += cur.rowcount
            for r in data.get("doubt") or []:
                qid, st = str(r.get("qid") or ""), (r.get("status") or "")
                if not qid or st not in ("resolved", "open"):
                    continue
                c.execute("INSERT OR REPLACE INTO doubt_status(qid,user_id,status,note,updated) VALUES(?,?,?,?,?)",
                          (qid, uid, st, r.get("note") or "", r.get("updated") or now()))
                n["doubt"] += 1
            for r in data.get("discarded") or []:
                qid = str(r.get("qid") or "")
                if not qid:
                    continue
                cur = c.execute("INSERT OR IGNORE INTO discarded(uid,qid,ts) VALUES(?,?,?)",
                                (uid, qid, r.get("ts") or now()))
                n["discarded"] += cur.rowcount
            for r in data.get("study_time") or []:
                day = str(r.get("day") or "")
                if not day:
                    continue
                old = c.execute("SELECT ms FROM study_time WHERE uid=? AND day=?", (uid, day)).fetchone()
                ms = max(int(old["ms"] or 0) if old else 0, int(r.get("ms") or 0))
                c.execute("INSERT OR REPLACE INTO study_time(uid,day,ms) VALUES(?,?,?)", (uid, day, ms))
                n["study_time"] += 1
            for r in data.get("exam") or []:
                if not r.get("ts"):
                    continue
                if c.execute("SELECT 1 FROM exam_history WHERE user_id=? AND ts=?", (uid, r["ts"])).fetchone():
                    continue
                c.execute("INSERT INTO exam_history(title,total,correct,score,duration,ts,user_id) "
                          "VALUES(?,?,?,?,?,?,?)",
                          (r.get("title") or "模拟考试", r.get("total") or 0, r.get("correct") or 0,
                           r.get("score") or 0, r.get("duration") or 0, r.get("ts"), uid))
                n["exam"] += 1
            c.commit()
        _snapshot_user_db(force=True, tag="-import")
        return self._send(200, {"ok": True, "imported": n,
                                "total": sum(n.values()),
                                "exported_at": data.get("exported") or ""})

    def api_goal(self, p):
        uid = need_uid(p.get("token"))
        v = max(1, min(500, int(p.get("value", 120) or 120)))
        with _LOCK:
            set_user_setting(uid, "daily_goal", v)
            db().commit()
        return self._send(200, {"ok": True, "goal": v})

    def api_pacing(self, p):
        """复习节奏：tight 紧凑 ×0.7 / std 标准 ×1.0 / loose 舒缓 ×1.6，乘在每次算出的间隔上。"""
        uid = need_uid(p.get("token"))
        v = (p.get("value") or "std").strip()
        if v not in ("tight", "std", "loose"):
            return self._send(400, {"error": "不支持的节奏"})
        with _LOCK:
            set_user_setting(uid, "review_pacing", v)
            db().commit()
        return self._send(200, {"ok": True, "pacing": v})

    def api_review_plan(self, p):
        """复习计划：未来 30 天逐日到期题数 + 区间汇总，让「明天复习多少」看得见。"""
        uid = need_uid(p.get("token"))
        rows = q_all("""SELECT due, COUNT(*) n FROM srs WHERE user_id=? AND status!='new'
                        AND due IS NOT NULL AND due > date('now')
                        GROUP BY due""", (uid,))
        today_n = q_one("SELECT COUNT(*) n FROM srs WHERE user_id=? AND status!='new' AND due<=date('now')", (uid,))["n"]
        plan = {r["due"]: r["n"] for r in rows}
        return self._send(200, {"today": today_n, "plan": plan,
                                "pacing": get_user_setting(uid, "review_pacing", "std") or "std"})

    def api_doubt(self, p):
        eqid = resolve_qid(int(p.get("id", 0)))
        if not eqid:
            return self._send(404, {"error": "no question"})
        uid = need_uid(p.get("token"))
        status = (p.get("status") or "").strip()
        note = (p.get("note") or "").strip()
        with _LOCK:
            if status or note:
                db().execute("INSERT OR REPLACE INTO doubt_status(qid,user_id,status,note,updated) VALUES(?,?,?,?,?)",
                             (eqid, uid, status, note, now()))
            else:
                db().execute("DELETE FROM doubt_status WHERE qid=? AND user_id=?", (eqid, uid))
            db().commit()
        return self._send(200, {"ok": True, "status": status})

    def api_exam_submit(self, p):
        items = p.get("items") or []
        title = (p.get("title") or "模拟考试").strip()[:40]
        duration = int(p.get("duration") or 0)
        uid = need_uid(p.get("token"))
        total = len(items); correct = 0
        eqids = [resolve_qid(int(it.get("id", 0) or 0)) for it in items]
        ensure_srs_rows(uid, [q for q in eqids if q])   # 交卷前统一补行（一次写）
        with _LOCK:
            for it, eqid in zip(items, eqids):
                if not eqid:
                    continue
                ok = bool(it.get("correct"))
                if ok:
                    correct += 1
                self._apply_grade(eqid, 4 if ok else 1, uid, 1 if it.get("timeout") else 0)
            score = round(correct / total * 100, 1) if total else 0
            db().execute("""INSERT INTO exam_history(title,total,correct,score,duration,ts,user_id)
                            VALUES(?,?,?,?,?,?,?)""", (title, total, correct, score, duration, now(), uid))
            db().commit()
        return self._send(200, {"ok": True, "total": total, "correct": correct, "score": score})


    # ---------- 账号：注册 / 登录 / 退出 / 密码 ----------
    def _new_uid(self):
        """生成新账号 id（不限制账号数量）。"""
        return "u" + secrets.token_hex(8)

    def _issue(self, uid):
        """签发新 token 并返回账号公开信息。"""
        tok = new_token()
        try:
            # 只新增一条会话，不覆盖 users.token 之外的东西：另一台设备的 token 依旧有效
            db().execute("INSERT OR REPLACE INTO sessions(token,uid,created) VALUES(?,?,?)",
                         (tok, uid, now()))
            db().execute("UPDATE users SET token=? WHERE id=?", (tok, uid))
            db().commit()
        except Exception:
            db().rollback()
            raise
        r = q_one("""SELECT id,name,username,anon,IFNULL(role,'student') role,
                            IFNULL(link_code,'') link_code FROM users WHERE id=?""", (uid,))
        return {"ok": True, "token": tok, "user": {"id": r["id"], "name": r["name"], "username": r["username"],
                                                  "anon": bool(r["anon"]), "role": r["role"] or "student",
                                                  "link_code": r["link_code"] or ""}}

    def api_auth_register(self, p):
        username = (p.get("username") or "").strip()
        name = (p.get("name") or username).strip()[:12]
        pw = p.get("password") or ""
        if len(username) < 2 or len(username) > 20:
            return self._send(400, {"error": "用户名需 2-20 个字符"})
        if not re.fullmatch(r"[\w一-龥\-]+", username):
            return self._send(400, {"error": "用户名仅支持中文、字母、数字、下划线、连字符"})
        if len(pw) < 6:
            return self._send(400, {"error": "密码至少 6 位"})
        if q_one("SELECT 1 FROM users WHERE username=?", (username,)):
            return self._send(400, {"error": "该用户名已被注册，换一个试试"})
        uid = self._new_uid()
        with _LOCK:
            try:
                db().execute("INSERT INTO users(id,name,username,pw_hash,token,created) VALUES(?,?,?,?,?,?)",
                             (uid, name or username, username, pw_hash(pw), "", now()))
                init_user_srs(uid)      # 新账号初始化一套空白进度
                db().commit()
            except Exception:
                db().rollback()     # 失败整体回滚，不留半截账号
                raise
        return self._send(200, self._issue(uid))

    def api_auth_login(self, p):
        username = (p.get("username") or "").strip()
        pw = p.get("password") or ""
        r = q_one("SELECT * FROM users WHERE username=?", (username,))
        if not r:
            return self._send(401, {"error": "用户名或密码错误"})
        if not r["pw_hash"]:
            # 老账号尚未设置密码：提示前端进入「补设密码」流程
            return self._send(200, {"ok": False, "need_password": True, "username": username})
        if not pw_verify(pw, r["pw_hash"]):
            return self._send(401, {"error": "用户名或密码错误"})
        return self._send(200, self._issue(r["id"]))

    def api_auth_logout(self, p):
        tok = (p.get("token") or "").strip()
        if tok:
            uid = auth_uid(tok)          # 先按会话表解析，旧版单 token 也能识别
            with _LOCK:
                u = q_one("SELECT id,anon FROM users WHERE id=?", (uid,)) if uid else None
                if u and u["anon"]:
                    # 游客账号：退出即彻底清除，不留痕迹
                    for t in ("srs", "reviews", "notes", "favorites", "doubt_status", "exam_history"):
                        db().execute(f"DELETE FROM {t} WHERE user_id=?", (u["id"],))
                    db().execute("DELETE FROM study_time WHERE uid=?", (u["id"],))
                    db().execute("DELETE FROM sessions WHERE uid=?", (u["id"],))
                    db().execute("DELETE FROM user_settings WHERE uid=?", (u["id"],))
                    db().execute("DELETE FROM users WHERE id=?", (u["id"],))
                else:
                    db().execute("DELETE FROM sessions WHERE token=?", (tok,))
                    db().execute("UPDATE users SET token='' WHERE token=?", (tok,))
                db().commit()
        return self._send(200, {"ok": True})

    def api_auth_guest(self, p):
        """游客模式（匿名）：免注册，自动生成仅本浏览器可见的云端身份。
        数据落服务端但与该 token 绑定；换浏览器/清缓存即新身份，彼此隔离。"""
        uid = self._new_uid()
        suffix = ''.join(secrets.choice("0123456789") for _ in range(4))
        username = "游客" + suffix
        while q_one("SELECT 1 FROM users WHERE username=?", (username,)):
            suffix = ''.join(secrets.choice("0123456789") for _ in range(4))
            username = "游客" + suffix
        with _LOCK:
            try:
                db().execute("INSERT INTO users(id,name,username,pw_hash,token,created,anon) VALUES(?,?,?,?,?,?,1)",
                             (uid, username, username, None, "", now()))
                init_user_srs(uid)
                db().commit()
            except Exception:
                db().rollback()
                raise
        return self._send(200, self._issue(uid))

    def api_auth_upgrade(self, p):
        """游客账号升级为正式账号：设定用户名 + 密码，解除匿名。"""
        uid = need_uid(p.get("token"))
        r = q_one("SELECT * FROM users WHERE id=?", (uid,))
        if not r["anon"]:
            return self._send(400, {"error": "该账号已是正式账号"})
        username = (p.get("username") or "").strip()
        pw = p.get("password") or ""
        if len(username) < 2 or len(username) > 20:
            return self._send(400, {"error": "用户名需 2-20 个字符"})
        if not re.fullmatch(r"[\w一-龥\-]+", username):
            return self._send(400, {"error": "用户名仅支持中文、字母、数字、下划线、连字符"})
        if len(pw) < 6:
            return self._send(400, {"error": "密码至少 6 位"})
        if q_one("SELECT 1 FROM users WHERE username=?", (username,)):
            return self._send(400, {"error": "该用户名已被占用，换一个试试"})
        with _LOCK:
            db().execute("UPDATE users SET username=?, name=?, pw_hash=?, anon=0 WHERE id=?",
                         (username, username, pw_hash(pw), uid))
            db().commit()
        return self._send(200, self._issue(uid))

    def api_auth_password(self, p):
        """修改密码（需已登录）；也用于老账号首次补设密码。"""
        uid = auth_uid(p.get("token"))
        old = p.get("old_password")
        newpw = p.get("password") or ""
        if len(newpw) < 6:
            return self._send(400, {"error": "新密码至少 6 位"})
        if not uid:
            # 未登录 → 走老账号补设：凭用户名 + 该账号当前无密码
            username = (p.get("username") or "").strip()
            r = q_one("SELECT * FROM users WHERE username=?", (username,))
            if not r or r["pw_hash"]:
                return self._send(401, {"error": "请重新登录后再修改密码"})
            uid = r["id"]
        else:
            r = q_one("SELECT * FROM users WHERE id=?", (uid,))
            if r["pw_hash"] and not pw_verify(old or "", r["pw_hash"]):
                return self._send(400, {"error": "原密码不正确"})
        with _LOCK:
            db().execute("UPDATE users SET pw_hash=? WHERE id=?", (pw_hash(newpw), uid))
            db().commit()
        return self._send(200, self._issue(uid))

    def api_auth_claim(self, p):
        """老账号首次补设密码：仅当该账号尚无密码时可用（一次性）。"""
        username = (p.get("username") or "").strip()
        pw = p.get("password") or ""
        legacy_id = (p.get("legacy_id") or "").strip()
        if len(pw) < 6:
            return self._send(400, {"error": "密码至少 6 位"})
        r = q_one("SELECT * FROM users WHERE username=?", (username,))
        if not r:
            return self._send(400, {"error": "账号不存在"})
        if r["pw_hash"]:
            return self._send(400, {"error": "该账号已设置密码，请直接登录"})
        # 必须携带本机此前保存的账号标识，避免陌生人抢注他人老账号
        if legacy_id and legacy_id != r["id"]:
            return self._send(400, {"error": "账号标识不匹配"})
        with _LOCK:
            db().execute("UPDATE users SET pw_hash=? WHERE id=?", (pw_hash(pw), r["id"]))
            db().commit()
        return self._send(200, self._issue(r["id"]))

    def api_users_rename(self, p):
        uid = need_uid(p.get("token"))
        name = (p.get("name") or "").strip()[:12]
        if not name:
            return self._send(400, {"error": "昵称不能为空"})
        with _LOCK:
            db().execute("UPDATE users SET name=? WHERE id=?", (name, uid))
            db().commit()
        return self._send(200, {"ok": True, "name": name})

    def api_admin_account_update(self, p):
        need_admin(p.get("token"))
        uid = str(p.get("uid") or "").strip()
        row = q_one("SELECT id FROM users WHERE id=?", (uid,))
        if not row:
            return self._send(404, {"error": "账号不存在"})
        name = str(p.get("name") or "").strip()[:40]
        username = str(p.get("username") or "").strip()[:40]
        password = str(p.get("password") or "")
        if not name or not username:
            return self._send(400, {"error": "名称和用户名不能为空"})
        if password and len(password) < 6:
            return self._send(400, {"error": "密码至少需要 6 位"})
        if q_one("SELECT id FROM users WHERE username=? AND id<>?", (username, uid)):
            return self._send(409, {"error": "用户名已被使用"})
        with _LOCK:
            if password:
                db().execute("UPDATE users SET name=?,username=?,pw_hash=? WHERE id=?",
                             (name, username, pw_hash(password), uid))
            else:
                db().execute("UPDATE users SET name=?,username=? WHERE id=?", (name, username, uid))
            db().commit()
        return self._send(200, {"ok": True})

    def api_admin_account_delete(self, p):
        admin_uid = need_admin(p.get("token"))
        uid = str(p.get("uid") or "").strip()
        row = q_one("SELECT id,role FROM users WHERE id=?", (uid,))
        if not row:
            return self._send(404, {"error": "账号不存在"})
        if uid == admin_uid:
            return self._send(400, {"error": "不能删除当前管理员账号"})
        if row["role"] == "admin" and q_one("SELECT COUNT(*) n FROM users WHERE role='admin'")["n"] <= 1:
            return self._send(400, {"error": "不能删除最后一个管理员"})
        with _LOCK:
            _delete_account_data(uid)
            db().execute("DELETE FROM users WHERE id=?", (uid,))
            db().commit()
        return self._send(200, {"ok": True})

    def api_backup_config(self, p):
        need_admin(p.get("token"))
        path = str(p.get("path") or "").strip()
        if path:
            path = os.path.abspath(os.path.expanduser(path))
            data_dir = os.path.abspath(os.path.dirname(USERS_DB_PATH))
            if path == data_dir or path.startswith(data_dir + os.sep):
                return self._send(400, {"error": "备份目录不能位于用户库目录内"})
            try:
                os.makedirs(path, exist_ok=True)
                probe = os.path.join(path, ".kaogong-write-test")
                with open(probe, "wb") as f:
                    f.write(b"ok")
                os.remove(probe)
            except Exception as e:
                return self._send(400, {"error": "目录不可写：%s" % e})
        with _LOCK:
            set_setting("backup_local_path", path)
            db().commit()
        if path:
            _snapshot_user_db(force=True, tag="-local")
        return self._send(200, {"ok": True, "path": path})

    def api_backup_run(self, p):
        need_admin(p.get("token"))
        snap = _snapshot_user_db(force=True)
        return self._send(200 if snap else 500, {"ok": bool(snap), "path": snap or "",
                                                  "error": "快照失败" if not snap else ""})

    def api_backup_restore(self, p):
        need_admin(p.get("token"))
        name = str(p.get("name") or "")
        if not name or os.path.basename(name) != name:
            return self._send(400, {"error": "快照名称无效"})
        folders = [BACKUP_DIR]
        local = _backup_config().get("path")
        if local:
            folders.append(local)
        src = next((os.path.join(d, name) for d in folders if os.path.isfile(os.path.join(d, name))), None)
        if not src:
            return self._send(404, {"error": "找不到该快照"})
        try:
            check = sqlite3.connect("file:%s?mode=ro" % urllib.parse.quote(os.path.abspath(src)), uri=True)
            valid = check.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
            has_users = check.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='users'").fetchone()
            check.close()
            if not valid or not has_users:
                return self._send(400, {"error": "快照校验失败"})
            safety = _snapshot_user_db(force=True, tag="-prerestore")
            if not safety:
                return self._send(500, {"error": "恢复前快照失败，已取消恢复"})
            with _LOCK:
                source = sqlite3.connect(src, timeout=10)
                source.backup(db())
                db().commit()
                source.close()
            return self._send(200, {"ok": True, "restored": name, "safety_snapshot": safety})
        except Exception as e:
            return self._send(500, {"error": "恢复失败：%s" % e})

    PREFS_KEYS = ("limits", "limitOn", "theme", "fontscale", "focus", "navfit",
                  "answerMode", "readw", "sessionSize", "rmouse", "seen")

    def api_prefs(self, p):
        """保存本机偏好到当前账号。写入为「合并」：seen 取并集（保留最近 800 条），
        limits 按模块合并，其余字段后写覆盖先写，避免多设备互相清空。"""
        uid = need_uid(p.get("token"))
        d = p.get("prefs")
        if not isinstance(d, dict):
            return self._send(400, {"ok": False, "error": "prefs 必须是对象"})
        cur = {}
        raw = get_user_setting(uid, "prefs")
        if raw:
            try:
                cur = json.loads(raw) or {}
            except Exception:
                cur = {}
        if not isinstance(cur, dict):
            cur = {}
        merged = dict(cur)
        for k in self.PREFS_KEYS:
            if k not in d:
                continue
            v = d[k]
            if k == "seen":
                if isinstance(v, list):
                    seq = []
                    for q in list(cur.get("seen") or []) + [str(x) for x in v]:
                        if q and q not in seq:
                            seq.append(q)
                    merged["seen"] = seq[-800:]
                continue
            if k == "limits":
                if isinstance(v, dict):
                    lm = dict(cur.get("limits") or {})
                    for a, b in v.items():
                        try:
                            lm[str(a)] = max(1, min(500, int(b)))
                        except Exception:
                            pass
                    merged["limits"] = lm
                continue
            merged[k] = v
        ts = now()
        with _LOCK:
            set_user_setting(uid, "prefs", json.dumps(merged, ensure_ascii=False))
            set_user_setting(uid, "prefs_at", ts)
            db().commit()
        return self._send(200, {"ok": True, "updated": ts})

    def api_study_time(self, p):
        """累计学习时长（毫秒）。前端在答题页 / 解析页按秒累计，每 20 秒或离开页面时上报一次。
        单次上限 6 小时，避免异常数据把统计冲爆。"""
        uid = need_uid(p.get("token"))
        try:
            ms = int(p.get("ms") or 0)
        except (TypeError, ValueError):
            ms = 0
        ms = max(0, min(ms, 6 * 3600 * 1000))
        d = today()
        if ms:
            with _LOCK:
                db().execute("INSERT OR IGNORE INTO study_time(uid,day,ms) VALUES(?,?,0)", (uid, d))
                db().execute("UPDATE study_time SET ms=ms+? WHERE uid=? AND day=?", (ms, uid, d))
                db().commit()
        cur = q_one("SELECT ms FROM study_time WHERE uid=? AND day=?", (uid, d))
        tot = q_one("SELECT SUM(ms) s FROM study_time WHERE uid=?", (uid,))
        return self._send(200, {
            "ok": True, "added": ms,
            "today_ms": int((cur or {}).get("ms") or 0),
            "total_ms": int((tot or {}).get("s") or 0),
        })

    def api_account_reset(self, p):
        """清空当前账号的做题信息：答题/复习记录、模考历史、进度与统计全部归零。
        收藏、笔记、疑点标记属于用户资产，保留不清。"""
        uid = need_uid(p.get("token"))
        with _LOCK:
            n_srs = db().execute("DELETE FROM srs WHERE user_id=?", (uid,)).rowcount
            n_rev = db().execute("DELETE FROM reviews WHERE user_id=?", (uid,)).rowcount
            n_exam = db().execute("DELETE FROM exam_history WHERE user_id=?", (uid,)).rowcount
            db().execute("DELETE FROM practice_items WHERE uid=?", (uid,))
            db().execute("DELETE FROM practice_groups WHERE uid=?", (uid,))
            n_time = db().execute("DELETE FROM study_time WHERE uid=?", (uid,)).rowcount
            n_drop = db().execute("DELETE FROM discarded WHERE uid=?", (uid,)).rowcount
            # 偏好里还存着「已做题目缓存」，不清掉的话换设备登录又会被拉回来
            raw = get_user_setting(uid, "prefs")
            if raw:
                try:
                    pf = json.loads(raw) or {}
                except Exception:
                    pf = {}
                if isinstance(pf, dict) and pf.get("seen"):
                    pf["seen"] = []
                    set_user_setting(uid, "prefs", json.dumps(pf, ensure_ascii=False))
                    set_user_setting(uid, "prefs_at", now())
            db().commit()
        return self._send(200, {"ok": True, "srs": n_srs, "reviews": n_rev, "exams": n_exam,
                                "study_time": n_time, "discarded": n_drop})

    # ---------- 陪伴者（只读督导） ----------
    def _student_brief(self, uid, full=False):
        """陪伴者的列表/详情共用的陪读摘要（纯读，不改任何记录）。

        口径与陪读自己的总览面板（/api/stats）保持一致：
        今日待复习 / 未学新题 / 今日已练习 / 已纳入复习 / 错题本 / 收藏 / 今日学习时长 / 总学习时长。
        full=True 时额外给「各模块进度」与「掌握度分布」（各模块要扫题库，只在详情页算）。
        """
        t = today()
        learned = q_one("SELECT COUNT(*) n FROM srs WHERE user_id=? AND status!='new'", (uid,))["n"]
        due = q_one("SELECT COUNT(*) n FROM srs WHERE user_id=? AND status!='new' AND due<=?", (uid, t))["n"]
        wrong = q_one("SELECT COUNT(*) n FROM srs WHERE user_id=? AND wrong>0", (uid,))["n"]
        today_n = q_one("SELECT COUNT(DISTINCT qid) n FROM reviews WHERE user_id=? AND date(ts)=?", (uid, t))["n"]
        ans = q_one("""SELECT COUNT(*) n, SUM(CASE WHEN grade>=3 THEN 1 ELSE 0 END) ok
                       FROM reviews WHERE user_id=?""", (uid,)) or {}
        st_today = q_one("SELECT ms FROM study_time WHERE uid=? AND day=?", (uid, t))
        st_all = q_one("SELECT SUM(ms) s FROM study_time WHERE uid=?", (uid,))
        last = q_one("SELECT MAX(ts) ts FROM reviews WHERE user_id=?", (uid,))
        fav = q_one("SELECT COUNT(*) n FROM favorites WHERE user_id=?", (uid,))["n"]
        total_q = q_total()
        live = live_get(uid)
        n = int(ans.get("n") or 0); ok = int(ans.get("ok") or 0)
        out = {
            "learned": learned, "due_review": due, "wrong": wrong, "studied_today": today_n,
            "new": max(0, total_q - learned), "fav": fav, "total": total_q,
            "answered": n, "accuracy": round(ok * 100.0 / n, 1) if n else 0,
            "today_ms": int((st_today or {}).get("ms") or 0),
            "total_ms": int((st_all or {}).get("s") or 0),
            "last_ts": (last or {}).get("ts") or "",
            "online": bool(live and live.get("online")),
            "live": live or {"online": False, "status": "idle"},
        }
        if full:
            out["by_module"] = q_all("""SELECT q.module m, COUNT(*) total,
                                        SUM(CASE WHEN s.qid IS NOT NULL AND s.status!='new' THEN 1 ELSE 0 END) learned
                                        FROM qdb.questions q LEFT JOIN srs s ON s.qid=q.qid AND s.user_id=?
                                        GROUP BY q.module""", (uid,))
            out["due_by_module"] = q_all("""SELECT q.module m, COUNT(*) n FROM srs s JOIN qdb.questions q ON q.qid=s.qid
                                            WHERE s.user_id=? AND s.status!='new' AND s.due<=? GROUP BY q.module""",
                                         (uid, t))
            buckets = {"学习中": 0, "初记": 0, "短期": 0, "长期": 0, "稳固": 0}
            for r in q_all("SELECT interval FROM srs WHERE user_id=? AND status!='new'", (uid,)):
                buckets[sm2.mastery_bucket(r["interval"])] += 1
            out["mastery"] = buckets
        return out

    def _username_err(self, username):
        if len(username) < 2 or len(username) > 20:
            return "用户名需 2-20 个字符"
        if not re.fullmatch(r"[\w一-龥\-]+", username):
            return "用户名仅支持中文、字母、数字、下划线、连字符"
        return ""

    def api_live_ping(self, p):
        """陪读端答题心跳：陪伴者端据此实时看到"正在答哪一题"。只写内存，不落库。"""
        uid = need_uid(p.get("token"))
        if user_role(uid) == "teacher":
            return self._send(403, {"error": "陪伴者账号为只读模式"})
        d = {"status": "idle"}
        for k in ("status", "mode", "idx", "total", "answered", "right", "wrong",
                  "q_ms", "all_ms", "paused", "choice", "submitted", "started_at", "id"):
            if k in p and not isinstance(p.get(k), (dict, list)):
                d[k] = p.get(k)
        # 选项也带过来：陪伴者光看题干无法判断孩子在做什么，必须能看到四个选项
        # （图形推理的选项本身就是图片，所以带原文 HTML，纯文本只作兜底）
        opts = p.get("options")
        if isinstance(opts, list) and opts:
            d["options"] = []
            for o in opts[:6]:
                if not isinstance(o, dict):
                    continue
                raw = str(o.get("label") or "")
                d["options"].append({"key": str(o.get("key") or "")[:2],
                                     "label": brief_text(raw, 200),
                                     "html": raw[:600]})
        qid = str(p.get("qid") or "").strip()
        if qid:
            q = q_one("SELECT module, category, stem, material FROM qdb.questions WHERE qid=?", (qid,))
            if q:
                d["qid"] = qid
                d["module"] = q["module"]
                d["category"] = q["category"]
                # 纯文本摘要（兜底 / 截断判断）
                d["stem"] = brief_text(q["stem"], 3000)
                mat = brief_text(q["material"] or "", 5000)
                if mat:
                    d["material"] = mat
                # 原文 HTML：资料分析的图表/公式都是 <img>，纯文本会全变成「［图］」，
                # 陪伴者根本看不懂孩子在读什么，所以看板直接按练习页的方式渲染原文
                sh, mh = q["stem"] or "", q["material"] or ""
                d["stem_html"] = sh[:12000]
                if mh:
                    d["material_html"] = mh[:20000]
                d["cut"] = len(sh) > 12000 or len(mh) > 20000
        live_put(uid, d)
        return self._send(200, {"ok": True})

    def api_teacher_register(self, p):
        """添加陪伴者：用对方的「用户名 + 链接码」即可，不需要对方密码。

        链接码由对方在自己的「设置 → 陪伴者」里设定（2-8 位），相当于一次性授权凭证：
        知道用户名 + 链接码，就能把对方加进我的陪伴圈（双向：双方都能看对方、互相推题）。
        """
        uid = need_uid(p.get("token"))
        username = (p.get("username") or "").strip()
        code = (p.get("code") or "").strip()
        if not username:
            return self._send(400, {"error": "请填写对方的用户名"})
        if not re.fullmatch(r"[0-9A-Za-z]{2,8}", code):
            return self._send(400, {"error": "链接码为 2-8 位字母或数字"})
        r = q_one("SELECT id,name,username,IFNULL(link_code,'') code FROM users WHERE username=?", (username,))
        if not r:
            return self._send(404, {"error": "没有这个用户名的账号"})
        if r["id"] == uid:
            return self._send(400, {"error": "不能添加自己为陪伴者"})
        if not r["code"]:
            return self._send(400, {"error": "对方还没有设置链接码，请他先在「设置 → 陪伴者」里设置"})
        if r["code"] != code:
            return self._send(401, {"error": "链接码不正确"})
        with _LOCK:
            db().execute("INSERT OR IGNORE INTO teacher_links(teacher_uid,student_uid,created) VALUES(?,?,?)",
                         (r["id"], uid, now()))
            db().commit()
        return self._send(200, {"ok": True, "created": False,
                                "peer": {"id": r["id"], "name": r["name"] or r["username"],
                                         "username": r["username"]}})

    def api_teacher_link(self, p):
        """兼容旧接口：陪伴者加陪读。现在统一走链接码，不再需要密码。"""
        return self.api_teacher_register(p)

    def api_teacher_unlink(self, p):
        """解除陪伴关系（双向一起解除）。"""
        uid = need_uid(p.get("token"))
        peer = (p.get("uid") or "").strip()
        with _LOCK:
            db().execute("""DELETE FROM teacher_links
                            WHERE (teacher_uid=? AND student_uid=?) OR (teacher_uid=? AND student_uid=?)""",
                         (uid, peer, peer, uid))
            db().commit()
        return self._send(200, {"ok": True})

    def api_teacher_detach(self, p):
        """兼容旧接口：解除陪伴关系。"""
        tid = (p.get("teacher_uid") or "").strip()
        p2 = dict(p); p2["uid"] = tid
        return self.api_teacher_unlink(p2)

    def api_teacher_encourage(self, p):
        tid = need_uid(p.get("token"))
        text = (p.get("text") or "").strip()[:300]
        image = p.get("image") or ""
        target = (p.get("student_uid") or "*").strip() or "*"
        if target != "*" and not link_ok(tid, target):
            return self._send(403, {"error": "没有该陪伴对象的权限"})
        if not text and not image:
            return self._send(400, {"error": "写点文字或选一张照片吧"})
        if image and not image.startswith("data:image/"):
            return self._send(400, {"error": "图片格式不支持"})
        if len(image) > 2_400_000:
            return self._send(400, {"error": "图片过大，请换一张（建议 2MB 以内）"})
        with _LOCK:
            cur = db().execute("""INSERT INTO encouragements
                                  (teacher_uid, student_uid, text, image, ts, parent_id, author_uid, role, read_ts)
                                  VALUES(?,?,?,?,?,0,?,'teacher','')""",
                               (tid, target, text, image, now(), tid))
            db().commit()
            eid = cur.lastrowid
        return self._send(200, {"ok": True, "id": eid})

    def api_teacher_encourage_delete(self, p):
        tid = need_uid(p.get("token"))
        eid = _int(p.get("id"), 0)
        with _LOCK:
            # 删的是整条线程：根留言和它下面的往来一起消失
            db().execute("DELETE FROM encouragements WHERE teacher_uid=? AND (id=? OR parent_id=?)",
                         (tid, eid, eid))
            db().commit()
        return self._send(200, {"ok": True})

    def api_linkcode(self, p):
        """设置 / 修改自己的链接码（2-8 位字母数字）。别人凭「用户名 + 链接码」加我为陪伴者。"""
        uid = need_uid(p.get("token"))
        code = (p.get("code") or "").strip()
        if not code:
            # 空值 = 清除链接码，别人就无法再用链接码加我
            with _LOCK:
                db().execute("UPDATE users SET link_code='' WHERE id=?", (uid,))
                db().commit()
            return self._send(200, {"ok": True, "code": ""})
        if not re.fullmatch(r"[0-9A-Za-z]{2,8}", code):
            return self._send(400, {"error": "链接码为 2-8 位字母或数字"})
        with _LOCK:
            db().execute("UPDATE users SET link_code=? WHERE id=?", (code, uid))
            db().commit()
        return self._send(200, {"ok": True, "code": code})

    def api_push(self, p):
        """推题：把任意题目推给陪伴关系中的某个人（双向）。接收方在「陪伴者」模块查看。"""
        uid = need_uid(p.get("token"))
        to = (p.get("to_uid") or "").strip()
        note = (p.get("note") or "").strip()[:200]
        qidn = _int(p.get("id"), 0)
        qid_s = (p.get("qid") or "").strip()
        row = (q_one("SELECT qid FROM qdb.questions WHERE id=?", (qidn,)) if qidn
               else q_one("SELECT qid FROM qdb.questions WHERE qid=?", (qid_s,)))
        if not row:
            return self._send(404, {"error": "题目不存在"})
        if not to:
            return self._send(400, {"error": "请选择要推送给谁"})
        if to == uid:
            return self._send(400, {"error": "不能推给自己"})
        if not link_ok(uid, to):
            return self._send(403, {"error": "你们还不是陪伴关系，先在「陪伴者」模块互相添加"})
        with _LOCK:
            cur = db().execute("""INSERT INTO pushed_questions(from_uid,to_uid,qid,note,ts,read_ts)
                                  VALUES(?,?,?,?,?,'')""", (uid, to, row["qid"], note, now()))
            db().commit()
            pid = cur.lastrowid
        return self._send(200, {"ok": True, "id": pid})

    def api_push_list(self, p):
        """推题收发件箱。box=in（收到的）/ out（我推出去的）。"""
        uid = need_uid(p.get("token"))
        box = (p.get("box") or "in").strip()
        if box == "out":
            rows = q_all("""SELECT x.id, x.qid, x.note, x.ts, x.read_ts, x.from_uid, x.to_uid,
                                   IFNULL(u.name,u.username) peer_name, u.username peer_username,
                                   q.id qn, q.module, q.category, q.stem
                            FROM pushed_questions x
                            LEFT JOIN users u ON u.id=x.to_uid
                            LEFT JOIN qdb.questions q ON q.qid=x.qid
                            WHERE x.from_uid=? ORDER BY x.id DESC LIMIT 60""", (uid,))
        else:
            rows = q_all("""SELECT x.id, x.qid, x.note, x.ts, x.read_ts, x.from_uid, x.to_uid,
                                   IFNULL(u.name,u.username) peer_name, u.username peer_username,
                                   q.id qn, q.module, q.category, q.stem
                            FROM pushed_questions x
                            LEFT JOIN users u ON u.id=x.from_uid
                            LEFT JOIN qdb.questions q ON q.qid=x.qid
                            WHERE x.to_uid=? ORDER BY x.id DESC LIMIT 60""", (uid,))
        for r in rows:
            r["stem"] = plain_text(r["stem"], 120)
        unread = q_one("SELECT COUNT(*) n FROM pushed_questions WHERE to_uid=? AND IFNULL(read_ts,'')=''",
                       (uid,))["n"]
        return self._send(200, {"ok": True, "items": rows, "unread": unread})

    def api_push_read(self, p):
        """把收到的推题标为已读（传 id 标一条，不传标全部）。"""
        uid = need_uid(p.get("token"))
        pid = _int(p.get("id"), 0)
        with _LOCK:
            if pid:
                db().execute("UPDATE pushed_questions SET read_ts=? WHERE id=? AND to_uid=?",
                             (now(), pid, uid))
            else:
                db().execute("UPDATE pushed_questions SET read_ts=? WHERE to_uid=? AND IFNULL(read_ts,'')=''",
                             (now(), uid))
            db().commit()
        return self._send(200, {"ok": True})

    def api_encourage_reply(self, p):
        """寄语回复：双方共用，按登录身份决定这条消息算谁说的。

        陪伴者回给某位陪读时必须指定 sid（从哪条会话里点的），
        且这位陪读要么是这条寄语的指定对象，要么已经在这条寄语下回过话。
        """
        uid = need_uid(p.get("token"))
        rid = _int(p.get("id"), 0)
        text = (p.get("text") or "").strip()[:1000]
        image = p.get("image") or ""
        if not text and not image:
            return self._send(400, {"error": "写点内容或选一张照片再发吧"})
        if image and not image.startswith("data:image/"):
            return self._send(400, {"error": "图片格式不支持"})
        if len(image) > 2_400_000:
            return self._send(400, {"error": "图片过大，请换一张（建议 2MB 以内）"})
        root = q_one("""SELECT id, teacher_uid, student_uid, text FROM encouragements
                        WHERE id=? AND IFNULL(parent_id,0)=0""", (rid,))
        if not root:
            return self._send(404, {"error": "这条寄语不存在"})
        is_t = user_role(uid) == "teacher"
        if is_t:
            if root["teacher_uid"] != uid:
                return self._send(403, {"error": "只能回复自己发布的寄语"})
            sid = (p.get("sid") or "").strip() or (root["student_uid"] if root["student_uid"] != "*" else "")
            if not sid or not link_ok(uid, sid):
                return self._send(403, {"error": "没有该陪读的权限"})
            if root["student_uid"] != sid:
                joined = q_one("""SELECT 1 n FROM encouragements
                                  WHERE parent_id=? AND student_uid=? LIMIT 1""", (rid, sid))
                if not joined:
                    return self._send(403, {"error": "这位陪读还没在这条寄语下留过言"})
        else:
            sid = uid
            if root["student_uid"] not in ("*", uid) or not link_ok(root["teacher_uid"], uid):
                return self._send(403, {"error": "没有这条寄语的回复权限"})
        with _LOCK:
            cur = db().execute("""INSERT INTO encouragements
                                  (teacher_uid, student_uid, text, image, ts, parent_id, author_uid, role, read_ts)
                                  VALUES(?,?,?,?,?,?,?,?,'')""",
                               (root["teacher_uid"], sid, text, image, now(), rid, uid,
                                "teacher" if is_t else "student"))
            db().commit()
            nid = cur.lastrowid
        return self._send(200, {"ok": True, "id": nid})

    def api_users_delete(self, p):
        """删除当前登录账号及其全部学习数据（需再次输入密码确认）。"""
        uid = need_uid(p.get("token"))
        r = q_one("SELECT * FROM users WHERE id=?", (uid,))
        if not pw_verify(p.get("password") or "", r["pw_hash"] or ""):
            return self._send(400, {"error": "密码不正确，删除已取消"})
        with _LOCK:
            for t in ("srs", "reviews", "notes", "favorites", "doubt_status", "exam_history"):
                db().execute(f"DELETE FROM {t} WHERE user_id=?", (uid,))
            db().execute("DELETE FROM practice_items WHERE uid=?", (uid,))
            db().execute("DELETE FROM practice_groups WHERE uid=?", (uid,))
            db().execute("DELETE FROM study_time WHERE uid=?", (uid,))
            db().execute("DELETE FROM discarded WHERE uid=?", (uid,))
            db().execute("DELETE FROM user_settings WHERE uid=?", (uid,))
            db().execute("DELETE FROM sessions WHERE uid=?", (uid,))
            # 陪伴者关联、陪伴者发布的鼓励、推题记录：账号没了，关联也不该留着
            db().execute("DELETE FROM teacher_links WHERE teacher_uid=? OR student_uid=?", (uid, uid))
            db().execute("DELETE FROM pushed_questions WHERE from_uid=? OR to_uid=?", (uid, uid))
            db().execute("DELETE FROM encouragements WHERE teacher_uid=? OR student_uid=?", (uid, uid))
            db().execute("DELETE FROM users WHERE id=?", (uid,))
            db().commit()
        return self._send(200, {"ok": True})


def main():
    if not os.path.exists(DB_PATH):
        print("[ERR] 数据库不存在，请先运行: python parse.py")
        sys.exit(1)
    ensure_split()
    borrow()   # 启动期整段复用一个连接：建表迁移 → 题库校验
    try:
        ensure_tables()
        ensure_admin_baseline()   # 一次性基线：清空所有账号，仅留 admin/123456（幂等、带可恢复快照）
        q_one("SELECT COUNT(*) n FROM qdb.questions")   # 兜底：ATTACH 缺文件会静默建空库
        _warm()      # 预热题库 → OS 页缓存（新账号播种、出题查询首次都更快）
    except Exception as e:
        print(f"[ERR] 题库 kaogong.db 不可读: {e}")
        sys.exit(1)
    finally:
        unborrow()
    print(f"[INFO] vault  = {VAULT_ROOT}")
    print(f"[INFO] images = {IMG_ROOT}  exists={os.path.isdir(IMG_ROOT)}")
    print(f"[INFO] userdb = {USERS_DB_PATH}")
    threading.Thread(target=_backup_loop, daemon=True).start()   # 每 30 分钟自动快照用户库
    print(f"[INFO] 打开浏览器访问:  http://127.0.0.1:{PORT}")
    srv = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\n[INFO] 已停止")


if __name__ == "__main__":
    main()
