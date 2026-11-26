"""Regression tests for the explicit view-as GET boundary and accuracy SQL."""

import ast
import pathlib
import re
import sqlite3
import types
import unittest
import urllib.parse


ROOT = pathlib.Path(__file__).resolve().parents[1]
SERVER = ROOT / "server.py"
APP_JS = ROOT / "static" / "app.js"


def _server_tree():
    return ast.parse(SERVER.read_text(encoding="utf-8"))


def _class_node(tree, name):
    return next(node for node in tree.body if isinstance(node, ast.ClassDef) and node.name == name)


def _method_node(class_node, name):
    return next(node for node in class_node.body
                if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name == name)


def _accuracy_route():
    tree = _server_tree()
    handler = _class_node(tree, "Handler")
    method = _method_node(handler, "api")
    return next(node for node in method.body if isinstance(node, ast.If)
                and isinstance(node.test, ast.Compare)
                and isinstance(node.test.left, ast.Name) and node.test.left.id == "path"
                and any(isinstance(value, ast.Constant) and value.value == "/api/accuracy/v2"
                        for value in node.test.comparators))


def _accuracy_queries():
    route = _accuracy_route()
    queries = []
    for node in ast.walk(route):
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id == "q_all":
            query = node.args[0]
            if isinstance(query, ast.Constant) and isinstance(query.value, str):
                queries.append(query.value)
    if len(queries) != 2:
        raise AssertionError("Expected the first-answer and review SQL queries")
    return queries


def _make_get_handler():
    tree = _server_tree()
    handler_node = _class_node(tree, "Handler")
    method = _method_node(handler_node, "do_GET")
    module = ast.Module(body=[ast.ClassDef(name="Handler", bases=[], keywords=[], body=[method], decorator_list=[])],
                        type_ignores=[])
    ast.fix_missing_locations(module)
    namespace = {
        "urllib": urllib,
        "os": types.SimpleNamespace(path=types.SimpleNamespace(join=lambda *parts: "/".join(parts))),
        "STATIC": "/static",
        "VIEWAS_READ_ALLOW": _allowlist(),
        "borrow": lambda: None,
        "unborrow": lambda: None,
        "viewas_clear": lambda: None,
        "viewas_enter": lambda me, sid: me == "teacher" and sid == "student",
        "auth_uid": lambda token: "teacher" if token == "valid" else None,
        "Unauthorized": type("Unauthorized", (Exception,), {}),
        "Forbidden": type("Forbidden", (Exception,), {}),
        "ops_enabled": lambda: False,
    }
    exec(compile(module, str(SERVER), "exec"), namespace)
    cls = namespace["Handler"]

    class FakeHandler(cls):
        def __init__(self, path):
            self.path = path
            self.calls = []
            self.status = None
            self.payload = None

        def api(self, path, query):
            self.calls.append(("api", path))
            return self._send(200, {"forwarded": path})

        def _send(self, status, payload, *args, **kwargs):
            self.status = status
            self.payload = payload
            return status, payload

        def _file(self, *args, **kwargs):
            self.calls.append(("file", args))
            return 200

        def ops_api(self, *args, **kwargs):
            return self._send(404, {})

    return FakeHandler


def _allowlist():
    tree = _server_tree()
    node = next(item for item in tree.body if isinstance(item, ast.Assign)
                and any(isinstance(target, ast.Name) and target.id == "VIEWAS_READ_ALLOW"
                        for target in item.targets))
    return frozenset(ast.literal_eval(node.value.args[0]))


class ViewAsAuthorizationTest(unittest.TestCase):
    def test_viewas_announcement_skips_per_user_read_state_query(self):
        tree = _server_tree()
        handler = _class_node(tree, "Handler")
        method = _method_node(handler, "api_announcement")
        calls = []

        class FakeHandler:
            def _send(self, status, payload):
                self.status = status
                self.payload = payload
                return status, payload

        namespace = {
            "need_uid": lambda token: "student",
            "q_one": lambda sql, args=(): calls.append(sql) or {"value": '{"id":"notice-1"}'},
            "json": __import__("json"),
            "viewas_uid": lambda: "student",
        }
        exec(compile(ast.Module(body=[method], type_ignores=[]), str(SERVER), "exec"), namespace)
        fake = FakeHandler()
        namespace["api_announcement"](fake, {"token": "valid"})
        self.assertEqual(fake.payload["seen"], False)
        self.assertEqual(len(calls), 1)
        self.assertIn("announcement_current", calls[0])
        self.assertNotIn("announcement_read_id", " ".join(calls))

    def test_frontend_skips_announcements_during_viewas(self):
        js = APP_JS.read_text(encoding="utf-8")
        start = js.index("async function showAnnouncementIfNeeded()")
        body = js[start:js.index("\n}\n", start)]
        self.assertRegex(body, r"if\s*\([^\n]*VIEWAS[^\n]*\)\s*return")

    def test_valid_viewas_live_route_is_readable(self):
        handler = _make_get_handler()("/api/coach/live?token=valid&as=student")
        handler.do_GET()
        self.assertEqual(handler.status, 200)
        self.assertIn(("api", "/api/coach/live"), handler.calls)

    def test_valid_viewas_allows_review_route_in_target_context(self):
        handler = _make_get_handler()("/api/stats?token=valid&as=student")
        handler.do_GET()
        self.assertEqual(handler.status, 200)
        self.assertIn(("api", "/api/stats"), handler.calls)

    def test_revoked_relationship_returns_expired_without_api_call(self):
        handler_cls = _make_get_handler()
        handler = handler_cls("/api/stats?token=valid&as=revoked")
        handler.do_GET()
        self.assertEqual(handler.status, 403)
        self.assertEqual(handler.payload["code"], "viewas_expired")
        self.assertFalse(any(call[0] == "api" for call in handler.calls))

    def test_unknown_and_sensitive_routes_are_denied_before_api(self):
        for route in ("/api/new-route", "/api/prefs", "/api/export/mydata", "/api/coach/peers"):
            with self.subTest(route=route):
                handler = _make_get_handler()(route + "?token=valid&as=student")
                handler.do_GET()
                self.assertEqual(handler.status, 403)
                self.assertEqual(handler.payload["code"], "viewas_denied")
                self.assertFalse(any(call[0] == "api" for call in handler.calls))

    def test_no_as_preserves_normal_api_dispatch(self):
        handler = _make_get_handler()("/api/new-route?token=valid")
        handler.do_GET()
        self.assertEqual(handler.status, 200)
        self.assertEqual(handler.calls, [("api", "/api/new-route")])

    def test_allowlist_covers_frontend_read_routes_and_excludes_mutations(self):
        js = APP_JS.read_text(encoding="utf-8")
        allowlist = _allowlist()
        for route in ("/api/bootstrap", "/api/stats", "/api/review/plan", "/api/announcement",
                      "/api/accuracy/v2", "/api/browse", "/api/facets", "/api/question",
                      "/api/kadian", "/api/wrongbook/stats", "/api/practice/today",
                      "/api/practice/group", "/api/coach/live", "/api/heatmap", "/api/streak", "/api/weak",
                      "/api/study-time/stat", "/api/materials", "/api/doubts", "/api/search"):
            with self.subTest(route=route):
                self.assertIn(route, allowlist)
                self.assertRegex(js, re.escape(route))
        for route in ("/api/next", "/api/prefs", "/api/export/mydata", "/api/user-backup/config",
                      "/api/encourage", "/api/teacher/student", "/api/coach/peers"):
            self.assertNotIn(route, allowlist)


class AccuracyQueryTest(unittest.TestCase):
    def setUp(self):
        self.conn = sqlite3.connect(":memory:")
        self.conn.row_factory = sqlite3.Row
        self.conn.executescript("""
            CREATE TABLE practice_groups(gid TEXT PRIMARY KEY, uid TEXT, mode TEXT, started TEXT);
            CREATE TABLE practice_items(gid TEXT, qid TEXT, choice TEXT, answer TEXT,
                                        graded_at TEXT, dropped INTEGER DEFAULT 0);
            ATTACH DATABASE ':memory:' AS qdb;
            CREATE TABLE qdb.questions(qid TEXT PRIMARY KEY, module TEXT, category TEXT);
            INSERT INTO qdb.questions VALUES
                ('q1','Module A','Cat X'), ('q2','Module B','Cat Y'),
                ('q3','Module A','Cat X'), ('q4','Module B','Cat Y');
            INSERT INTO practice_groups VALUES
                ('g0','u1','study','2024-01-01 08:00:00'),
                ('g1','u1','study','2024-01-02 08:00:00'),
                ('g2','u1','review','2024-01-03 08:00:00'),
                ('g3','u1','study','2024-01-04 08:00:00'),
                ('g4','u1','study','2024-01-05 08:00:00'),
                ('g5','u1','study','2024-01-06 08:00:00'),
                ('other','u2','study','2024-01-01 08:00:00');
            INSERT INTO practice_items VALUES
                ('g0','q1','','A','2024-01-01 08:05:00',0),
                ('g1','q1','A','A','2024-01-02 08:05:00',0),
                ('g2','q1','B','A','2024-01-03 08:05:00',0),
                ('g1','q2','B','A','2024-01-02 08:06:00',0),
                ('g2','q2','A','A','2024-01-03 08:06:00',0),
                ('g3','q3','A','A','2024-01-04 08:06:00',1),
                ('g4','q3','A','A',NULL,0),
                ('g5','q4','A','A','2024-01-06 08:06:00',0),
                ('other','q4','B','A','2024-01-01 08:06:00',0);
        """)

    def tearDown(self):
        self.conn.close()

    def test_accuracy_aggregation_orders_dates_and_module_counts(self):
        route = _accuracy_route()
        pack = next(node for node in route.body if isinstance(node, ast.FunctionDef) and node.name == "_pack")
        namespace = {}
        exec(compile(ast.Module(body=[pack], type_ignores=[]), str(SERVER), "exec"), namespace)
        result = namespace["_pack"]([
            {"d": "2024-01-02", "m": "Module B", "cat": "Cat Y", "ok": 0},
            {"d": "2024-01-01", "m": "Module A", "cat": "Cat X", "ok": 1},
            {"d": "2024-01-02", "m": "Module A", "cat": "Cat X", "ok": 1},
        ], True)
        self.assertEqual([row["d"] for row in result["by_day"]], ["2024-01-01", "2024-01-02"])
        self.assertEqual(result["n"], 3)
        self.assertEqual(result["c"], 2)
        self.assertEqual(result["acc"], 66.7)
        self.assertEqual(result["by_module"], [
            {"k": "Module A", "n": 2, "c": 2, "acc": 100.0},
            {"k": "Module B", "n": 1, "c": 0, "acc": 0.0},
        ])
        self.assertEqual(len(result["by_day_module"]), 3)

    def test_real_accuracy_queries_and_aggregation_semantics(self):
        first_sql, review_sql = _accuracy_queries()
        first = [dict(row) for row in self.conn.execute(first_sql, ("u1",))]
        review = [dict(row) for row in self.conn.execute(review_sql, ("u1",))]
        self.assertEqual([(row["d"], row["m"], row["ok"]) for row in first], [
            ("2024-01-02", "Module A", 1), ("2024-01-02", "Module B", 0),
            ("2024-01-06", "Module B", 1)])
        self.assertEqual([(row["d"], row["m"], row["ok"]) for row in review], [
            ("2024-01-03", "Module A", 0), ("2024-01-03", "Module B", 1)])
        self.assertEqual(sum(row["ok"] for row in first), 2)
        self.assertEqual(sum(row["ok"] for row in review), 1)


if __name__ == "__main__":
    unittest.main()
