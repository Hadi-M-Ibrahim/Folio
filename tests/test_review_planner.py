import os
import unittest
from unittest.mock import patch

from api import review as api
from api._review import model, planner
from api._review.search import MAX_CRITERIA, InvalidRequest


class PlannerTests(unittest.TestCase):
    def plan(self, mode, source, fallback, rows):
        with patch.object(model, "invoke_tool", return_value={"criteria": rows}) as invoke:
            plan = planner.plan_criteria(mode, source, fallback, "test-key", 100)
        invoke.assert_called_once()
        return plan, invoke.call_args

    def test_compound_obligations_share_verbatim_source_and_offset(self):
        clause = "Plans must notify members and record appeals within 10 days."
        guide = "\n Éligibilité\n\n" + clause
        start = guide.index(clause)
        rows = [
            {"sourceId": "s2", "question": "Must members be notified?", "searchTerms": ["notice", "verbal only"]},
            {"sourceId": "s2", "question": "Are appeals recorded within 10 days?", "searchTerms": ["appeal log", "ten days"]},
        ]
        plan, call = self.plan("guide", guide, [(clause, start)], rows)
        self.assertEqual([r["question"] for r in plan], [r["question"] for r in rows])
        for item in plan:
            self.assertEqual(item["start"], start)
            self.assertEqual(guide[item["start"]:item["start"] + len(item["source"])], clause)
        self.assertEqual(plan[0]["searchTerms"], ["notice", "verbal only"])
        self.assertEqual(call.args[2]["sources"][0]["text"], guide[:start])
        self.assertFalse(call.args[2]["sources"][0]["required"])
        self.assertEqual(call.args[3], "test-key")
        self.assertEqual(set(call.args[2]), {"mode", "sources"})

    def test_optional_source_and_repeated_occurrence(self):
        context = "File an appeal. File an appeal.\n\n"
        clause = "Plans must deliver notice."
        guide = context + clause
        rows = [
            {"sourceId": "s2", "question": "Was notice delivered?", "searchTerms": ["receipt"]},
            {"sourceId": "s1", "sourceQuote": "File an appeal.", "occurrence": 2,
             "question": "Can the member file an appeal?", "searchTerms": ["appeal"]},
        ]
        plan, _ = self.plan("guide", guide, [(clause, len(context))], rows)
        self.assertEqual(plan[0]["start"], guide.rindex("File an appeal."))
        self.assertEqual(plan[1]["start"], len(context))

    def test_questionnaire_preserves_rows_order_and_source(self):
        questions = ["  Is coverage limited? ", "What are the exceptions?"]
        rows = [
            {"sourceId": "s2", "question": "Different question", "searchTerms": ["exception"]},
            {"sourceId": "s1", "searchTerms": ["Benefit cap", "benefit CAP", "maximum benefit"]},
        ]
        plan, _ = self.plan("questionnaire", questions, [(q.strip(), None) for q in questions], rows)
        self.assertEqual([p["question"] for p in plan], [q.strip() for q in questions])
        self.assertEqual([p["source"] for p in plan], questions)
        self.assertEqual(plan[0]["searchTerms"], ["Benefit cap", "maximum benefit"])
        self.assertIsNone(plan[0]["start"])

    def test_malformed_anchors_and_partial_coverage_trigger_fallback(self):
        clause = "Members must send notice and send notice again."
        other = "Plans must keep records."
        guide = clause + "\n" + other
        fallback = [(clause, 0), (other, len(clause) + 1)]
        good = {"sourceId": "s1", "question": "Do members send notice?", "searchTerms": ["notice"]}
        second = {"sourceId": "s2", "question": "Are records kept?", "searchTerms": ["records"]}
        cases = [
            [],
            [good],
            [good, good, second],
            [dict(good, sourceId="s9"), second],
            [dict(good, sourceQuote="unwritten obligation"), second],
            [dict(good, sourceQuote="send notice"), second],
            [dict(good, sourceQuote="send notice", occurrence=3), second],
            [dict(good, sourceQuote="send notice", occurrence=True), second],
            [dict(good, searchTerms=[]), second],
            [dict(good, searchTerms=[""] * 9), second],
            [dict(good, searchTerms=["a" * 81]), second],
            [dict(good, searchTerms=["some\nterm"]), second],
            [dict(good, searchTerms=[None]), second],
            [dict(good, question="  "), second],
        ]
        for rows in cases:
            with self.subTest(rows=rows), self.assertRaises(model.ProviderUnavailable):
                self.plan("guide", guide, fallback, rows)

    def test_duplicate_or_missing_questions_trigger_fallback(self):
        questions = ["Question one?", "Question two?"]
        first = {"sourceId": "s1", "searchTerms": ["one"]}
        for rows in ([first], [first, first]):
            with self.subTest(rows=rows), self.assertRaises(model.ProviderUnavailable):
                self.plan("questionnaire", questions, [(q, None) for q in questions], rows)

    def test_inexact_parser_offsets_prevent_model_call(self):
        with patch.object(model, "invoke_tool") as invoke:
            with self.assertRaises(model.ProviderUnavailable):
                planner.plan_criteria("guide", " A guide clause.", [("A guide clause.", 0)], "test-key", 100)
        invoke.assert_not_called()

    def test_guide_only_requires_a_model_plan_and_preserves_the_source_anchors(self):
        clause = "The operator shall retain the forms and publish the fees."
        questions = ["Does the operator retain the forms?", "Does the operator publish the fees?"]
        payload = {"mode": "guide", "guide": clause, "documents": [], "allowModel": True, "modelSharingConsent": True}
        proposed = {"criteria": [
            {"sourceId": "s1", "question": questions[0], "searchTerms": ["forms"]},
            {"sourceId": "s1", "question": questions[1], "searchTerms": ["fees"]},
        ]}
        with patch.dict(os.environ, {"ANTHROPIC_API_KEY": "test-key", "VERCEL": "1"}, clear=True):
            with patch.object(model, "invoke_tool", return_value=proposed) as invoke:
                result = api.review(payload)
                invoke.assert_called_once()
                self.assertEqual(invoke.call_args.args[1]["name"], "record_search_plan")
            self.assertEqual((result["planningEngine"], result["engine"]), ("anthropic", "anthropic"))
            self.assertEqual(result["notice"], "")
            self.assertEqual([row["question"] for row in result["findings"]], questions)
            for row in result["findings"]:
                self.assertEqual((row["criterionStart"], row["criterionEnd"], row["criterionSource"]), (0, len(clause), clause))
                self.assertEqual(row["status"], "needs_review")
                self.assertEqual(row["candidates"] + row["supporting"] + row["counter"] + row["searchProof"], [])
            with patch.object(model, "invoke_tool", side_effect=model.ProviderUnavailable) as invoke, \
                 self.assertRaisesRegex(model.ProviderUnavailable, "could not complete the search plan"):
                api.review(payload)
            invoke.assert_called_once()

    def test_guide_planner_reports_overflow_instead_of_returning_partial_extraction(self):
        guide = "1. The operator must keep records.\n2. The operator must approve filings."
        payload = {"mode": "guide", "guide": guide, "documents": [], "allowModel": True, "publicInputConsent": True}
        rows = [{"sourceId": "s2", "question": f"Does the operator retain form {i}?", "searchTerms": ["form"]}
                for i in range(MAX_CRITERIA + 1)]
        with patch.dict(os.environ, {"ANTHROPIC_API_KEY": "test-key", "VERCEL": "1"}, clear=True):
            for result in ({"exceedsLimit": True, "criteria": []}, {"criteria": rows}, {"criteria": rows[:MAX_CRITERIA]}):
                with self.subTest(count=len(result["criteria"])), patch.object(model, "invoke_tool", return_value=result) as invoke:
                    with self.assertRaisesRegex(InvalidRequest, "30 requirements"):
                        api.review(payload)
                    invoke.assert_called_once()

    def test_consented_hosted_inputs_in_both_modes_use_only_this_requests_evidence(self):
        clause = "The office must retain permit records for five years."
        question = "Does the office retain permit records for five years?"
        guide = "Records policy\n\n1. " + clause
        rule = "The office retains permit records for five years."
        exception = "The office retains temporary permit records for only one year."
        phrase = "permit records"
        never_matched = "archive vault"
        scope = {**dict.fromkeys(model.SCOPE_FIELDS, "same"), "population": "overlaps",
                 "eventComparison": "Both address retention after permit issuance.",
                 "dutyComparison": "Both cover the office's duty to retain permit records."}

        def simulate_tool(system, tool, inputs, key, deadline, max_tokens=3800):
            if tool["name"] == "record_search_plan":
                self.assertEqual(set(inputs), {"mode", "sources"})
                required = [unit for unit in inputs["sources"] if unit["required"]]
                self.assertEqual([unit["text"] for unit in required],
                                 [clause if inputs["mode"] == "guide" else question])
                return {"criteria": [{"sourceId": required[0]["sourceId"], "question": question,
                                      "searchTerms": [phrase, never_matched]}]}
            self.assertEqual(tool["name"], "record_review")
            row, = inputs
            self.assertEqual(row["criterion"], question)
            for passage in row["passages"]:
                self.assertEqual(set(passage), {"passage", "quote"})
            refs = {item["quote"]: item["passage"] for item in row["passages"]}
            self.assertEqual(set(refs), {rule, exception})
            return {"assessments": [{
                "id": row["id"], "answer": "Temporary permit records have a shorter retention period.",
                "status": "mixed", "supporting": [{"passage": refs[rule], "quote": rule}],
                "counter": [{"passage": refs[exception], "quote": exception, "scope": scope}],
            }]}

        with patch.dict(os.environ, {"ANTHROPIC_API_KEY": "test-key", "VERCEL": "1"}, clear=True), \
             patch.object(model, "invoke_tool", side_effect=simulate_tool) as invoke:
            for mode, source in (("questionnaire", {"questions": [question]}), ("guide", {"guide": guide})):
                for number in (4, 7, 7):
                    with self.subTest(mode=mode, number=number):
                        doc = {"id": f"policy-{number}", "title": "Office policy", "pages": [
                            {"number": number, "text": rule + "\n\n" + exception},
                            {"number": number + 1, "text": "Hours of operation are posted downstairs."},
                        ]}
                        payload = {"mode": mode, **source, "documents": [doc],
                                   "allowModel": True, "modelSharingConsent": True}
                        invoke.reset_mock()
                        result = api.review(payload)
                        self.assertEqual(invoke.call_count, 2)
                        self.assertEqual((result["planningEngine"], result["engine"]), ("anthropic", "anthropic"))
                        finding, = result["findings"]
                        self.assertEqual(finding["status"], "mixed")
                        self.assertEqual(finding["criterionSource"], question if mode == "questionnaire" else clause)
                        if mode == "guide":
                            self.assertEqual(guide[finding["criterionStart"]:finding["criterionEnd"]], clause)
                        for side, quote in (("supporting", rule), ("counter", exception)):
                            self.assertEqual(finding[side], [{
                                "documentId": doc["id"], "title": doc["title"], "page": number, "quote": quote,
                            }])
                        proof = {item["term"]: item for item in finding["searchProof"]}
                        self.assertEqual((proof[phrase]["origin"], proof[phrase]["totalHits"]), ("model", 2))
                        self.assertEqual(proof[never_matched]["totalHits"], 0)


if __name__ == "__main__":
    unittest.main()
