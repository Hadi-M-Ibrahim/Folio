"""Run Folio's HTTP API for Playwright with an in-memory Anthropic transport."""

import base64
import hashlib
import io
import json
import os
import sys
import threading
from http.server import ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch

if __name__ == "__main__":
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from api import review
from api._review import model

failed_outage_cases = set()
transport = threading.local()


class BrowserReviewHandler(review.handler):
    def do_POST(self):
        transport.calls = []
        super().do_POST()

    def end_headers(self):
        # The browser test can compare the actual provider bytes with its uploaded and selected PDFs.
        self.send_header("X-Test-Provider-Calls", json.dumps(getattr(transport, "calls", [])))
        super().end_headers()


def provider_input(name, content):
    documents = []
    if isinstance(content, list):
        assert content[-1]["type"] == "text"
        for block in content[:-1]:
            assert block["type"] == "document"
            source = block["source"]
            assert source["type"] == "base64" and source["media_type"] == "application/pdf"
            pdf = base64.b64decode(source["data"], validate=True)
            assert pdf.startswith(b"%PDF-")
            documents.append({**json.loads(block["context"]), "title": block["title"],
                              "sha256": hashlib.sha256(pdf).hexdigest()})
        assert documents
        content = content[-1]["text"]
    transport.calls.append({"tool": name, "documents": documents})
    return json.loads(content)


def read_scan(data):
    # The scanned fixture prints these lines into images on the stated physical pages.
    source = data["role"] == "source"
    pages = [{"number": n, "text": f"Who keeps inspection log {n}?" if source
              else f"The registrar keeps inspection log {n}."} for n in data["pages"]]
    result = {"pages": pages}
    if source and data["mode"] == "questionnaire":
        result["questions"] = [page["text"] for page in pages]
    return result


def search_plan(data):
    rows = []
    for source in data["sources"]:
        if source["required"]:
            row = {"sourceId": source["sourceId"], "searchTerms": ["inspection log"]}
            if data["mode"] == "guide":
                row["question"] = source["text"]
            rows.append(row)
    return {"criteria": rows}


def assess(row):
    if row["criterion"].startswith("Who keeps the outage log for case ") and row["criterion"] not in failed_outage_cases:
        failed_outage_cases.add(row["criterion"])
        raise OSError("Simulated upstream outage")
    passages = row["passages"]
    if not passages:
        return {"id": row["id"], "status": "insufficient", "answer": "No passages.", "supporting": [], "counter": []}
    passage = next((item for item in passages if item.get("newlyFound")), passages[0])
    result = {"id": row["id"], "status": "supported", "answer": passage["quote"],
              "supporting": [{"passage": passage["passage"], "quote": passage["quote"]}], "counter": []}
    if "see Appendix B" in passage["quote"] and "lookup" not in row:
        result.update(status="needs_review", supporting=[], followup={
            "reason": "cross_reference", "passage": passage["passage"], "term": "Appendix B",
        })
    return result


def provider_reply(outgoing, *, timeout):
    assert outgoing.full_url == "https://api.anthropic.com/v1/messages"
    payload = json.loads(outgoing.data)
    name = payload["tools"][0]["name"]
    data = provider_input(name, payload["messages"][0]["content"])
    if name == "record_pdf_pages":
        result = read_scan(data)
    elif name == "record_search_plan":
        result = search_plan(data)
    else:
        assert name == "record_review"
        result = {"assessments": [assess(row) for row in data]}
    envelope = {"stop_reason": "tool_use", "content": [{"type": "tool_use", "name": name, "input": result}]}
    return io.BytesIO(json.dumps(envelope).encode())


if __name__ == "__main__":
    config = {"VERCEL": "", "ANTHROPIC_API_KEY": "playwright-fixture"}
    # All browser sessions share one loopback address. The HTTP tests exercise the production quota.
    with (
        patch.dict(os.environ, config),
        patch.object(model, "open_provider_request", provider_reply),
        patch.object(review, "REVIEW_LIMIT", review.ReviewRateLimit(limit=1000)),
    ):
        with ThreadingHTTPServer(("127.0.0.1", 4178), BrowserReviewHandler) as server:
            server.local_operator = True
            server.serve_forever()
