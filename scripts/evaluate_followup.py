"""Compare the fixed and follow-up reviewers on a synthetic, author-labeled codebook.

    python3.12 scripts/evaluate_followup.py                  # offline fixture/scorer checks
    python3.12 scripts/evaluate_followup.py --live           # requires ANTHROPIC_API_KEY
    python3.12 scripts/evaluate_followup.py --live --case guide-linked-exception

Live mode submits only the selected bundled fixture payloads. It shares one production
plan and initial retrieval per pair. Output is JSON, including the source quotations
and labels, so an analyst can audit where the mechanical scorer agrees or disagrees.
"""

import argparse
import io
import json
import os
import sys
import time
from collections import Counter
from contextlib import contextmanager
from copy import deepcopy
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from api._review import model, planner, search  # noqa: E402

FIXTURE = ROOT / "tests" / "fixtures" / "followup_cases.json"
MODES = ("fixed", "adaptive")
SIDES = ("supporting", "counter")


def load_cases():
    return json.loads(FIXTURE.read_text(encoding="utf-8"))


def location(citation):
    return citation["documentId"], citation["page"]


def anchors_present(label, citations):
    quotes = [c["quote"].casefold() for c in citations if location(c) == location(label)]
    return all(any(anchor.casefold() in quote for quote in quotes) for anchor in label["anchors"])


def score(case, findings):
    """Score the final public findings; source exactness and labeled polarity are independent."""
    expected = case["expected"]
    _, _, pages = search.validate(case["payload"])
    row = findings[0] if len(findings) == 1 else {}
    citations = {side: [
        {key: c[key] for key in ("documentId", "page", "quote")} for c in row.get(side, [])
    ] for side in SIDES}
    for entries in citations.values():
        for c in entries:
            source = pages.get(location(c))
            c["exact"] = bool(source and c["quote"] and c["quote"] in source[1])

    matched = {side: all(anchors_present(label, citations[side]) for label in expected[side]) for side in SIDES}
    unexpected = {}
    for side in SIDES:
        optional = expected.get("optional" + side.capitalize(), [])
        allowed_pages = {location(label) for label in expected[side]}
        allowed_pages.update(location(label) for label in optional if anchors_present(label, citations[side]))
        unexpected[side] = any(location(c) not in allowed_pages for c in citations[side])

    status = row.get("status")
    complete = row.get("analysisEngine") == "anthropic"
    status_correct = status in expected["statuses"]
    exact = all(c["exact"] for side in SIDES for c in citations[side])
    polarity_correct = all(matched.values()) and not any(unexpected.values())
    exception_found = None
    if expected.get("exception") and complete:
        exception_found = matched["counter"] and status in ("mixed", "contradicted") and all(c["exact"] for c in citations["counter"])
    positive = status in ("contradicted", "mixed") or bool(citations["counter"])
    verifier_rejected = "failed the citation or scope checks" in row.get("answer", "")
    return {
        "criterionCount": len(findings), "assessed": complete, "status": status, "answer": row.get("answer"),
        "followup": row.get("followup"),
        "statusCorrect": status_correct, "citations": citations, "citationsExact": exact,
        "polarityCorrect": polarity_correct, "verifierRejected": verifier_rejected,
        "exceptionFound": exception_found,
        "falseContradiction": bool((positive and not expected["counter"]) or unexpected["counter"]),
        "passed": complete and status_correct and polarity_correct and exact and not verifier_rejected,
    }


def check(condition, message):
    if not condition:
        raise ValueError(message)


def check_case(case):
    mode, criteria, pages = search.validate(case["payload"])
    expected = case["expected"]
    finding, = search.retrieve(pages, search.basic_plan(criteria))
    check(bool(finding["candidates"]), f"{case['id']} has no initial evidence")
    finding.update(status=expected["statuses"][0], analysisEngine="anthropic", answer="Fixture scoring check.")
    for side in SIDES:
        for label in expected[side] + expected.get("optional" + side.capitalize(), []):
            citation = {**label, "quote": pages[location(label)][1]}
            check(bool(label["anchors"]) and anchors_present(label, [citation]), f"{case['id']}: invalid {side} anchor")
            finding[side].append(citation)
    check(score(case, [finding])["passed"], f"{case['id']}: expected evidence failed scoring")
    check(not score(case, [])["passed"], f"{case['id']}: missing finding passed scoring")
    tampered = deepcopy(finding)
    tampered["counter"].append({"documentId": "missing", "page": 1, "quote": "This invented quote lacks a source."})
    invalid = score(case, [tampered])
    check(not invalid["citationsExact"] and not invalid["passed"], f"{case['id']}: invented citation passed scoring")
    swapped = {**finding, "counter": finding["supporting"], "supporting": finding["counter"]}
    check(not score(case, [swapped])["passed"], f"{case['id']}: swapped polarity passed scoring")
    if expected.get("exception"):
        initial_pages = {location(c) for c in finding["candidates"]}
        check(all(location(c) not in initial_pages for c in expected["counter"]), f"{case['id']}: local initial retrieval already found exception")
        missed = score(case, [{**finding, "counter": [], "status": "supported"}])
        check(missed["exceptionFound"] is False and not missed["passed"], f"{case['id']}: missed exception passed scoring")
    elif not expected["counter"]:
        spurious = score(case, [{**finding, "status": "mixed"}])
        check(spurious["falseContradiction"] and not spurious["passed"], f"{case['id']}: false contradiction passed scoring")
    report = {"case": case["id"], "workflow": mode, "localInitialPages": sorted({location(c) for c in finding["candidates"]})}
    if sample := case.get("lookupCheck"):
        check(any(sample["term"] in c["quote"] for c in finding["candidates"]), f"{case['id']}: lookup missing its source")
        lookup = search.followup_lookup(pages, sample["term"], finding["candidates"])
        new_pages = sorted({location(c) for c in lookup["passages"]})
        check(new_pages == sorted(map(tuple, sample["newPages"])), f"{case['id']}: unexpected lookup result")
        report["localLookup"] = {"term": sample["term"], "newPages": new_pages}
    return report


@contextmanager
def measured():
    """Observe usage from production HTTP responses without recording request data."""
    original_open = model.open_provider_request
    usage = Counter()
    metrics = {"modelCalls": 0, "callsWithUsage": 0}
    started = time.monotonic()

    def counted_open(outgoing, **kwargs):
        metrics["modelCalls"] += 1
        with original_open(outgoing, **kwargs) as response:
            raw = response.read(model.MAX_RESPONSE_BYTES + 1)
        try:
            envelope = json.loads(raw)
        except (ValueError, UnicodeError):
            envelope = {}
        provider_usage = envelope.get("usage") if isinstance(envelope, dict) else None
        if isinstance(provider_usage, dict):
            usage.update({k: v for k, v in provider_usage.items() if type(v) is int and k.endswith("_tokens")})
            metrics["callsWithUsage"] += 1
        return io.BytesIO(raw)

    with patch.object(model, "open_provider_request", counted_open):
        try:
            yield metrics
        finally:
            metrics.update(seconds=round(time.monotonic() - started, 3), tokens=dict(usage))


def run_pair(case, key, position):
    payload = case["payload"]
    mode, criteria, pages = search.validate(payload)
    source = payload["questions" if mode == "questionnaire" else "guide"]
    result = {"case": case["id"], "workflow": mode, "expected": case["expected"]}
    start = time.monotonic()
    with measured() as planning:
        result["sharedPlanningAndRetrieval"] = planning
        try:
            plan = planner.plan_criteria(mode, source, criteria, key, start + model.REVIEW_SECONDS)
        except (model.ProviderUnavailable, search.InvalidRequest):
            result["error"] = "Shared model planning failed."
            return result
        findings = search.retrieve(pages, plan)
    result["initial"] = [{"question": f["question"], "plannedTerms": f["plannedTerms"], "candidates": f["candidates"]} for f in findings]
    if len(findings) != 1:
        result["error"] = "Shared planner returned a different number of criteria than the codebook."
        return result
    remaining = max(0, model.REVIEW_SECONDS - (time.monotonic() - start))
    result["secondsAvailablePerReviewer"] = round(remaining, 3)
    order = MODES if position % 2 == 0 else MODES[::-1]
    result["reviewOrder"] = order
    for reviewer in order:
        with measured() as metrics:
            rows, notice = model.assess_findings(
                deepcopy(findings), pages, key, time.monotonic() + remaining, allow_followup=reviewer == "adaptive",
            )
        result[reviewer] = {**score(case, rows), "usage": metrics, "notice": notice}
    return result


def summarize(results, reviewer):
    """Exclude unavailable judgments from error counts and disclose their number."""
    rows = [pair[reviewer] for pair in results if reviewer in pair]
    assessed = [row for row in rows if row["assessed"]]
    exceptions = [row["exceptionFound"] for row in assessed if row["exceptionFound"] is not None]
    citations = [c for row in assessed for side in SIDES for c in row["citations"][side]]
    tokens = Counter()
    for row in rows:
        tokens.update(row["usage"]["tokens"])
    return {
        "cases": len(results), "assessed": len(assessed), "unassessed": len(results) - len(assessed),
        "passed": sum(r["passed"] for r in assessed), "correctStatuses": sum(r["statusCorrect"] for r in assessed),
        "correctPolarity": sum(r["polarityCorrect"] for r in assessed), "citations": len(citations),
        "exactCitations": sum(c["exact"] for c in citations),
        "foundExceptions": exceptions.count(True), "missedExceptions": exceptions.count(False),
        "unassessedExceptions": sum(bool(p["expected"].get("exception")) for p in results) - len(exceptions),
        "falseContradictions": sum(r["falseContradiction"] for r in assessed),
        "followups": sum(r["followup"] is not None for r in assessed),
        "reviewerCalls": sum(r["usage"]["modelCalls"] for r in rows),
        "reviewerCallsWithUsage": sum(r["usage"]["callsWithUsage"] for r in rows),
        "reviewerTokens": dict(tokens), "reviewerSeconds": round(sum(r["usage"]["seconds"] for r in rows), 3),
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--live", action="store_true", help="run both reviewers against the production model using synthetic inputs")
    parser.add_argument("--case", action="append", choices=[c["id"] for c in load_cases()], help="select a case; repeatable")
    args = parser.parse_args()
    cases = [c for c in load_cases() if not args.case or c["id"] in args.case]
    checks = [check_case(case) for case in cases]
    if not args.live:
        print(json.dumps({"mode": "offline-self-check", "note": "Fixture and scorer checks only. No model judgments.", "cases": checks}, indent=2))
        return
    key = os.environ.get("ANTHROPIC_API_KEY")
    if not key:
        parser.error("--live requires ANTHROPIC_API_KEY in the environment.")
    results = [run_pair(case, key, i) for i, case in enumerate(cases)]
    print(json.dumps({
        "mode": "live-paired", "model": model.MODEL,
        "labels": "Synthetic author-labeled examples without independent analyst validation.",
        "summary": {name: summarize(results, name) for name in MODES}, "cases": results,
    }, indent=2))
    if any(name not in pair or not pair[name]["assessed"] for pair in results for name in MODES):
        sys.exit(1)


if __name__ == "__main__":
    main()
