"""SQLite configuration, audit records and atomic monthly budget reservations."""
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from decimal import Decimal, ROUND_CEILING
import json
import os
from pathlib import Path
import sqlite3
import uuid
from zoneinfo import ZoneInfo

from .errors import RouterError
from .schemas import Settings
from .secrets import digest, new_token

SCALE = Decimal(1_000_000_000)


def money(value):
    return int((Decimal(str(value)) * SCALE).to_integral_value(rounding=ROUND_CEILING))


def usd(value):
    return float(Decimal(value) / SCALE)


def identifier():
    return uuid.uuid4().hex


def approval_terms(model, connection):
    return digest(json.dumps({"model": {k: model[k] for k in
        ("id", "connection_id", "upstream_model", "pricing", "input_per_million", "output_per_million")},
        "connection": {k: connection[k] for k in ("provider", "base_url", "credential_ref")}}, sort_keys=True))


class Store:
    def __init__(self, directory, clock=None):
        self.directory = Path(directory).expanduser().resolve()
        self.directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        os.chmod(self.directory, 0o700)
        self.path = self.directory / "router.sqlite3"
        self.clock = clock or (lambda: datetime.now(timezone.utc))
        with self.db() as db:
            if db.execute("PRAGMA user_version").fetchone()[0] not in (0, 1):
                raise RouterError("configuration_conflict", 503)
            db.executescript("""
                PRAGMA journal_mode=WAL;
                CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS connections (id TEXT PRIMARY KEY, value TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS models (id TEXT PRIMARY KEY, value TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS ledger (
                    id TEXT PRIMARY KEY, month TEXT NOT NULL, request_id TEXT NOT NULL,
                    model_id TEXT NOT NULL, amount INTEGER NOT NULL, state TEXT NOT NULL);
                CREATE INDEX IF NOT EXISTS ledger_month ON ledger(month);
                CREATE TABLE IF NOT EXISTS records (
                    id TEXT PRIMARY KEY, timestamp TEXT NOT NULL, value TEXT NOT NULL);
                PRAGMA user_version=1;
            """)
            db.execute("INSERT OR IGNORE INTO config VALUES ('settings', ?)",
                       (Settings().model_dump_json(),))
        os.chmod(self.path, 0o600)

    @contextmanager
    def db(self, write=False):
        db = sqlite3.connect(self.path, timeout=10, isolation_level=None)
        try:
            db.execute("BEGIN IMMEDIATE" if write else "BEGIN")
            yield db
            if db.in_transaction:
                db.commit()
        except BaseException:
            if db.in_transaction:
                db.rollback()
            raise
        finally:
            db.close()

    def month(self):
        return self.clock().astimezone(ZoneInfo("Asia/Seoul")).strftime("%Y-%m")

    @staticmethod
    def settings_from(db):
        return json.loads(db.execute("SELECT value FROM config WHERE key='settings'").fetchone()[0])

    def snapshot(self):
        with self.db() as db:
            return {"settings": self.settings_from(db), **{
                table: {row[0]: json.loads(row[1]) for row in db.execute(f"SELECT id,value FROM {table}")}
                for table in ("connections", "models")}}

    def auth_hash(self, kind):
        with self.db() as db:
            row = db.execute("SELECT value FROM config WHERE key=?", ("auth_" + kind,)).fetchone()
            return row[0] if row else None

    def rotate_token(self, kind):
        token = new_token()
        with self.db(True) as db:
            db.execute("INSERT OR REPLACE INTO config VALUES (?,?)", ("auth_" + kind, digest(token)))
        return token

    def initialize_tokens(self):
        return {kind: self.rotate_token(kind) for kind in ("admin", "api") if not self.auth_hash(kind)}

    @staticmethod
    def revoke(db, ids):
        settings = Store.settings_from(db)
        settings["approved_model_ids"] = [x for x in settings["approved_model_ids"] if x not in ids]
        db.execute("UPDATE config SET value=? WHERE key='settings'", (json.dumps(settings),))

    def save_connection(self, value, connection_id=None):
        connection_id = connection_id or identifier()
        value = {**value, "id": connection_id}
        with self.db(True) as db:
            old = db.execute("SELECT value FROM connections WHERE id=?", (connection_id,)).fetchone()
            if old and any(json.loads(old[0])[k] != value[k] for k in
                           ("provider", "base_url", "credential_ref")):
                ids = [row[0] for row in db.execute("SELECT id,value FROM models")
                       if json.loads(row[1])["connection_id"] == connection_id]
                self.revoke(db, ids)
            db.execute("INSERT OR REPLACE INTO connections VALUES (?,?)", (connection_id, json.dumps(value)))
        return value

    def save_model(self, value, model_id=None):
        model_id = model_id or identifier()
        value = {**value, "id": model_id}
        with self.db(True) as db:
            if not db.execute("SELECT 1 FROM connections WHERE id=?", (value["connection_id"],)).fetchone():
                raise RouterError("not_found", 404)
            known = {row[0] for row in db.execute("SELECT id FROM models")}
            if (model_id in value["fallback_ids"] or len(set(value["fallback_ids"])) != len(value["fallback_ids"])
                    or not set(value["fallback_ids"]) <= known):
                raise RouterError("invalid_request", 422)
            old = db.execute("SELECT value FROM models WHERE id=?", (model_id,)).fetchone()
            if old and any(json.loads(old[0])[k] != value[k] for k in
                           ("connection_id", "upstream_model", "pricing", "input_per_million", "output_per_million")):
                self.revoke(db, [model_id])
            db.execute("INSERT OR REPLACE INTO models VALUES (?,?)", (model_id, json.dumps(value)))
        return value

    def delete_model(self, model_id):
        with self.db(True) as db:
            for row in db.execute("SELECT value FROM models"):
                if model_id in json.loads(row[0])["fallback_ids"]:
                    raise RouterError("configuration_conflict", 409)
            if not db.execute("DELETE FROM models WHERE id=?", (model_id,)).rowcount:
                raise RouterError("not_found", 404)
            self.revoke(db, [model_id])

    def delete_connection(self, connection_id):
        with self.db(True) as db:
            if any(json.loads(row[0])["connection_id"] == connection_id
                   for row in db.execute("SELECT value FROM models")):
                raise RouterError("configuration_conflict", 409)
            if not db.execute("DELETE FROM connections WHERE id=?", (connection_id,)).rowcount:
                raise RouterError("not_found", 404)

    def save_settings(self, value, *, allow_approval_changes=True):
        with self.db(True) as db:
            current = self.settings_from(db)
            if not allow_approval_changes and any(value[k] != current[k] for k in
                                                  ("approved_model_ids", "monthly_budget_usd")):
                raise RouterError("configuration_conflict", 409)
            models = {row[0]: json.loads(row[1]) for row in db.execute("SELECT id,value FROM models")}
            for model_id in value["approved_model_ids"]:
                model = models.get(model_id)
                if not model or model["pricing"] != "paid" or any(
                        model[k] is None for k in ("input_per_million", "output_per_million")):
                    raise RouterError("unknown_pricing", 422)
            db.execute("UPDATE config SET value=? WHERE key='settings'", (json.dumps(value),))
        self.prune()
        return value

    def approve_budget(self, approval):
        with self.db(True) as db:
            models = {row[0]: json.loads(row[1]) for row in db.execute("SELECT id,value FROM models")}
            connections = {row[0]: json.loads(row[1]) for row in db.execute("SELECT id,value FROM connections")}
            for model_id in approval["approved_model_ids"]:
                model = models.get(model_id)
                if not model or model["pricing"] != "paid" or any(
                        model[k] is None for k in ("input_per_million", "output_per_million")):
                    raise RouterError("unknown_pricing", 422)
                if approval["terms"].get(model_id) != approval_terms(model, connections[model["connection_id"]]):
                    raise RouterError("configuration_conflict", 409)
            settings = self.settings_from(db) | {k: approval[k] for k in ("approved_model_ids", "monthly_budget_usd")}
            db.execute("UPDATE config SET value=? WHERE key='settings'", (json.dumps(settings),))
        return settings

    def reserve(self, request_id, model, estimate, snapshot_budget, connection=None):
        reservation = identifier()
        with self.db(True) as db:
            settings = self.settings_from(db)
            current = db.execute("SELECT value FROM models WHERE id=?", (model["id"],)).fetchone()
            # Revocations and price changes apply even to requests waiting to start a paid attempt.
            if (model["id"] not in settings["approved_model_ids"] or not current
                    or any(json.loads(current[0])[k] != model[k] for k in
                           ("connection_id", "upstream_model", "pricing", "input_per_million", "output_per_million"))):
                raise RouterError("paid_not_approved", 403)
            if connection is not None:
                current_connection = db.execute("SELECT value FROM connections WHERE id=?", (connection["id"],)).fetchone()
                if not current_connection or approval_terms(model, connection) != approval_terms(
                        json.loads(current[0]), json.loads(current_connection[0])):
                    raise RouterError("paid_not_approved", 403)
            budget = min(money(settings["monthly_budget_usd"]), money(snapshot_budget))
            if budget <= 0:
                raise RouterError("paid_not_approved", 403)
            month = self.month()
            used = db.execute("SELECT COALESCE(SUM(amount),0) FROM ledger WHERE month=?", (month,)).fetchone()[0]
            if estimate > budget - used:
                raise RouterError("budget_exceeded", 402)
            db.execute("INSERT INTO ledger VALUES (?,?,?,?,?,?)",
                       (reservation, month, request_id, model["id"], estimate, "reserved"))
        return reservation

    def settle(self, reservation, amount):
        if reservation is None:
            return
        with self.db(True) as db:
            if amount is None:
                db.execute("UPDATE ledger SET state='uncertain' WHERE id=?", (reservation,))
            else:
                db.execute("UPDATE ledger SET amount=?,state='settled' WHERE id=?", (amount, reservation))

    def budget(self):
        with self.db() as db:
            settings = self.settings_from(db)
            total = db.execute("SELECT COALESCE(SUM(amount),0) FROM ledger WHERE month=?", (self.month(),)).fetchone()[0]
        return {"month": self.month(), "timezone": "Asia/Seoul", "limit_usd": settings["monthly_budget_usd"],
                "used_and_reserved_usd": usd(total),
                "remaining_usd": max(0, settings["monthly_budget_usd"] - usd(total)), "estimated": True}

    def prune(self):
        with self.db(True) as db:
            cutoff = (self.clock() - timedelta(days=self.settings_from(db)["retention_days"])).isoformat()
            db.execute("DELETE FROM records WHERE timestamp < ?", (cutoff,))

    def record(self, value):
        self.prune()
        with self.db(True) as db:
            db.execute("INSERT OR REPLACE INTO records VALUES (?,?,?)",
                       (value["request_id"], self.clock().isoformat(), json.dumps(value, ensure_ascii=False)))

    def records(self, offset=0, limit=100):
        self.prune()
        with self.db() as db:
            return [json.loads(row[0]) for row in db.execute(
                "SELECT value FROM records ORDER BY timestamp DESC LIMIT ? OFFSET ?", (limit, offset))]

    def clear_records(self):
        # Ledger intentionally survives log deletion: deleting logs cannot reset spending.
        with self.db(True) as db:
            db.execute("DELETE FROM records")
