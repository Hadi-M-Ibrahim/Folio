import time
import unittest
from unittest.mock import patch

from api._review import model
from api._review.search import basic_plan, retrieve, validate

RULE = "The clerk stamps every parcel before dispatch. See Appendix B for fragile items."
ANNEX = "Appendix B. Fragile items go unmarked to prevent damage."
QUESTION = "Does the clerk stamp every parcel before dispatch?"
REQUEST = {"passage": "p1", "term": "Appendix B", "reason": "cross_reference"}


def first_pass(lookup=REQUEST):
    return {
        "id": "q1", "status": "supported", "answer": "The clerk stamps every parcel.",
        "supporting": [{"passage": "p1", "quote": RULE}], "counter": [], "followup": lookup,
    }


class FollowupReviewTests(unittest.TestCase):
    def run_case(self, outputs, *, annex=True, questions=(QUESTION,), enabled=True):
        docs = [{"id": "book", "title": "Shipping", "pages": [{"number": 1, "text": RULE}]}]
        if annex:
            docs[0]["pages"].append({"number": 19, "text": ANNEX})
        _, criteria, pages = validate({"mode": "questionnaire", "questions": list(questions), "documents": docs})
        initial = retrieve(pages, basic_plan(criteria))
        deadline = time.monotonic() + 70
        with patch.object(model, "invoke_tool", side_effect=outputs) as invoke:
            result, _ = model.assess_findings(initial, pages, "test-key", deadline, allow_followup=enabled)
        self.assertEqual({call.args[4] for call in invoke.call_args_list}, {deadline})
        return result, invoke.call_args_list

    def test_new_evidence_reaches_only_the_requested_criterion_and_citations_stay_verifiable(self):
        final = {
            "id": "q1", "status": "mixed", "answer": "Fragile items travel unmarked.",
            "supporting": [{"passage": "p1", "quote": RULE}],
            "counter": [{"passage": "p2", "quote": ANNEX, "scope": {
                "actor": "same", "event": "same", "population": "overlaps", "duty": "same",
                "eventComparison": "Both govern dispatch.", "dutyComparison": "Both govern marking a parcel.",
            }}],
        }
        direct = {"id": "q2", "status": "supported", "answer": "The clerk stamps parcels.",
                  "supporting": [{"passage": "p1", "quote": RULE}], "counter": []}
        rows, calls = self.run_case([{"assessments": [first_pass(), direct]}, {"assessments": [final]}],
                                    questions=(QUESTION, "Who stamps parcels before dispatch?"))
        self.assertEqual(len(calls), 2)
        assignment, = calls[1].args[2]
        self.assertEqual(assignment["id"], "q1")
        self.assertEqual([(p["passage"], p["page"], p["newlyFound"]) for p in assignment["passages"]],
                         [("p1", 1, False), ("p2", 19, True)])
        self.assertEqual(assignment["lookup"]["originPassage"], "p1")
        self.assertNotIn("followup", calls[1].args[1]["input_schema"]["properties"]["assessments"]["items"]["properties"])
        self.assertEqual(rows[0]["status"], "mixed")
        self.assertEqual(rows[0]["followup"]["source"]["quote"], RULE)
        self.assertEqual(rows[0]["counter"][0]["quote"], ANNEX)
        self.assertEqual([p["page"] for p in rows[0]["candidates"]], [1])
        self.assertNotIn("followup", rows[1])

    def test_absent_reference_logs_search_and_withholds_provisional_answer(self):
        rows, calls = self.run_case([{"assessments": [first_pass()]}], annex=False)
        self.assertEqual(len(calls), 1)
        row, = rows
        self.assertEqual(row["status"], "needs_review")
        self.assertEqual(row["followup"]["proof"]["totalHits"], 1)
        self.assertEqual(row["followup"]["passages"], [])

    def test_malformed_or_unanchored_requests_never_trigger_search(self):
        for invalid in (None, {}, {**REQUEST, "passage": []}, {**REQUEST, "passage": "p2"},
                        {**REQUEST, "reason": "other"}, {**REQUEST, "term": "Fabricated citation"},
                        {**REQUEST, "term": "the"}, {**REQUEST, "term": "App"}, {**REQUEST, "term": "X" * 81}):
            with self.subTest(request=invalid), patch.object(model, "followup_lookup") as lookup:
                rows, calls = self.run_case([{"assessments": [first_pass(invalid)]}])
                lookup.assert_not_called()
                self.assertEqual(len(calls), 1)
                self.assertEqual(rows[0]["status"], "needs_review")
                self.assertNotIn("followup", rows[0])

    def test_failed_invalid_and_repeated_final_requests_leave_an_inspectable_unresolved_finding(self):
        bad_quote = {**first_pass(), "supporting": [{"passage": "p2", "quote": "An invented rule."}]}
        del bad_quote["followup"]
        for final in (model.ProviderUnavailable(), {"assessments": []}, {"assessments": [first_pass()]},
                      {"assessments": [bad_quote]}):
            with self.subTest(final=final):
                rows, calls = self.run_case([{"assessments": [first_pass()]}, final])
                self.assertEqual(len(calls), 2)
                self.assertEqual(rows[0]["followup"]["passages"][0]["page"], 19)
                self.assertEqual(rows[0]["status"], "needs_review")

    def test_first_passes_have_priority_and_final_calls_keep_the_same_deadline(self):
        first = {"assessments": [first_pass()]}
        rows, calls = self.run_case([first, {"assessments": []}, model.ProviderUnavailable()],
                                    questions=(QUESTION,) * (model.BATCH_SIZE + 1))
        self.assertEqual([len(call.args[2]) for call in calls], [model.BATCH_SIZE, 1, 1])
        self.assertNotIn("lookup", calls[1].args[2][0])
        self.assertIn("lookup", calls[2].args[2][0])
        self.assertEqual(rows[0]["status"], "needs_review")

    def test_fixed_baseline_uses_original_tool_and_no_lookup(self):
        output = first_pass()
        del output["followup"]
        rows, calls = self.run_case([{"assessments": [output]}], enabled=False)
        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0].args[:2], (model.SYSTEM, model.TOOL))
        self.assertEqual(rows[0]["status"], "supported")
