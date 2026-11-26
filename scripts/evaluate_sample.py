"""Run the fictional case in both modes and compare live findings to the authored rubric."""

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from api.review import review

EXPECTED = [
    ("mixed", ("grievance-policy", 1), ("service-playbook", 2)),
    ("supported", ("service-playbook", 1), None),
    ("supported", ("grievance-policy", 2), None),
    ("contradicted", None, ("escalation-standard", 1)),
    ("insufficient", None, None),
]


def evaluate(mode, sample):
    field = "questions" if mode == "questionnaire" else "guide"
    result = review({"mode": mode, field: sample[field], "documents": sample["documents"], "allowModel": True})
    if result["engine"] != "anthropic":
        print(f"{mode}: live assessment unavailable. {result['notice']}")
        return False
    # Compare by source identity; an extraction can reorder the guide obligations.
    sources = sample["questions"] if mode == "questionnaire" else [
        line.split(". ", 1)[1] for line in sample["guide"].splitlines() if line[:1].isdigit()
    ]
    observed = [[] for _ in sources]
    for finding in result["findings"]:
        if mode == "guide":
            start, end = finding["criterionStart"], finding["criterionEnd"]
            indices = [i for i, text in enumerate(sources) if
                       sample["guide"].index(text) <= start < end <= sample["guide"].index(text) + len(text)]
        else:
            indices = [i for i, text in enumerate(sources) if text == finding["criterionSource"]]
        if len(indices) == 1:
            observed[indices[0]].append(finding)
    matches = 0
    for number, (rows, (expected, support, counter)) in enumerate(zip(observed, EXPECTED), 1):
        statuses = [row["status"] for row in rows]
        cited = {}
        for side in ("supporting", "counter"):
            cited[side] = {(e["documentId"], e["page"]) for row in rows for e in row[side]}
        correct_pages = (
            (support is None or support in cited["supporting"])
            and (counter is None or counter in cited["counter"])
        )
        matches += statuses == [expected] and correct_pages
        pages_message = "" if correct_pages else " (expected source page missing)"
        print(f"{mode} {number}: expected {expected}, got {', '.join(statuses) or 'missing'}{pages_message}")
    print(f"{mode}: {matches} of {len(sources)} synthetic outcomes matched.")
    return len(result["findings"]) == len(sources) == matches


if __name__ == "__main__":
    sample = json.loads((ROOT / "api/sample.json").read_text())
    checks = [evaluate(mode, sample) for mode in ("questionnaire", "guide")]
    raise SystemExit(0 if all(checks) else 1)
