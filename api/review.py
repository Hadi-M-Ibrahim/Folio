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
from api._review.search import MAX_CRITERIA, InvalidRequest, validate

MAX_BODY = 4_000_000


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
    def reply(self, status, data):
        body = json.dumps(data, ensure_ascii=True, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Content-Length", str(len(body)))
        if status == 405:
            self.send_header("Allow", "POST")
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        if urlsplit(self.path).path.rstrip("/") != "/api/review":
            return self.reply(404, {"error": "Review endpoint not found."})
        if self.headers.get_content_type() != "application/json":
            return self.reply(415, {"error": "Send an application/json request body."})
        try:
            length = int(self.headers.get("Content-Length", ""))
            if length <= 0:
                raise ValueError
        except ValueError:
            return self.reply(400, {"error": "A nonempty JSON request body is required."})
        if length > MAX_BODY:
            return self.reply(413, {"error": "The review request exceeds 4,000,000 bytes. Split it into smaller batches."})
        try:
            payload = json.loads(self.rfile.read(length).decode("utf-8"))
        except (ValueError, RecursionError):
            return self.reply(400, {"error": "The request must contain valid UTF-8 JSON."})
        try:
            result = review(payload, local_operator=getattr(self.server, "local_operator", False))
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
