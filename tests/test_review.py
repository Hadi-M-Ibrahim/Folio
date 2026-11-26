import http.client
import json
import os
import threading
import unittest
from http.server import ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch

from api import review as api
from api._review import model
from api._review.search import InvalidRequest, basic_plan, retrieve, validate


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

    def test_opted_in_search_with_no_matches_skips_assessment_and_reports_negative_evidence(self):
        payload = sample(questions=["Xylophones?"], allowModel=True, publicInputConsent=True)
        plan = {"criteria": [{"sourceId": "s1", "searchTerms": ["xylophones"]}]}
        with patch.dict(os.environ, {"ANTHROPIC_API_KEY": "test-key", "VERCEL": "1"}, clear=True), \
             patch.object(model, "invoke_tool", return_value=plan) as invoke:
            result = api.review(payload)
        invoke.assert_called_once()
        finding, = result["findings"]
        self.assertEqual(result["planningEngine"], "anthropic")
        self.assertIn("No policy passages", result["notice"])
        self.assertEqual((finding["analysisEngine"], finding["status"]), ("local", "insufficient"))
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
            {"allowModel": "false"}, {"publicInputConsent": "true"}, {"publicInputConsent": 1},
        ):
            with self.subTest(changes=changes), self.assertRaises(InvalidRequest):
                api.review(sample(**changes))

    def test_hosted_model_review_requires_both_opt_ins_even_with_local_operator_flag(self):
        with patch.dict(os.environ, {"ANTHROPIC_API_KEY": "test-key", "REVIEW_ALLOW_CUSTOM_MODEL": "1", "VERCEL": "1"}, clear=True):
            with patch.object(model, "invoke_tool", side_effect=AssertionError("Unexpected provider call")):
                for mode in ("guide", "questionnaire"):
                    for flags in ({}, {"allowModel": True}, {"publicInputConsent": True},
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

    def test_no_key_returns_usable_evidence(self):
        with patch.dict(os.environ, {"VERCEL": "1"}, clear=True):
            result = api.review(sample(allowModel=True, publicInputConsent=True))
        self.assertEqual(result["engine"], "local")
        self.assertIn("not configured", result["notice"])
        self.assertTrue(result["findings"][0]["candidates"])

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

    def test_provider_failure_still_returns_full_local_results(self):
        with patch.dict(os.environ, {"ANTHROPIC_API_KEY": "test-key", "VERCEL": "1"}, clear=True):
            with patch.object(model, "invoke_tool", side_effect=model.ProviderUnavailable) as provider:
                result = api.review(sample(allowModel=True, publicInputConsent=True))
        self.assertEqual(provider.call_count, 2)
        self.assertEqual(result["engine"], "local")
        self.assertEqual(result["planningEngine"], "local")
        self.assertEqual(len(result["findings"]), len(sample()["questions"]))
        self.assertIn("could not complete", result["notice"])

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

    def test_private_model_review_requires_loopback_opt_in_and_consent_together(self):
        private = sample(questions=["Are urgent grievances escalated?"], allowModel=True)
        with patch.dict(os.environ, {"ANTHROPIC_API_KEY": "test-key"}, clear=True):
            with patch.object(model, "invoke_tool", side_effect=model.ProviderUnavailable) as provider:
                api.review({**private, "publicInputConsent": True}, local_operator=True)
                with patch.dict(os.environ, {"REVIEW_ALLOW_CUSTOM_MODEL": "1"}):
                    api.review({**private, "publicInputConsent": True})
                    api.review({**private, "allowModel": False}, local_operator=True)
                    provider.assert_not_called()
                    result = api.review(private, local_operator=True)
                    self.assertEqual(result["engine"], "local")
                    self.assertEqual(provider.call_count, 2)

    def test_provider_call_cannot_start_after_deadline_and_uses_remaining_budget(self):
        with patch.object(model.time, "monotonic", return_value=100), patch.object(model.request, "urlopen") as send:
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


class HttpContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), api.handler)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join()

    def request(self, method, path, body, mime="application/json"):
        conn = http.client.HTTPConnection(*self.server.server_address, timeout=3)
        try:
            conn.request(method, path, body, {"Content-Type": mime})
            r = conn.getresponse()
            return r.status, json.loads(r.read())
        finally:
            conn.close()

    def test_http_entry_point_and_errors(self):
        self.assertEqual(self.request("POST", "/api/review", json.dumps(sample()))[0], 200)
        self.assertEqual(self.request("POST", "/api/review", "{")[0], 400)
        self.assertEqual(self.request("POST", "/api/review", "{}")[0], 422)
        self.assertEqual(self.request("POST", "/api/review", "{}", "text/plain")[0], 415)
        self.assertEqual(self.request("GET", "/api/review", None)[0], 405)
        self.assertEqual(self.request("POST", "/nonexistent", "{}")[0], 404)

    def test_http_size_limit_and_no_store_apply_before_body_read(self):
        conn = http.client.HTTPConnection(*self.server.server_address, timeout=3)
        try:
            conn.request("POST", "/api/review", headers={
                "Content-Type": "application/json", "Content-Length": str(api.MAX_BODY + 1),
            })
            response = conn.getresponse()
            self.assertEqual(response.status, 413)
            self.assertEqual(response.getheader("Cache-Control"), "no-store")
        finally:
            conn.close()
