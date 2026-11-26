"""Runtime regressions for view-as navigation and SQLite transaction semantics.

This suite never imports or starts server.py. JavaScript function bodies are
extracted from app.js and run in a Node vm with a deliberately small fake DOM.
SQLite cases use only temporary databases.
"""

import ast
import json
import pathlib
import re
import shutil
import sqlite3
import subprocess
import tempfile
import threading
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[1]
APP_JS = ROOT / "static" / "app.js"
SERVER_PY = ROOT / "server.py"


def production_read_tx_class():
    """Compile the real read_tx class node without importing server.py."""
    tree = ast.parse(SERVER_PY.read_text(encoding="utf-8"))
    node = next(
        item for item in tree.body
        if isinstance(item, ast.ClassDef) and item.name == "read_tx"
    )
    module = ast.Module(body=[node], type_ignores=[])
    ast.fix_missing_locations(module)
    bindings = {"connection": None}
    namespace = {"db": lambda: bindings["connection"]}
    exec(compile(module, str(SERVER_PY), "exec"), namespace)
    return namespace["read_tx"], bindings


def production_study_credit_sources():
    """Return the real API method and study_credit DDL source strings."""
    source = SERVER_PY.read_text(encoding="utf-8")
    tree = ast.parse(source)
    handler = next(
        item for item in tree.body
        if isinstance(item, ast.ClassDef) and item.name == "Handler"
    )
    method = next(
        item for item in handler.body
        if isinstance(item, ast.FunctionDef) and item.name == "api_study_time"
    )
    method_source = ast.get_source_segment(source, method)
    ddl = next(
        node.value for node in ast.walk(tree)
        if isinstance(node, ast.Constant) and isinstance(node.value, str)
        and "CREATE TABLE IF NOT EXISTS study_credit" in node.value
    )
    return method_source, ddl


def extract_js_function(source, name):
    """Extract one top-level function using lexical brace balancing."""
    match = re.search(r"(?:async\s+)?function\s+" + re.escape(name) + r"\s*\([^)]*\)\s*\{", source)
    if not match:
        raise AssertionError("Function not found: " + name)
    start = match.start()
    brace_start = source.find("{", match.start())
    depth = 0
    state = "code"
    escaped = False
    i = brace_start
    while i < len(source):
        char = source[i]
        nxt = source[i + 1] if i + 1 < len(source) else ""
        if state == "code":
            if char == "'":
                state = "single"
            elif char == '"':
                state = "double"
            elif char == "`":
                state = "template"
            elif char == "/" and nxt == "/":
                state = "line_comment"
                i += 1
            elif char == "/" and nxt == "*":
                state = "block_comment"
                i += 1
            elif char == "{":
                depth += 1
            elif char == "}":
                depth -= 1
                if depth == 0:
                    return source[start:i + 1]
        elif state in ("single", "double", "template"):
            quote = {"single": "'", "double": '"', "template": "`"}[state]
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == quote:
                state = "code"
        elif state == "line_comment":
            if char == "\n":
                state = "code"
        elif state == "block_comment" and char == "*" and nxt == "/":
            state = "code"
            i += 1
        i += 1
    raise AssertionError("Unclosed function body: " + name)


def run_js(function_names, test_body):
    """Execute selected app functions in Node vm and return JSON results."""
    if not shutil.which("node"):
        raise unittest.SkipTest("Node.js is required for frontend runtime tests")
    source = APP_JS.read_text(encoding="utf-8")
    extracted = {name: extract_js_function(source, name) for name in set(function_names) | {"setViewAs"}}
    declarations = "\n".join([
        "const VIEWAS_KEY = 'kg_viewas';",
        "const VIEWAS_BLOCK = ['#/study', '#/review', '#/exam', '#/settings', '#/coach', '#/coach/encourage'];",
        "let VIEWAS = sessionStorage.getItem(VIEWAS_KEY) || '';",
        "let VIEWAS_NAME = sessionStorage.getItem(VIEWAS_KEY + '_n') || '';",
        "let VAS_TIMER = 17;",
        "function viewDashboard() { events.push(['dashboard', VIEWAS]); return Promise.resolve(); }",
        "function renderCoachShell() {}",
        "function renderNav() {}",
        *(extracted[name] for name in ["setViewAs"] + [n for n in function_names if n != "setViewAs"]),
    ])
    script = r"""
const vm = require('node:vm');
const session = new Map([['kg_viewas', 'student-1'], ['kg_viewas_n', 'Learner']]);
const events = [];
const store = {
  getItem: key => session.has(key) ? session.get(key) : null,
  setItem: (key, value) => session.set(key, String(value)),
  removeItem: key => session.delete(key)
};
const location = { hash: '#/', protocol: 'http:' };
const timerIds = new Set([17]);
const context = {
  console,
  sessionStorage: store,
  session,
  timerIds,
  location,
  URLSearchParams,
  state: { tpoll: null, gradeCtx: {} },
  window: { addEventListener() {} },
  document: {
    documentElement: { setAttribute() {} },
    querySelectorAll() { return []; }
  },
  navLinks: [],
  clearInterval(id) { timerIds.delete(id); events.push(['clearInterval', id]); },
  clearTimeout() {},
  viewDashboard() { events.push(['dashboard', this.VIEWAS]); return Promise.resolve(); },
  fatal(error) { events.push(['fatal', String(error)]); },
  route() { events.push(['route', this.VIEWAS]); },
  refreshSide() { events.push(['refreshSide']); return Promise.resolve(); },
  stSync() {}, pauseClock() {}, captureInk() {}, flushReportGrades() {}, toast(msg) { events.push(['toast', msg]); },
  document: {
    documentElement: { setAttribute() {} },
    querySelectorAll() { return []; }
  },
  URLSearchParams,
  events,
  timerIds
};
""" + "\nvm.createContext(context);\nvm.runInContext(" + json.dumps(declarations + "\n" + test_body) + ", context);\n"
    result = subprocess.run(
        ["node", "-e", script], capture_output=True, text=True, check=False
    )
    if result.returncode:
        raise AssertionError("Node vm failed: " + result.stderr)
    try:
        return json.loads(result.stdout)
    except json.JSONDecodeError as error:
        raise AssertionError("Node vm returned invalid JSON: " + result.stdout) from error


class ViewAsRuntimeTest(unittest.TestCase):
    def test_clear_expired_on_root_clears_session_stops_timer_and_refreshes_self(self):
        result = run_js(["clearExpiredViewAs"], r"""
(async () => {
  location.hash = '#/';
  await clearExpiredViewAs();
  console.log(JSON.stringify({ session: Array.from(session.entries()), timer: Array.from(timerIds), events }));
})();
""")
        self.assertEqual(result["session"], [])
        self.assertEqual(result["timer"], [])
        self.assertIn(["dashboard", ""], result["events"])

    def test_clear_expired_off_root_routes_to_coach_without_dashboard(self):
        result = run_js(["clearExpiredViewAs"], r"""
location.hash = '#/stats?range=7';
clearExpiredViewAs();
console.log(JSON.stringify({ hash: location.hash, events }));
""")
        self.assertEqual(result["hash"], "#/coach")
        self.assertFalse(any(event[0] == "dashboard" for event in result["events"]))

    def test_route_blocks_study_review_and_settings_during_view_as(self):
        for blocked in ("#/study", "#/review", "#/settings"):
            with self.subTest(route=blocked):
                result = run_js(["route"], """
location.hash = %s;
route();
console.log(JSON.stringify({ hash: location.hash, events }));
""" % json.dumps(blocked))
                self.assertEqual(result["hash"], "#/")
                self.assertTrue(any(event[0] == "toast" for event in result["events"]))
                self.assertFalse(any(event[0] in ("dashboard", "route") for event in result["events"]))

    def test_exit_view_as_same_root_hash_refreshes_self_dashboard(self):
        result = run_js(["exitViewAs"], r"""
location.hash = '#/';
exitViewAs();
console.log(JSON.stringify({ session: Array.from(session.entries()), hash: location.hash, events }));
""")
        self.assertEqual(result["session"], [])
        self.assertEqual(result["hash"], "#/")
        self.assertIn(["dashboard", ""], result["events"])


class StudyCreditAndReadTransactionTest(unittest.TestCase):
    def setUp(self):
        self.ReadTx, self.read_tx_bindings = production_read_tx_class()
        self.temp_dir = tempfile.TemporaryDirectory()
        self.db_path = pathlib.Path(self.temp_dir.name) / "runtime.sqlite3"
        self.writer = sqlite3.connect(self.db_path, timeout=5, check_same_thread=False)
        self.writer.execute("PRAGMA journal_mode=WAL")
        self.writer.execute("PRAGMA busy_timeout=5000")
        self.writer.executescript("""
            CREATE TABLE study_time(uid TEXT NOT NULL, day TEXT NOT NULL, ms INTEGER NOT NULL DEFAULT 0,
                                    PRIMARY KEY(uid, day));
            CREATE TABLE study_credit(uid TEXT NOT NULL, rid TEXT NOT NULL, day TEXT, ms INTEGER NOT NULL,
                                      ts TEXT, PRIMARY KEY(uid, rid));
            CREATE TABLE snapshot_state(gid TEXT PRIMARY KEY, status TEXT NOT NULL, answer TEXT NOT NULL);
            INSERT INTO snapshot_state VALUES('g1', 'open', 'pending');
        """)
        self.writer.commit()

    def tearDown(self):
        self.writer.close()
        self.temp_dir.cleanup()

    def connect(self):
        connection = sqlite3.connect(self.db_path, timeout=5, check_same_thread=False)
        connection.execute("PRAGMA busy_timeout=5000")
        return connection

    def apply_study_credit_model(self, connection, uid, rid, day, milliseconds):
        """Model SQLite idempotency; this does not execute the production endpoint."""
        with connection:
            cursor = connection.execute(
                "INSERT OR IGNORE INTO study_credit(uid,rid,day,ms,ts) VALUES(?,?,?,?,?)",
                (uid, rid, day, milliseconds, "2025-01-01T00:00:00"),
            )
            duplicate = cursor.rowcount == 0
            if not duplicate:
                connection.execute(
                    "INSERT INTO study_time(uid,day,ms) VALUES(?,?,?) "
                    "ON CONFLICT(uid,day) DO UPDATE SET ms=study_time.ms+excluded.ms",
                    (uid, day, milliseconds),
                )

    def test_study_credit_model_concurrent_replay_accumulates_once(self):
        """Exercise SQLite model concurrency, not Handler.api_study_time itself."""
        barrier = threading.Barrier(8)
        errors = []
        errors_lock = threading.Lock()

        def submit():
            connection = self.connect()
            try:
                barrier.wait(timeout=5)
                self.apply_study_credit_model(
                    connection, "u1", "rid-1", "2025-01-01", 1200
                )
            except Exception as error:
                with errors_lock:
                    errors.append(error)
            finally:
                connection.close()

        threads = [threading.Thread(target=submit) for _ in range(8)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(timeout=10)

        self.assertFalse(any(thread.is_alive() for thread in threads), "model workers did not finish")
        self.assertEqual(errors, [])
        self.assertEqual(
            self.writer.execute("SELECT ms FROM study_time WHERE uid='u1'").fetchone(),
            (1200,),
        )
        self.assertEqual(
            self.writer.execute("SELECT COUNT(*) FROM study_credit WHERE uid='u1'").fetchone(),
            (1,),
        )

    def test_study_credit_model_distinct_rids_and_uids_do_not_collide(self):
        """Check composite-key behavior in the isolated SQLite model."""
        for uid, rid, milliseconds in (
            ("u1", "same", 100),
            ("u1", "next", 250),
            ("u2", "same", 400),
        ):
            self.apply_study_credit_model(
                self.writer, uid, rid, "2025-01-01", milliseconds
            )

        totals = dict(self.writer.execute("SELECT uid, ms FROM study_time"))
        self.assertEqual(totals, {"u1": 350, "u2": 400})
        self.assertEqual(self.writer.execute("SELECT COUNT(*) FROM study_credit").fetchone(), (3,))

    def test_production_study_credit_path_declares_idempotency_and_updates_total(self):
        method, ddl = production_study_credit_sources()
        normalized_ddl = re.sub(r"\s+", "", ddl).lower()
        normalized_method = re.sub(r"\s+", "", method).lower()
        self.assertIn("primarykey(uid,rid)", normalized_ddl)
        self.assertIn(
            'insertorignoreintostudy_credit(uid,rid,day,ms,ts)values(?,?,?,?,?)',
            normalized_method,
        )
        self.assertIn("dup=(cur.rowcount==0)", normalized_method)
        self.assertRegex(
            normalized_method,
            r"ifnotdup:.*?db\(\)\.execute\(.*?study_time",
        )

    def test_read_transaction_keeps_two_selects_on_one_wal_snapshot(self):
        reader = self.connect()
        self.read_tx_bindings["connection"] = reader
        try:
            with self.ReadTx() as snapshot:
                first = snapshot.execute("SELECT status FROM snapshot_state WHERE gid='g1'").fetchone()[0]
                with self.writer:
                    self.writer.execute("UPDATE snapshot_state SET status='done', answer='graded' WHERE gid='g1'")
                second = snapshot.execute("SELECT answer FROM snapshot_state WHERE gid='g1'").fetchone()[0]
                self.assertEqual((first, second), ("open", "pending"))
            self.assertFalse(reader.in_transaction)
            after_commit = reader.execute(
                "SELECT status, answer FROM snapshot_state WHERE gid='g1'"
            ).fetchone()
            self.assertEqual(after_commit, ("done", "graded"))
        finally:
            if reader.in_transaction:
                reader.rollback()
            self.read_tx_bindings["connection"] = None
            reader.close()

    def test_exception_rolls_back_and_leaves_no_active_transaction(self):
        conn = self.connect()
        self.read_tx_bindings["connection"] = conn
        try:
            with self.assertRaisesRegex(RuntimeError, "forced failure"):
                with self.ReadTx() as transaction:
                    transaction.execute("UPDATE snapshot_state SET status='partial' WHERE gid='g1'")
                    raise RuntimeError("forced failure")
            self.assertFalse(conn.in_transaction)
            self.assertEqual(
                conn.execute("SELECT status FROM snapshot_state WHERE gid='g1'").fetchone(),
                ("open",),
            )
        finally:
            self.read_tx_bindings["connection"] = None
            conn.close()

    def test_production_read_tx_reuses_existing_transaction(self):
        conn = self.connect()
        self.read_tx_bindings["connection"] = conn
        try:
            conn.execute("BEGIN")
            with self.ReadTx() as transaction:
                self.assertIs(transaction, conn)
                transaction.execute("UPDATE snapshot_state SET status='outer' WHERE gid='g1'")
            self.assertTrue(conn.in_transaction)
            conn.rollback()
            self.assertEqual(
                conn.execute("SELECT status FROM snapshot_state WHERE gid='g1'").fetchone(),
                ("open",),
            )
        finally:
            if conn.in_transaction:
                conn.rollback()
            self.read_tx_bindings["connection"] = None
            conn.close()


if __name__ == "__main__":
    unittest.main()
