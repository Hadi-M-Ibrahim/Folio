"""Run Folio's HTTP API for Playwright with an in-memory Anthropic transport."""

import io
import json
import os
import runpy
import sys
from pathlib import Path
from unittest.mock import patch

if __name__ == "__main__":
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from api._review import model

failed_outage_cases = set()


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
    data = json.loads(payload["messages"][0]["content"])
    if name == "record_search_plan":
        result = search_plan(data)
    else:
        assert name == "record_review"
        result = {"assessments": [assess(row) for row in data]}
    envelope = {"stop_reason": "tool_use", "content": [{"type": "tool_use", "name": name, "input": result}]}
    return io.BytesIO(json.dumps(envelope).encode())


if __name__ == "__main__":
    config = {"VERCEL": "", "ANTHROPIC_API_KEY": "playwright-fixture", "PORT": "4178"}
    with patch.dict(os.environ, config), patch.object(model, "open_provider_request", provider_reply):
        runpy.run_module("api.review", run_name="__main__")
