import io
import json
import os
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from api import review as api
from api._review import model
from api._review.search import (
    MAX_PAGE_NUMBER,
    InvalidRequest,
    ReviewPartTooLarge,
    basic_plan,
    retrieve,
    validate,
)
from api._review.sessions import ReviewCancelled


def sample(mode="questionnaire", **changes):
    data = json.loads((Path(__file__).parent / "fixtures" / "review.json").read_text(encoding="utf-8"))
    data["mode"] = mode
    data.update(changes)
    return data


def insufficient_assessments(*ids):
    return {"assessments": [{"id": item_id, "status": "insufficient", "answer": "Insufficient evidence.",
                             "supporting": [], "counter": []} for item_id in ids]}


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

    def test_guide_requires_a_policy_before_model_work(self):
        guide = sample("guide", documents=[], allowModel=True, modelSharingConsent=True)
        with patch.object(api, "model_review") as review_model:
            for flags in ({}, {"allowModel": False}, {"documentPart": True}):
                with self.subTest(flags=flags), self.assertRaisesRegex(InvalidRequest, "at least one existing policy"):
                    api.review({**guide, **flags})
            review_model.assert_not_called()

    def test_large_local_guide_keeps_every_clause_and_its_source_location(self):
        clauses = [f"The operator must retain record {i}." for i in range(63)]
        guide = "\n".join(f"{i}. {clause}" for i, clause in enumerate(clauses, 1))
        result = api.review(sample("guide", guide=guide))
        self.assertEqual([row["criterionSource"] for row in result["findings"]], clauses)
        self.assertFalse(result["criterionLimitReached"])
        for row in result["findings"]:
            self.assertEqual(guide[row["criterionStart"]:row["criterionEnd"]], row["criterionSource"])

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
            {"questions": []}, {"questions": [7]}, {"questions": [" "]},
            {"documents": []}, {"mode": "guide", "guide": " "},
            {"mode": "guide", "guide": "1. ..."}, {"mode": "guide", "guide": None},
            {"mode": "guide", "documents": None},
            {"documents": [{"id": "x", "title": "x", "pages": [{"number": 1, "text": "yes"}] * 2}]},
            {"documents": [{"id": "x", "title": "x", "pages": [{"number": 1, "text": ""}]}]},
            {"documentPart": 1}, {"transcribeSourceOnly": "yes"}, {"requireComplete": "yes"}, {"transcribeSourceOnly": True}, {"allowModel": "false"}, {"modelSharingConsent": 1}, {"publicInputConsent": "true"}, {"publicInputConsent": 1},
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

    def test_document_parts_fail_on_incomplete_assessments_and_offer_splitting_for_expired_budget(self):
        questions = ["Which records apply?", "Who approves the records?"]
        plan = {"criteria": [{"sourceId": f"s{n}", "searchTerms": ["records"]} for n in (1, 2)]}
        one_row = {"assessments": [{"id": "q1", "answer": "Review needed.", "status": "needs_review",
                                   "supporting": [], "counter": []}]}
        payload = sample(questions=questions, allowModel=True, modelSharingConsent=True, documentPart=True)
        with patch.dict(os.environ, {"VERCEL": "1", "ANTHROPIC_API_KEY": "test-key"}, clear=True):
            with patch.object(model, "invoke_tool", side_effect=[plan, one_row, one_row]) as invoke, \
                 self.assertRaises(ReviewPartTooLarge):
                api.review(payload)
            self.assertEqual([row["id"] for row in invoke.call_args.args[2]], ["q2"])
            with patch.object(model, "invoke_tool", side_effect=[plan, model.ProviderUnavailable]) as invoke, \
                 self.assertRaisesRegex(model.ProviderUnavailable, "could not complete the assessment"):
                api.review(payload)
            self.assertEqual(invoke.call_count, 2)
            with patch.object(model, "invoke_tool", side_effect=[plan, model.OutputTruncated]), \
                 self.assertRaises(ReviewPartTooLarge):
                api.review(payload)
            for flags in ({"requireComplete": True, "documentPart": False}, {"documentPart": True}):
                for responses in ([plan, model.DeadlineExceeded], [model.DeadlineExceeded]):
                    with patch.object(model, "invoke_tool", side_effect=responses), self.assertRaises(ReviewPartTooLarge):
                        api.review({**payload, **flags})
            with patch.object(model, "invoke_tool", side_effect=model.ProviderUnavailable), \
                 self.assertRaisesRegex(model.ProviderUnavailable, "could not complete the search plan"):
                api.review({**payload, "requireComplete": True, "documentPart": False})

    def test_direct_large_questionnaire_returns_every_assessed_prompt_with_verified_policy_citations(self):
        long_prompt = "Does the office keep records " + "for every listed case " * 135 + "after renewal?"
        questions = [f"Who keeps the records for renewal {i}?" for i in range(38)] + [long_prompt]
        quote = "The office keeps the renewal records."
        payload = sample(questions=questions, allowModel=True, modelSharingConsent=True, documentPart=True,
                         documents=[{"id": "r", "title": "Policy", "pages": [{"number": 7, "text": quote}]}])
        def simulate(system, tool, inputs, key, deadline, max_tokens=3800):
            if tool["name"] == "record_search_plan":
                return {"criteria": [{"sourceId": unit["sourceId"], "searchTerms": ["records"]}
                                     for unit in inputs["sources"]]}
            return {"assessments": [
                {"id": row["id"], "answer": quote, "status": "supported",
                 "supporting": [{"passage": row["passages"][0]["passage"], "quote": quote}], "counter": []}
                for row in inputs
            ]}
        with patch.dict(os.environ, {"VERCEL": "1", "ANTHROPIC_API_KEY": "test-key"}, clear=True), \
             patch.object(model, "invoke_tool", side_effect=simulate) as invoke:
            result = api.review(payload)
        rows = result["findings"]
        self.assertEqual(result["reviewScope"], {"criteria": len(questions), "documents": 1, "pages": 1})
        self.assertEqual([row["question"] for row in rows], questions)
        self.assertEqual([row["id"] for row in rows], [f"q{n}" for n in range(1, 40)])
        self.assertTrue(all(row["analysisEngine"] == "anthropic" and row["supporting"][0]["page"] == 7 for row in rows))
        self.assertEqual(invoke.call_args.args[2][-1]["criterion"], long_prompt)
        self.assertEqual(len({call.args[4] for call in invoke.call_args_list}), 1)

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

    def test_required_assessment_repairs_only_unverified_rows_and_keeps_their_original_ids(self):
        _, criteria, pages = validate(sample())
        findings = retrieve(pages, basic_plan(criteria))
        initial = insufficient_assessments("q5", "q1", "q2", "q2", "q3")
        initial["assessments"][4]["supporting"] = "malformed"
        initial["assessments"][1]["answer"] = "Verified during the initial pass."
        initial["assessments"][1]["status"] = "needs_review"
        initial["assessments"][1]["supporting"] = [{"passage": "p1", "quote": findings[0]["candidates"][0]["quote"]}]
        pdfs = [{"title": "Questionnaire", "role": "source", "documentId": "source", "pages": [1], "data": "JVBERg=="}]
        repair = insufficient_assessments("q4", "q2", "q3")
        with patch.object(model, "invoke_tool", side_effect=[initial, repair]) as invoke:
            result, notice = model.assess_findings(findings, pages, "test-key", 100,
                                                  attachments=pdfs, require_complete=True)
        self.assertEqual([row["id"] for row in invoke.call_args.args[2]], ["q2", "q3", "q4"])
        self.assertTrue(all(call.kwargs["attachments"] == pdfs and call.args[4] == 100
                            for call in invoke.call_args_list))
        self.assertEqual(notice, "")
        self.assertEqual([row["id"] for row in result], [row["id"] for row in findings])
        self.assertTrue(all(row["analysisEngine"] == "anthropic" for row in result))
        self.assertEqual(result[0]["answer"], "Verified during the initial pass.")
        self.assertEqual(result[0]["supporting"], [findings[0]["candidates"][0]])

    def test_required_singleton_assessment_retries_a_missing_tool_or_malformed_payload_once(self):
        _, criteria, pages = validate(sample(questions=["Who records the inspections?"]))
        finding = retrieve(pages, basic_plan(criteria))
        for invalid in (model.MissingToolCall, {"assessments": "invalid"}):
            with self.subTest(invalid=invalid):
                with patch.object(model, "invoke_tool", side_effect=[invalid, insufficient_assessments("q1")]) as invoke:
                    rows, _ = model.assess_findings(finding, pages, "test-key", 100, require_complete=True)
                self.assertEqual(invoke.call_count, 2)
                self.assertEqual(rows[0]["analysisEngine"], "anthropic")
                with patch.object(model, "invoke_tool", side_effect=[invalid, invalid]) as invoke, \
                     self.assertRaisesRegex(model.ProviderUnavailable, "could not complete the assessment"):
                    model.assess_findings(finding, pages, "test-key", 100, require_complete=True)
                self.assertEqual(invoke.call_count, 2)

    def test_cancelling_before_assessment_repair_prevents_a_second_provider_request(self):
        _, criteria, pages = validate(sample(questions=["Who records the inspections?"]))
        finding = retrieve(pages, basic_plan(criteria))
        message = {"stop_reason": "tool_use", "content": [{"type": "tool_use", "name": "record_review",
                                                           "input": {"assessments": []}}]}
        with patch.object(model, "check_session", side_effect=[None, ReviewCancelled]), \
             patch.object(model, "open_provider_request", return_value=io.BytesIO(json.dumps(message).encode())) as send, \
             self.assertRaises(ReviewCancelled):
            model.assess_findings(finding, pages, "test-key", time.monotonic() + 70, require_complete=True)
        self.assertEqual(send.call_count, 1)
