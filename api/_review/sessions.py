"""Short-lived, revocable permission for speculative provider calls."""

import hashlib
import re
import secrets
import threading
import time
from collections import OrderedDict
from contextlib import contextmanager
from contextvars import ContextVar

SESSION_TTL = 2 * 60 * 60
TOKEN = re.compile(r"[A-Za-z0-9_-]{43}")
_current = ContextVar("folio_review_session", default=None)


class ReviewCancelled(Exception):
    pass


class SessionUnavailable(Exception):
    pass


class LocalSessions:
    def __init__(self, capacity=4096, clock=time.monotonic):
        self.entries = OrderedDict()
        self.lock = threading.Lock()
        self.capacity = capacity
        self.clock = clock

    def create(self, key):
        with self.lock:
            now = self.clock()
            while self.entries and next(iter(self.entries.values())) <= now:
                self.entries.popitem(last=False)
            if len(self.entries) >= self.capacity:
                raise SessionUnavailable
            self.entries[key] = now + SESSION_TTL

    def active(self, key):
        with self.lock:
            return self.entries.get(key, 0) > self.clock()

    def cancel(self, key):
        with self.lock:
            self.entries.pop(key, None)


class HostedSessions:
    def __init__(self):
        # Request-scoped runtime credentials are provided by Vercel. Strict mode
        # rejects its process-local fallback when the shared cache is unavailable.
        from vercel.cache import RuntimeCache

        self.cache = RuntimeCache(strict=True)

    def call(self, method, *args):
        try:
            return method(*args)
        except Exception:
            # Keep transport details and runtime credentials out of responses.
            raise SessionUnavailable from None

    def create(self, key):
        self.call(self.cache.set, key, "active", {"ttl": SESSION_TTL, "tags": [key]})
        if not self.active(key):
            raise SessionUnavailable

    def active(self, key):
        return self.call(self.cache.get, key) == "active"

    def cancel(self, key):
        # Revoke in other regions as well. Confirm the local write because the
        # SDK can report a failed write as a successful no-op.
        self.call(self.cache.expire_tag, key)
        self.call(self.cache.set, key, "cancelled", {"ttl": SESSION_TTL})
        if self.call(self.cache.get, key) != "cancelled":
            raise SessionUnavailable


LOCAL_SESSIONS = LocalSessions()


def session_store(local):
    if local:
        return LOCAL_SESSIONS
    try:
        return HostedSessions()
    except (ImportError, RuntimeError):
        raise SessionUnavailable from None


def session_key(token):
    if not isinstance(token, str) or not TOKEN.fullmatch(token):
        raise ReviewCancelled
    return "folio-review-session-v1-" + hashlib.sha256(token.encode("ascii")).hexdigest()


def create_session(store):
    token = secrets.token_urlsafe(32)
    store.create(session_key(token))
    return token


def check_session():
    current = _current.get()
    if current is not None:
        store, key = current
        if not store.active(key):
            raise ReviewCancelled


@contextmanager
def review_session(token, local):
    if token is None:
        yield
        return
    key = session_key(token)
    context = _current.set((session_store(local), key))
    try:
        check_session()
        yield
        check_session()
    finally:
        _current.reset(context)
