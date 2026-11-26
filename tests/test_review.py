import json
import os
import unittest
from pathlib import Path
from unittest.mock import patch

from api import review as api
from api._review import model
from api._review.search import (
    MAX_PAGE_NUMBER,
    InvalidRequest,
    basic_plan,
    retrieve,
    validate,
)


def sample(mode="questionnaire", **changes):
    data = json.loads((Path(__file__).parent / "fixtures" / "review.json").read_text(encoding="utf-8"))
    data["mode"] = mode
    data.update(changes)
    return data


class ReviewTests(unittest.TestCase):
    def test_first_question_retrieves_rule_and_conflict_without_claiming_compliance(self):
        result = api.review(sample())
        first = result["findings"][0]
        self.assertEqual((result["engine"], result["planningEngine"]), ("local", "local"))
        self.assertFalse(result["criterionLimitReached"])
        self.assertEqual(first["status"], "needs_review")
        texts = [c["quote"] for c in first["candidates"]]
        self.assertTrue(any("five business days" in s for s in texts))
        self.assertTrue(any("verbal acknowledgment only" in s for s in texts))
        self.assertEqual(first["supporting"], [])
        self.assertEqual(first["counter"], [])
        self.assertEqual(result, api.review(sample()))

    def test_guide_provenance_survives_repeated_clauses_and_leading_spaces(self):
        clause = "The plan must publish a notice."
        guide = "  Sample rules\n\n1. " + clause + "\n\n2. " + clause
        result = api.review(sample("guide", guide=guide))
        rows = result["findings"]
        self.assertEqual(len(rows), 2)
        self.assertNotEqual(rows[0]["criterionStart"], rows[1]["criterionStart"])
        for f in rows:
            self.assertEqual(guide[f["criterionStart"]:f["criterionEnd"]], clause)

    def test_guide_only_returns_sourced_unassessed_criteria_without_provider_calls(self):
        clauses = ["The office must keep renewal notices.", "The director shall sign renewals."]
        guide = "  Renewals\n\n1. " + clauses[0] + "\n\n2. " + clauses[1]
        with patch.dict(os.environ, {"ANTHROPIC_API_KEY": "test-key", "VERCEL": "1"}, clear=True), \
             patch.object(model, "invoke_tool") as invoke:
            for flags in ({}, {"allowModel": True}):
                with self.subTest(flags=flags):
                    result = api.review({"mode": "guide", "guide": guide, "documents": [], **flags})
                    self.assertEqual(result["reviewScope"], {"documents": 0, "pages": 0, "criteria": 2})
                    self.assertEqual((result["engine"], result["planningEngine"]), ("local", "local"))
                    self.assertIn("No policies", result["notice"])
                    for index, row in enumerate(result["findings"]):
                        clause = clauses[index]
                        self.assertEqual(row["criterionSource"], clause)
                        self.assertEqual(guide[row["criterionStart"]:row["criterionEnd"]], clause)
                        self.assertEqual((row["status"], row["analysisEngine"]), ("needs_review", "local"))
                        for field in ("supporting", "counter", "candidates", "searchTerms", "searchProof"):
                            self.assertEqual(row[field], [])
                        self.assertEqual(row["totalSearchTerms"], 0)
        invoke.assert_not_called()

    def test_guide_at_the_limit_keeps_every_clause_and_discloses_the_cap(self):
        clauses = [f"The operator must retain record {i}." for i in range(30)]
        guide = "\n".join(f"{i}. {clause}" for i, clause in enumerate(clauses, 1))
        result = api.review({"mode": "guide", "guide": guide, "documents": []})
        self.assertEqual([row["criterionSource"] for row in result["findings"]], clauses)
        self.assertIn("30-criterion limit", result["notice"])
        self.assertTrue(result["criterionLimitReached"])

    def test_new_model_phrase_is_actually_searched_and_ranked(self):
        data = sample(questions=["Is the protocol documented?"], documents=[{
            "id": "doc", "title": "Operating guide", "pages": [
                {"number": 1, "text": "The protocol documents a standard workflow."},
                {"number": 8, "text": "Escalation window: five days. Escalation\nwindow for appeals: one day."},
            ],
        }])
        _, criteria, pages = validate(data)
        plan = basic_plan(criteria)
        plan[0]["searchTerms"] = ["escalation window", "two business days"]
        f = retrieve(pages, plan)[0]
        log = {r["term"]: r for r in f["searchProof"]}
        self.assertEqual(log["escalation window"]["matches"], [{"documentId": "doc", "page": 8, "count": 2}])
        self.assertEqual(log["escalation window"]["origin"], "model")
        self.assertEqual(log["two business days"]["totalHits"], 0)
        self.assertEqual(f["candidates"][0]["page"], 8)

    def test_no_hits_and_no_unsupported_inference(self):
        row = api.review(sample(questions=["Xylophones?"]))["findings"][0]
        self.assertEqual(row["status"], "insufficient")
        self.assertEqual(row["candidates"], [])
        self.assertEqual(row["searchProof"][0]["totalHits"], 0)

    def test_consented_review_with_no_matches_assesses_empty_evidence(self):
        payload = sample(questions=["Xylophones?"], allowModel=True, modelSharingConsent=True)
        plan = {"criteria": [{"sourceId": "s1", "searchTerms": ["xylophones"]}]}
        assessment = {"assessments": [{"id": "q1", "status": "insufficient", "answer": "A claim without sources.",
                                       "supporting": [], "counter": []}]}
        with patch.dict(os.environ, {"ANTHROPIC_API_KEY": "test-key", "VERCEL": "1"}, clear=True), \
             patch.object(model, "invoke_tool", side_effect=[plan, assessment]) as invoke:
            result = api.review(payload)
        self.assertEqual(invoke.call_count, 2)
        self.assertEqual(invoke.call_args.args[1]["name"], "record_review")
        self.assertEqual(invoke.call_args.args[2][0]["passages"], [])
        finding, = result["findings"]
        self.assertEqual((result["engine"], result["notice"]), ("anthropic", ""))
        self.assertIn("no source passages", finding["answer"])
        self.assertEqual((finding["analysisEngine"], finding["status"]), ("anthropic", "insufficient"))
        self.assertEqual(finding["searchProof"][0]["totalHits"], 0)

    def test_validation_no_silent_truncation_or_duplicate_page_ids(self):
        for changes in (
            {"questions": ["Q"] * 31}, {"questions": [7]}, {"questions": ["x" * 2001]},
            {"documents": []}, {"mode": "guide", "guide": " ", "documents": []},
            {"mode": "guide", "guide": "1. ...", "documents": []}, {"mode": "guide", "guide": None, "documents": []},
            {"mode": "guide", "documents": None},
            {"guide": "\n".join(f"{i}. Employees must follow rule {i}." for i in range(1, 32)), "mode": "guide"},
            {"documents": [{"id": "x", "title": "x", "pages": [{"number": 1, "text": "yes"}] * 2}]},
            {"documents": [{"id": "x", "title": "x", "pages": [{"number": 1, "text": ""}]}]},
            {"allowModel": "false"}, {"modelSharingConsent": 1}, {"publicInputConsent": "true"}, {"publicInputConsent": 1},
        ):
            with self.subTest(changes=changes), self.assertRaises(InvalidRequest):
                api.review(sample(**changes))

    def test_citation_page_numbers_are_exact_in_the_browser(self):
        page = {"number": MAX_PAGE_NUMBER, "text": "The office keeps records."}
        payload = sample(questions=["Who keeps records?"], documents=[{"id": "d", "title": "Policy", "pages": [page]}])
        self.assertEqual(api.review(payload)["findings"][0]["candidates"][0]["page"], MAX_PAGE_NUMBER)
        page["number"] += 1
        with self.assertRaisesRegex(InvalidRequest, "integer page number"):
            api.review(payload)

    def test_hosted_model_review_requires_both_opt_ins_even_with_local_operator_flag(self):
        with patch.dict(os.environ, {"ANTHROPIC_API_KEY": "test-key", "REVIEW_ALLOW_CUSTOM_MODEL": "1", "VERCEL": "1"}, clear=True):
            with patch.object(model, "invoke_tool", side_effect=AssertionError("Unexpected provider call")):
                for mode in ("guide", "questionnaire"):
                    for flags in ({}, {"allowModel": True}, {"publicInputConsent": True}, {"modelSharingConsent": True},
                                  {"allowModel": True, "publicInputConsent": True, "modelSharingConsent": False},
                                  {"allowModel": False, "publicInputConsent": True},
                                  {"allowModel": True, "publicInputConsent": False}):
                        with self.subTest(mode=mode, flags=flags):
                            result = api.review(sample(mode, **flags), local_operator=True)
                            self.assertEqual((result["planningEngine"], result["engine"]), ("local", "local"))
                            self.assertTrue(result["findings"])

    def test_verifier_downgrades_fabrication_wrong_polarity_and_wrong_passage(self):
        data = sample()
        _, criteria, pages = validate(data)
        row = retrieve(pages, basic_plan(criteria))[0]
        refs = {f"p{i}": c for i, c in enumerate(row["candidates"], 1)}
        correct = {"passage": "p1", "quote": refs["p1"]["quote"]}
        raw = {"id": row["id"], "answer": "The policy makes this explicit.", "status": "supported", "counter": []}
        for cite in ({"passage": "p1", "quote": "A fabricated policy sentence."},
                     {"passage": "p99", "quote": correct["quote"]}, None):
            proposed = {**raw, "supporting": [] if cite is None else [cite]}
            checked = model.verify(row, proposed, refs, pages)
            self.assertEqual(checked["status"], "needs_review")
            self.assertEqual(checked["supporting"], [])
        raw["supporting"] = [correct]
        self.assertEqual(model.verify(row, raw, refs, pages)["status"], "supported")
        raw["counter"] = [correct]
        self.assertEqual(model.verify(row, raw, refs, pages)["status"], "needs_review")
        conflict_id = next(i for i, e in refs.items() if "verbal acknowledgment only" in e["quote"])
        scope = {**dict.fromkeys(model.SCOPE_FIELDS, "same"), "population": "overlaps",
                 "eventComparison": "Both address acknowledgment of a grievance on receipt.",
                 "dutyComparison": "Both address the staff obligation to acknowledge the grievance."}
        raw["counter"] = [{"passage": conflict_id, "quote": refs[conflict_id]["quote"], "scope": scope}]
        self.assertEqual(model.verify(row, raw, refs, pages)["status"], "mixed")

    def test_a_consented_review_requires_a_server_key(self):
        with patch.dict(os.environ, {"VERCEL": "1"}, clear=True), \
             self.assertRaisesRegex(model.ProviderUnavailable, "missing its Anthropic API key"):
            api.review(sample(allowModel=True, modelSharingConsent=True))

    def test_verifier_rejects_neighboring_workflow_stage_as_counterevidence(self):
        data = sample(questions=["Does the agency send an approval letter when the permit is issued?"],
                      documents=[{"id": "permit", "title": "Permit policy", "pages": [{"number": 1, "text":
                          "The agency sends an approval letter when a permit is issued.\n\n"
                          "The agency does not send a letter acknowledging receipt of a permit application."}]}])
        _, criteria, pages = validate(data)
        row = retrieve(pages, basic_plan(criteria))[0]
        refs = {f"p{i}": c for i, c in enumerate(row["candidates"], 1)}
        support_id = next(i for i, e in refs.items() if "permit is issued" in e["quote"])
        other_id = next(i for i, e in refs.items() if "acknowledging receipt" in e["quote"])
        scope = {"actor": "same", "population": "same", "event": "different", "duty": "different",
                 "eventComparison": "Permit issuance versus application receipt.",
                 "dutyComparison": "Sending the decision versus acknowledging arrival."}
        raw = {"status": "mixed", "answer": "The letters appear to conflict.",
               "supporting": [{"passage": support_id, "quote": refs[support_id]["quote"]}],
               "counter": [{"passage": other_id, "quote": refs[other_id]["quote"], "scope": scope}]}
        checked = model.verify(row, raw, refs, pages)
        self.assertEqual(checked["status"], "needs_review")
        self.assertEqual(len(checked["supporting"]), 1)
        self.assertEqual(checked["counter"], [])

    def test_provider_failure_attempts_assessment_with_local_terms_then_reports_failure(self):
        with patch.dict(os.environ, {"ANTHROPIC_API_KEY": "test-key", "VERCEL": "1"}, clear=True):
            with patch.object(model, "invoke_tool", side_effect=model.ProviderUnavailable) as provider:
                with self.assertRaisesRegex(model.ProviderUnavailable, "could not complete the assessment"):
                    api.review(sample(allowModel=True, modelSharingConsent=True))
        self.assertEqual(provider.call_count, 2)

    def test_model_assessment_can_succeed_after_planner_failure(self):
        question = "Who records the inspections?"
        quote = "The office records the inspections."
        payload = sample(questions=[question], allowModel=True, modelSharingConsent=True, documents=[
            {"id": "office", "title": "Office policy", "pages": [{"number": 2, "text": quote}]},
        ])
        assessment = {"assessments": [{"id": "q1", "status": "supported", "answer": "The office.",
                                       "supporting": [{"passage": "p1", "quote": quote}], "counter": []}]}
        with patch.dict(os.environ, {"ANTHROPIC_API_KEY": "test-key"}, clear=True), \
             patch.object(model, "invoke_tool", side_effect=[model.ProviderUnavailable, assessment]):
            result = api.review(payload, local_operator=True)
        self.assertEqual((result["engine"], result["planningEngine"]), ("anthropic", "local"))
        self.assertIn("planner was unavailable", result["notice"])
        self.assertEqual(result["findings"][0]["supporting"][0]["page"], 2)

    def test_interrupted_assessment_keeps_completed_batch_and_all_remaining_criteria(self):
        questions = [f"What does procedure {n} require?" for n in range(12)]
        plan = {"criteria": [{"sourceId": f"s{n + 1}", "searchTerms": ["procedure"]} for n in range(len(questions))]}
        batch = {"assessments": [
            {"id": f"q{n + 1}", "answer": "Insufficient evidence.", "status": "insufficient",
             "supporting": [], "counter": []} for n in range(model.BATCH_SIZE)
        ]}
        with patch.dict(os.environ, {"ANTHROPIC_API_KEY": "test-key", "VERCEL": "1"}, clear=True), \
             patch.object(model, "invoke_tool", side_effect=[plan, batch, model.ProviderUnavailable]) as invoke:
            result = api.review(sample(questions=questions, allowModel=True, publicInputConsent=True))
        self.assertEqual(invoke.call_count, 3)
        self.assertEqual(len({call.args[4] for call in invoke.call_args_list}), 1)
        self.assertEqual([row["question"] for row in result["findings"]], questions)
        self.assertEqual([row["analysisEngine"] for row in result["findings"]],
                         ["anthropic"] * model.BATCH_SIZE + ["local"] * (len(questions) - model.BATCH_SIZE))
        self.assertIn(f"assessed {model.BATCH_SIZE} of {len(questions)}", result["notice"])

    def test_loopback_key_enables_only_consented_reviews(self):
        private = sample(questions=["Are urgent grievances escalated?"], allowModel=True)
        with patch.dict(os.environ, {"ANTHROPIC_API_KEY": "test-key"}, clear=True):
            plan = {"criteria": [{"sourceId": "s1", "searchTerms": ["escalated"]}]}
            assessment = {"assessments": [{"id": "q1", "status": "insufficient", "answer": "Unclear.",
                                           "supporting": [], "counter": []}]}
            with patch.object(model, "invoke_tool", side_effect=[plan, assessment]) as provider:
                consented = {**private, "modelSharingConsent": True}
                with self.assertRaisesRegex(model.ProviderUnavailable, "loopback development server"):
                    api.review(consented)
                for flags in ({}, {"allowModel": False, "modelSharingConsent": True}, {"modelSharingConsent": False},
                              {"modelSharingConsent": False, "publicInputConsent": True}):
                    self.assertEqual(api.review({**private, **flags}, local_operator=True)["engine"], "local")
                provider.assert_not_called()
                result = api.review(consented, local_operator=True)
                self.assertEqual((result["planningEngine"], result["engine"]), ("anthropic", "anthropic"))
                self.assertEqual(provider.call_count, 2)

    def test_provider_call_cannot_start_after_deadline_and_uses_remaining_budget(self):
        with patch.object(model.time, "monotonic", return_value=100), patch.object(model, "open_provider_request") as send:
            send.side_effect = TimeoutError
            for deadline in (99, 100, 107, 1000):
                with self.subTest(deadline=deadline), self.assertRaises(model.ProviderUnavailable):
                    model.invoke_tool("", model.TOOL, [], "test-key", deadline)
        self.assertEqual([call.kwargs["timeout"] for call in send.call_args_list], [7, model.CALL_SECONDS])

    def test_duplicate_or_omitted_provider_rows_remain_local(self):
        payload = sample()
        _, criteria, pages = validate(payload)
        rows = retrieve(pages, basic_plan(criteria))
        raw = {"id": "q1", "status": "insufficient", "answer": "Gap.", "supporting": [], "counter": []}
        with patch.object(model, "call_provider", return_value=[raw, raw, {**raw, "id": "q2"}]):
            result = model.assess_batch(rows, pages, "test-key", 100)
        self.assertEqual([f["analysisEngine"] for f in result], ["local", "anthropic", "local", "local", "local"])
