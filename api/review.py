"""Vercel Python function and loopback development server for compliance reviews."""

import json
import os
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

if __name__ == "__main__":
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from api._review.draft import MAX_DRAFT_BYTES, draft_response
from api._review.model import ProviderUnavailable, model_review
from api._review.rate_limit import LIMIT, WINDOW_SECONDS, ReviewRateLimit, network_key
from api._review.search import (
    MAX_REQUEST_BYTES,
    MAX_RESULT_BYTES,
    InvalidRequest,
    ReviewPartTooLarge,
    validate,
)
from api._review.sessions import (
    ReviewCancelled,
    SessionUnavailable,
    create_session,
    review_session,
    session_key,
    session_store,
)

MAX_BODY = MAX_REQUEST_BYTES
MAX_RESPONSE = MAX_RESULT_BYTES
REVIEW_LIMIT = ReviewRateLimit()
SESSION_LIMIT = ReviewRateLimit(limit=60)
INVALID_BODY = object()


def same_origin(headers):
    origin = headers.get("Origin")
    if origin is None:
        return True
    try:
        source = urlsplit(origin)
        return source.scheme in ("http", "https") and source.netloc.lower() == headers.get("Host", "").lower()
    except ValueError:
        return False


def allowed_local_request(headers):
    # Loopback also serves the Vite proxy. Check the HTTP authority before granting local-operator access.
    try:
        host = urlsplit("//" + headers.get("Host", ""))
        if host.hostname not in ("localhost", "127.0.0.1", "::1") or host.username is not None or host.path or host.query or host.fragment:
            return False
        return same_origin(headers)
    except ValueError:
        return False


def review(payload, *, local_operator=False):
    mode, criteria, pages = validate(payload)
    findings, notice, planner, read_text = model_review(payload, criteria, pages, local_operator)
    used_model = planner == "anthropic" or any(f["analysisEngine"] == "anthropic" for f in findings)
    return {
        **read_text,
        "mode": mode, "engine": "anthropic" if used_model else "local",
        "notice": notice, "findings": findings, "planningEngine": planner, "criterionLimitReached": False,
        "reviewScope": {"documents": len(payload["documents"]), "pages": len(pages), "criteria": len(findings)},
    }


class handler(BaseHTTPRequestHandler):
    def reply(self, status, data, *, retry_after=None):
        body = bytearray()
        for part in json.JSONEncoder(ensure_ascii=True, separators=(",", ":")).iterencode(data):
            if len(body) + len(part) > MAX_RESPONSE:
                status = 422
                body = b'{"code":"review_part_too_large","error":"The review results are too large. Select fewer questions or fewer policy pages."}'
                break
            body.extend(part.encode("ascii"))
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Content-Length", str(len(body)))
        if retry_after is not None:
            self.send_header("Retry-After", str(retry_after))
        if status == 405:
            self.send_header("Allow", "POST")
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        route = urlsplit(self.path)
        path = route.path.removesuffix("/")
        if path not in ("/api/review", "/api/review-session"):
            return self.reply(404, {"error": "Review endpoint not found."})
        local_operator = getattr(self.server, "local_operator", False)
        if self.headers.get("Sec-Fetch-Site") == "cross-site" or (local_operator and not allowed_local_request(self.headers)):
            return self.reply(403, {"error": "Open Folio to submit a review from this site."})
        peer = self.client_address[0] if self.client_address else None
        key = network_key(self.headers, peer, vercel=not local_operator and os.environ.get("VERCEL") == "1")
        query = parse_qs(route.query, keep_blank_values=True)
        if path == "/api/review-session" or query.get("control") == ["session"]:
            if self.headers.get("Sec-Fetch-Site") == "same-site" or not same_origin(self.headers):
                return self.reply(403, {"error": "Open Folio to manage a review session."})
            return self.session_body(key, local_operator)
        self.submit_review(key, local_operator, query.get("operation"))

    def submit_review(self, key, local_operator, operation):
        if operation not in (None, ["draft"]):
            return self.reply(400, {"error": "Unknown review operation."})
        limited = REVIEW_LIMIT.claim(key)
        if limited:
            status, wait = limited
            warning = (f"This network has reached its limit of {LIMIT} review submissions per {WINDOW_SECONDS // 60} minutes."
                       if status == 429 else "The review service is at capacity.")
            unit = "second" if wait == 1 else "seconds"
            return self.reply(status, {"error": f"{warning} Try again in {wait} {unit}."}, retry_after=wait)
        work, limit = (draft_response, MAX_DRAFT_BYTES) if operation else (review, MAX_BODY)
        payload = self.read_payload(limit)
        if payload is not INVALID_BODY:
            self.review_body(payload, local_operator, work)

    def read_payload(self, limit):
        if self.headers.get_content_type() != "application/json":
            self.reply(415, {"error": "Send an application/json request body."})
            return INVALID_BODY
        try:
            length = int(self.headers.get("Content-Length", ""))
            if length <= 0:
                raise ValueError
        except ValueError:
            self.reply(400, {"error": "A nonempty JSON request body is required."})
            return INVALID_BODY
        if length > limit:
            self.reply(413, {"error": f"The request exceeds {limit:,} bytes."})
            return INVALID_BODY
        try:
            return json.loads(self.rfile.read(length).decode("utf-8"))
        except (ValueError, RecursionError):
            self.reply(400, {"error": "The request must contain valid UTF-8 JSON."})
            return INVALID_BODY

    def session_body(self, key, local_operator):
        payload = self.read_payload(256)
        if payload is INVALID_BODY:
            return
        if not isinstance(payload, dict) or set(payload) not in (set(), {"token"}):
            return self.reply(400, {"error": "Send an empty object to start, or a session token to cancel."})
        # A burst of starts must leave capacity for the same network to cancel.
        limited = SESSION_LIMIT.claim((key, "cancel" if payload else "start"))
        if limited:
            status, wait = limited
            return self.reply(status, {"error": "Too many session requests. Try again shortly."}, retry_after=wait)
        try:
            store = session_store(local_operator)
            if payload:
                store.cancel(session_key(payload["token"]))
                return self.reply(200, {"cancelled": True})
            return self.reply(201, {"token": create_session(store)})
        except ReviewCancelled:
            return self.reply(400, {"error": "Invalid session token."})
        except SessionUnavailable:
            return self.reply(503, {"error": "Review sessions are temporarily unavailable."})

    def review_body(self, payload, local_operator, work):
        try:
            with review_session(self.headers.get("X-Folio-Review-Token"), local_operator):
                result = work(payload, local_operator=local_operator)
        except ReviewCancelled:
            return self.reply(409, {"code": "review_cancelled", "error": "This review session has stopped or expired."})
        except SessionUnavailable:
            return self.reply(503, {"error": "Review sessions are temporarily unavailable."})
        except ReviewPartTooLarge as exc:
            return self.reply(422, {"code": "review_part_too_large", "error": str(exc)})
        except InvalidRequest as exc:
            return self.reply(422, {"error": str(exc)})
        except ProviderUnavailable as exc:
            return self.reply(503, {"error": str(exc)})
        return self.reply(200, result)

    def do_GET(self):
        self.reply(405, {"error": "Use POST to submit a review."})

    def log_message(self, format, *args):
        # The development server must not log request URLs or client document content.
        pass


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "8000"))
    server = ThreadingHTTPServer(("127.0.0.1", port), handler)
    server.local_operator = True
    print(f"Review API listening on http://127.0.0.1:{port}/api/review", flush=True)
    server.serve_forever()
