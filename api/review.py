"""Vercel Python function and loopback development server for compliance reviews."""

import json
import os
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

if __name__ == "__main__":
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from api._review.model import model_review
from api._review.rate_limit import LIMIT, WINDOW_SECONDS, ReviewRateLimit, network_key
from api._review.search import MAX_CRITERIA, InvalidRequest, validate

MAX_BODY = 4_000_000
MAX_RESPONSE = 4_000_000
REVIEW_LIMIT = ReviewRateLimit()


def allowed_local_request(headers):
    # Loopback also serves the Vite proxy. Check the HTTP authority before granting local-operator access.
    try:
        host = urlsplit("//" + headers.get("Host", ""))
        if host.hostname not in ("localhost", "127.0.0.1", "::1") or host.username is not None or host.path or host.query or host.fragment:
            return False
        origin = headers.get("Origin")
        if origin is None:
            return True
        source = urlsplit(origin)
        return source.scheme in ("http", "https") and source.netloc.lower() == host.netloc.lower()
    except ValueError:
        return False


def review(payload, *, local_operator=False):
    mode, criteria, pages = validate(payload)
    findings, notice, planner = model_review(payload, criteria, pages, local_operator)
    criterion_limit_reached = mode == "guide" and len(findings) == MAX_CRITERIA
    if criterion_limit_reached:
        notice += f" This section reached the {MAX_CRITERIA}-criterion limit. Check the guide for additional requirements."
    return {
        "mode": mode, "engine": "anthropic" if any(f["analysisEngine"] == "anthropic" for f in findings) else "local",
        "notice": notice, "findings": findings, "planningEngine": planner, "criterionLimitReached": criterion_limit_reached,
        "reviewScope": {"documents": len(payload["documents"]), "pages": len(pages), "criteria": len(findings)},
    }


class handler(BaseHTTPRequestHandler):
    def reply(self, status, data, *, retry_after=None):
        body = bytearray()
        for part in json.JSONEncoder(ensure_ascii=True, separators=(",", ":")).iterencode(data):
            if len(body) + len(part) > MAX_RESPONSE:
                status = 422
                body = b'{"error":"The review results are too large. Select fewer questions or fewer policy pages."}'
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
        if self.path.partition("?")[0] not in ("/api/review", "/api/review/"):
            return self.reply(404, {"error": "Review endpoint not found."})
        local_operator = getattr(self.server, "local_operator", False)
        if self.headers.get("Sec-Fetch-Site") == "cross-site" or (local_operator and not allowed_local_request(self.headers)):
            return self.reply(403, {"error": "Open Folio to submit a review from this site."})
        peer = self.client_address[0] if self.client_address else None
        key = network_key(self.headers, peer, vercel=not local_operator and os.environ.get("VERCEL") == "1")
        limited = REVIEW_LIMIT.claim(key)
        if limited:
            status, wait = limited
            warning = (f"This network has reached its limit of {LIMIT} review submissions per {WINDOW_SECONDS // 60} minutes."
                       if status == 429 else "The review service is at capacity.")
            unit = "second" if wait == 1 else "seconds"
            return self.reply(status, {"error": f"{warning} Try again in {wait} {unit}."}, retry_after=wait)
        if self.headers.get_content_type() != "application/json":
            return self.reply(415, {"error": "Send an application/json request body."})
        try:
            length = int(self.headers.get("Content-Length", ""))
            if length <= 0:
                raise ValueError
        except ValueError:
            return self.reply(400, {"error": "A nonempty JSON request body is required."})
        if length > MAX_BODY:
            return self.reply(413, {"error": f"The review request exceeds {MAX_BODY:,} bytes. Split it into smaller batches."})
        try:
            payload = json.loads(self.rfile.read(length).decode("utf-8"))
        except (ValueError, RecursionError):
            return self.reply(400, {"error": "The request must contain valid UTF-8 JSON."})
        try:
            result = review(payload, local_operator=local_operator)
        except InvalidRequest as exc:
            return self.reply(422, {"error": str(exc)})
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
