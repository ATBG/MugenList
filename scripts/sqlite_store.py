"""
sqlite_store.py — Lightweight SQLite-backed storage layer for MugelList

Goals:
- Atomic writes via transactions
- WAL journal mode for concurrency and durability
- Simple migrations runner (SQL scripts in ./migrations)
- Backup and recovery helpers using SQLite backup API and SQL dump fallback
- Settings and cache helpers (examples)

This module is intentionally minimal and dependency-free (stdlib only).
"""
import sqlite3
import os
import json
import logging
import datetime
import shutil
import re
import threading

LOGGER = logging.getLogger('MugelList.SQLite')

ROOT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.path.join(ROOT_DIR, 'data')
DB_PATH = os.path.join(DATA_DIR, 'mugelist.db')
MIGRATIONS_DIR = os.path.join(os.path.dirname(__file__), 'migrations')
BACKUP_DIR = os.path.join(DATA_DIR, 'backups')
CORRUPT_DIR = os.path.join(DATA_DIR, 'corrupt')

DEFAULT_BACKUP_KEEP = 10

_db_lock = threading.Lock()

def _ensure_dirs():
    os.makedirs(DATA_DIR, exist_ok=True)
    os.makedirs(BACKUP_DIR, exist_ok=True)
    os.makedirs(CORRUPT_DIR, exist_ok=True)

def get_current_db_path() -> str:
    """Determine the SQLite DB path dynamically based on Flask request client IP.
    If inside a Flask request, returns a separate DB for the client IP to support multi-tenancy.
    Otherwise, returns the default global DB path.
    """
    try:
        from flask import has_request_context, request
        if has_request_context():
            # Handle reverse proxies (e.g. Render) by checking X-Forwarded-For
            x_forwarded = request.headers.get('X-Forwarded-For')
            if x_forwarded:
                # Take the first IP in the proxy chain
                ip = x_forwarded.split(',')[0].strip()
            else:
                ip = request.remote_addr or 'default'
            
            # Sanitize client IP for a safe, flat filename
            sanitized = re.sub(r'[^a-zA-Z0-9]', '_', ip)
            db_name = f"mugelist_{sanitized}.db"
            db_path = os.path.join(DATA_DIR, db_name)
            
            # Automatically initialize DB for this tenant IP dynamically
            if not os.path.exists(db_path):
                with _db_lock:
                    if not os.path.exists(db_path):
                        LOGGER.info("Dynamically initializing database for new tenant IP: %s -> %s", ip, db_name)
                        init_db(db_path)
            return db_path
    except Exception as e:
        LOGGER.error("Error determining dynamic tenant DB path: %s", e)
    
    return DB_PATH

def _connect(path=None):
    path = path or get_current_db_path()
    _ensure_dirs()
    # timeout helps with contention; detect_types kept simple
    conn = sqlite3.connect(path, timeout=30, detect_types=sqlite3.PARSE_DECLTYPES)
    conn.execute('PRAGMA journal_mode=WAL;')
    conn.execute('PRAGMA synchronous=FULL;')
    conn.execute('PRAGMA foreign_keys=ON;')
    return conn

def get_connection(path=None):
    """Retrieve an SQLite connection configured with proper WAL journal mode, pragmas, and timeout."""
    return _connect(path)

def init_db(path=None):
    """Initialize DB and apply pending migrations."""
    path = path or DB_PATH
    _ensure_dirs()
    LOGGER.info('Initializing SQLite DB at %s', path)
    conn = _connect(path)
    try:
        # Ensure migrations table exists
        conn.execute("""
            CREATE TABLE IF NOT EXISTS schema_migrations (
                name TEXT PRIMARY KEY,
                applied_at TEXT NOT NULL
            )
        """)
        conn.commit()

        _run_migrations(conn)
    finally:
        conn.close()


def _run_migrations(conn):
    """Apply SQL files from MIGRATIONS_DIR in lexical order."""
    if not os.path.isdir(MIGRATIONS_DIR):
        LOGGER.info('No migrations directory found at %s', MIGRATIONS_DIR)
        return

    cur = conn.cursor()
    cur.execute("SELECT name FROM schema_migrations")
    applied = {r[0] for r in cur.fetchall()}

    sql_files = sorted([f for f in os.listdir(MIGRATIONS_DIR) if f.endswith('.sql')])
    for fname in sql_files:
        if fname in applied:
            continue
        full = os.path.join(MIGRATIONS_DIR, fname)
        LOGGER.info('Applying migration: %s', fname)
        with open(full, 'r', encoding='utf-8') as fh:
            sql = fh.read()
        try:
            # executescript runs the whole file atomically
            conn.executescript(sql)
            now = datetime.datetime.utcnow().isoformat() + 'Z'
            conn.execute('INSERT INTO schema_migrations(name, applied_at) VALUES(?, ?)', (fname, now))
            conn.commit()
            LOGGER.info('Migration applied: %s', fname)
        except Exception:
            conn.rollback()
            LOGGER.exception('Migration failed: %s', fname)
            raise


def backup_db(backup_dir=None, keep=DEFAULT_BACKUP_KEEP):
    """Create a consistent backup copy using SQLite backup API.

    Returns path of backup file.
    """
    backup_dir = backup_dir or BACKUP_DIR
    os.makedirs(backup_dir, exist_ok=True)
    timestamp = datetime.datetime.utcnow().strftime('%Y%m%dT%H%M%SZ')
    dest = os.path.join(backup_dir, f'mugelist-{timestamp}.db')

    LOGGER.info('Creating DB backup to %s', dest)
    src_conn = _connect()
    try:
        dest_conn = sqlite3.connect(dest)
        try:
            src_conn.backup(dest_conn)
            dest_conn.commit()
        finally:
            dest_conn.close()
    finally:
        src_conn.close()

    # Rotate old backups
    backups = sorted([os.path.join(backup_dir, f) for f in os.listdir(backup_dir) if f.endswith('.db')])
    if len(backups) > keep:
        to_remove = backups[:len(backups) - keep]
        for p in to_remove:
            try:
                os.remove(p)
                LOGGER.info('Removed old backup %s', p)
            except Exception:
                LOGGER.exception('Failed to remove backup %s', p)

    return dest


def verify_integrity():
    """Run PRAGMA integrity_check and return True when OK."""
    conn = _connect()
    try:
        cur = conn.execute('PRAGMA integrity_check;')
        rows = [r[0] for r in cur.fetchall()]
        ok = len(rows) == 1 and rows[0].lower() == 'ok'
        if ok:
            LOGGER.info('PRAGMA integrity_check: OK')
            return True
        LOGGER.warning('PRAGMA integrity_check returned: %s', rows)
        return False
    finally:
        conn.close()


def attempt_repair():
    """Try to salvage DB via SQL dump; if it fails, return False.

    Strategy:
    - Move corrupt DB to corrupt dir with timestamp
    - Use sqlite3 iterdump to export SQL statements
    - Create a fresh DB and execute dump
    - Replace original DB with rebuilt DB
    """
    if not os.path.exists(DB_PATH):
        LOGGER.error('DB file does not exist: %s', DB_PATH)
        return False

    ts = datetime.datetime.utcnow().strftime('%Y%m%dT%H%M%SZ')
    corrupt_copy = os.path.join(CORRUPT_DIR, f'mugelist-corrupt-{ts}.db')
    LOGGER.warning('Attempting repair; moving corrupt DB to %s', corrupt_copy)
    shutil.copy2(DB_PATH, corrupt_copy)

    try:
        # Dump
        src = sqlite3.connect(corrupt_copy)
        dump_lines = []
        for line in src.iterdump():
            dump_lines.append(line)
        src.close()

        # Create new DB file
        rebuilt = os.path.join(CORRUPT_DIR, f'mugelist-rebuilt-{ts}.db')
        if os.path.exists(rebuilt):
            os.remove(rebuilt)

        dest = sqlite3.connect(rebuilt)
        try:
            dest.executescript('\n'.join(dump_lines))
            dest.commit()
        finally:
            dest.close()

        # Verify rebuilt DB
        conn = sqlite3.connect(rebuilt)
        cur = conn.execute('PRAGMA integrity_check;')
        rows = [r[0] for r in cur.fetchall()]
        conn.close()
        if len(rows) == 1 and rows[0].lower() == 'ok':
            # Replace original DB with rebuilt
            backup_before = os.path.join(CORRUPT_DIR, f'mugelist-prereplace-{ts}.db')
            shutil.copy2(corrupt_copy, backup_before)
            shutil.copy2(rebuilt, DB_PATH)
            LOGGER.info('Rebuilt DB replaced original successfully')
            return True
        else:
            LOGGER.error('Rebuilt DB failed integrity check: %s', rows)
            return False
    except Exception:
        LOGGER.exception('Repair attempt failed')
        return False


def get_setting(key, default=None):
    conn = _connect()
    try:
        cur = conn.execute('SELECT value FROM settings WHERE key = ?', (key,))
        row = cur.fetchone()
        if not row:
            return default
        try:
            return json.loads(row[0])
        except Exception:
            return row[0]
    finally:
        conn.close()


def set_setting(key, value):
    conn = _connect()
    try:
        val = json.dumps(value) if not isinstance(value, str) else value
        with conn:
            conn.execute('INSERT INTO settings(key, value, updated_at) VALUES(?, ?, CURRENT_TIMESTAMP) '
                         'ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=CURRENT_TIMESTAMP', (key, val))
    finally:
        conn.close()


def audit_log(table_name, row_key, old_value, new_value, reason=''):
    conn = _connect()
    try:
        with conn:
            conn.execute('INSERT INTO audit_log(table_name, row_key, old_value, new_value, changed_at, reason) VALUES(?, ?, ?, ?, CURRENT_TIMESTAMP, ?)',
                         (table_name, str(row_key), json.dumps(old_value) if old_value is not None else None,
                          json.dumps(new_value) if new_value is not None else None, reason))
    finally:
        conn.close()


if __name__ == '__main__':
    logging.basicConfig(level=logging.INFO)
    init_db()
    print('Initialized DB at', DB_PATH)
