"""Run Folio's HTTP API for Playwright with an in-memory Anthropic transport."""

import base64
import hashlib
import io
import json
import os
import sys
import threading
from contextvars import ContextVar
from http.server import ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch

if __name__ == "__main__":
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from api import review
from api._review import model

failed_outage_cases = set()
outage_lock = threading.Lock()
transport = ContextVar("browser_provider_transport", default=None)


class ProviderTrace:
    def __init__(self):
        self.calls = []
        self.assessed = []
        self.lock = threading.Lock()


class BrowserReviewHandler(review.handler):
    def do_POST(self):
        token = transport.set(ProviderTrace())
        try:
            super().do_POST()
        finally:
            transport.reset(token)

    def end_headers(self):
        # The browser test can compare the actual provider bytes with its uploaded and selected PDFs.
        trace = transport.get()
        self.send_header("X-Test-Provider-Calls", json.dumps(trace.calls if trace else []))
        self.send_header("X-Test-Assessed-Criteria", json.dumps(trace.assessed if trace else []))
        super().end_headers()


def provider_input(content):
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
    return json.loads(content), documents


def read_scan(data, documents):
    # The scanned fixture prints these lines into images on the stated physical pages.
    source = data["role"] == "source"
    pages = [{"number": n, "text": f"Who keeps inspection log {n}?" if source
              else f"The registrar keeps inspection log {n}."} for n in data["pages"]]
    crossing = source and documents[0]["title"] == "Archive scan.pdf"
    if crossing:
        for page in pages:
            if page["number"] == 3:
                page["text"] = "Who keeps the inspection log"
            elif page["number"] == 4:
                page["text"] = "after the archive closes?"
    result = {"pages": pages}
    if source and data["mode"] == "questionnaire":
        result["questions"] = []
        for page in pages:
            if crossing and page["number"] == 4:
                if 3 in data["pages"]:
                    result["questions"][-1] += " " + page["text"]
            else:
                result["questions"].append(page["text"])
    return result


def omit_once(rows, field, question, call):
    # Simulate a valid tool envelope missing one of the later questionnaire rows.
    present = [row for row in rows if row[field] != question]
    if len(present) == len(rows):
        return rows
    trace = transport.get()
    with trace.lock:
        if any(previous.get("omitted") == question for previous in trace.calls):
            return rows
        call["omitted"] = question
    return present


def search_plan(data, call):
    rows = []
    for source in omit_once(data["sources"], "text", "57. Who keeps inspection log 57?", call):
        if source["required"]:
            row = {"sourceId": source["sourceId"], "searchTerms": ["inspection log"]}
            if data["mode"] == "guide":
                row["question"] = source["text"]
            rows.append(row)
    return {"criteria": rows}


def assess(row):
    trace = transport.get()
    with trace.lock:
        trace.assessed.append(hashlib.sha256(row["criterion"].encode()).hexdigest())
    if row["criterion"].startswith("Who keeps the outage log for case "):
        with outage_lock:
            if row["criterion"] not in failed_outage_cases:
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
    data, documents = provider_input(payload["messages"][0]["content"])
    call = {"tool": name, "documents": documents}
    trace = transport.get()
    with trace.lock:
        trace.calls.append(call)
    if name == "record_pdf_pages":
        result = read_scan(data, documents)
    elif name == "record_response_draft":
        if data["action"] == "draft":
            answer = data["assessment"] if data["citations"] else "The available policy does not establish the answer."
        elif data["action"] == "expand":
            answer = data["answer"] + " " + data["citations"][0]["quote"]
        elif data["action"] == "shorten":
            answer = "The facilities coordinator."
        else:
            answer = "The coordinator records the date."
        result = {"answer": answer}
    elif name == "record_policy_action_draft":
        wording = {
            "draft": "Document who signs the inspection log at closing.",
            "shorten": "Document the log signer.",
            "simplify": "Say who signs the log.",
            "expand": data["actionText"] + " Include the sign-off step in the closing instructions.",
        }
        result = {"actionText": wording[data["action"]]}
    elif name == "record_search_plan":
        if any(unit["text"] == "1. Who keeps inspection log 1?" for unit in data["sources"]):
            # No usable plan on the very first part of the 65-question PDF.
            return io.BytesIO(b'{"stop_reason":"end_turn","content":null}')
        result = search_plan(data, call)
    else:
        assert name == "record_review"
        rows = omit_once(data, "criterion", "64. Who keeps inspection log 64?", call)
        result = {"assessments": [assess(row) for row in rows]}
    envelope = {"stop_reason": "tool_use", "content": [{"type": "tool_use", "name": name, "input": result}]}
    return io.BytesIO(json.dumps(envelope).encode())


if __name__ == "__main__":
    config = {"VERCEL": "", "ANTHROPIC_API_KEY": "playwright-fixture"}
    # All browser sessions share one loopback address. The HTTP tests exercise the production quota.
    with (
        patch.dict(os.environ, config),
        patch.object(model, "open_provider_request", provider_reply),
        patch.object(review, "REVIEW_LIMIT", review.ReviewRateLimit(limit=1000)),
        patch.object(review, "SESSION_LIMIT", review.ReviewRateLimit(limit=1000)),
    ):
        port = int(os.environ.get("FOLIO_TEST_API_PORT", "4178"))
        with ThreadingHTTPServer(("127.0.0.1", port), BrowserReviewHandler) as server:
            server.local_operator = True
            server.serve_forever()
