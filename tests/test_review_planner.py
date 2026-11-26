import os
import unittest
from unittest.mock import patch

from api import review as api
from api._review import model, planner
from api._review.search import MAX_CRITERIA


class PlannerTests(unittest.TestCase):
    def plan(self, mode, source, fallback, rows):
        with patch.object(model, "invoke_tool", return_value={"criteria": rows}) as invoke:
            plan = planner.plan_criteria(mode, source, fallback, "test-key")
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
            [good] * (MAX_CRITERIA + 1),
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
                planner.plan_criteria("guide", " A guide clause.", [("A guide clause.", 0)], "test-key")
        invoke.assert_not_called()

    def test_authorized_sample_plans_searches_and_reuses_verified_cache(self):
        payload = {**model.public_sample(), "mode": "questionnaire", "allowModel": True}
        term = "verbal acknowledgment only"

        def simulate_tool(system, tool, inputs, key, max_tokens=3800):
            if tool["name"] == "record_search_plan":
                self.assertEqual(set(inputs), {"mode", "sources"})
                return {"criteria": [
                    {"sourceId": unit["sourceId"], "searchTerms": [term]} for unit in inputs["sources"]
                ]}
            self.assertEqual(tool["name"], "record_review")
            return {"assessments": [
                {"id": row["id"], "answer": "Evidence is insufficient.", "status": "insufficient",
                 "supporting": [], "counter": []}
                for row in inputs
            ]}

        with patch.dict(os.environ, {"ANTHROPIC_API_KEY": "test-key", "VERCEL": "1"}, clear=True), \
             patch.dict(model.PUBLIC_CACHE, {}, clear=True), patch.dict(model.PUBLIC_RETRY_AFTER, {}, clear=True), \
             patch.object(model, "invoke_tool", side_effect=simulate_tool) as invoke:
            result = api.review(payload)
            self.assertEqual((result["planningEngine"], result["engine"]), ("anthropic", "anthropic"))
            hit = next(proof for proof in result["findings"][0]["searchProof"] if proof["term"] == term)
            self.assertEqual(hit["origin"], "model")
            self.assertGreaterEqual(hit["totalHits"], 1)
            calls = invoke.call_count
            self.assertGreaterEqual(calls, 2)
            self.assertEqual(api.review(payload)["findings"], result["findings"])
            self.assertEqual(invoke.call_count, calls)


if __name__ == "__main__":
    unittest.main()
