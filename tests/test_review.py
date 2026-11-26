import copy
import http.client
import json
import os
import threading
import unittest
from http.server import ThreadingHTTPServer
from unittest.mock import patch

from api import review as api
from api._review import model
from api._review.search import InvalidRequest, basic_plan, retrieve, validate


def sample(mode="questionnaire", **changes):
    data = copy.deepcopy(model.public_sample())
    data["mode"] = mode
    data.update(changes)
    return data


class ReviewTests(unittest.TestCase):
    def setUp(self):
        with model.CACHE_LOCK:
            model.PUBLIC_CACHE.clear()
            model.PUBLIC_IN_FLIGHT.clear()
            model.PUBLIC_RETRY_AFTER.clear()

    def test_first_question_retrieves_rule_and_conflict_without_claiming_compliance(self):
        result = api.review(sample())
        first = result["findings"][0]
        self.assertEqual((result["engine"], result["planningEngine"]), ("local", "local"))
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

    def test_validation_no_silent_truncation_or_duplicate_page_ids(self):
        for changes in (
            {"questions": ["Q"] * 31}, {"questions": [7]}, {"questions": ["x" * 2001]},
            {"guide": "\n".join(f"{i}. Employees must follow rule {i}." for i in range(1, 32)), "mode": "guide"},
            {"documents": [{"id": "x", "title": "x", "pages": [{"number": 1, "text": "yes"}] * 2}]},
            {"documents": [{"id": "x", "title": "x", "pages": [{"number": 1, "text": ""}]}]},
            {"allowModel": "false"},
        ):
            with self.subTest(changes=changes), self.assertRaises(InvalidRequest):
                api.review(sample(**changes))

    def test_hosted_custom_inputs_never_leave_runtime(self):
        with patch.dict(os.environ, {"ANTHROPIC_API_KEY": "test-key", "REVIEW_ALLOW_CUSTOM_MODEL": "1", "VERCEL": "1"}, clear=True):
            with patch.object(model, "invoke_tool", side_effect=AssertionError("Unexpected provider call")):
                data = sample(allowModel=True)
                data["documents"][0]["pages"][0]["text"] += " An uploaded private addition."
                self.assertEqual(api.review(data, local_operator=True)["engine"], "local")
                self.assertEqual(api.review(sample(questions=["Changed criterion"], allowModel=True))["engine"], "local")
                self.assertEqual(api.review(sample("guide", guide="A custom guide must be checked.", allowModel=True))["engine"], "local")

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
        raw["counter"] = [{"passage": conflict_id, "quote": refs[conflict_id]["quote"]}]
        self.assertEqual(model.verify(row, raw, refs, pages)["status"], "mixed")

    def test_no_key_returns_usable_evidence(self):
        with patch.dict(os.environ, {}, clear=True):
            result = api.review(sample(allowModel=True))
        self.assertEqual(result["engine"], "local")
        self.assertIn("not configured", result["notice"])
        self.assertTrue(result["findings"][0]["candidates"])

    def test_two_stage_review_runs_suggested_searches_and_caches_only_canonical_sample(self):
        calls = []

        def fake_tool(_system, tool, data, _key, max_tokens=3800):
            calls.append(tool["name"])
            if tool["name"] == "record_search_plan":
                return {"criteria": [{"sourceId": row["sourceId"], "searchTerms": ["verbal acknowledgment"]}
                                     for row in data["sources"]]}
            findings = []
            for row in data:
                self.assertEqual(row["criterionSource"], row["criterion"])
                findings.append({"id": row["id"], "answer": "Evidence needs review.", "status": "insufficient",
                                 "supporting": [], "counter": []})
            return {"assessments": findings}

        with patch.dict(os.environ, {"ANTHROPIC_API_KEY": "test-key"}, clear=True):
            with patch.object(model, "invoke_tool", side_effect=fake_tool):
                result = api.review(sample(allowModel=True))
                cached = api.review(sample(allowModel=True))
                custom = api.review(sample(allowModel=True, questions=["Does the plan use interpreters?"]))
        self.assertEqual(calls, ["record_search_plan", "record_review"])
        self.assertEqual((result["planningEngine"], result["engine"]), ("anthropic", "anthropic"))
        self.assertEqual(result["findings"][0]["searchProof"][0]["totalHits"], 1)
        self.assertEqual(cached["findings"], result["findings"])
        self.assertEqual(custom["engine"], "local")

    def test_provider_failure_still_returns_full_local_results(self):
        with patch.dict(os.environ, {"ANTHROPIC_API_KEY": "test-key"}, clear=True):
            with patch.object(model, "invoke_tool", side_effect=model.ProviderUnavailable) as provider:
                result = api.review(sample(allowModel=True))
                fallback = api.review(sample(allowModel=True))
        self.assertEqual(provider.call_count, 2)
        self.assertEqual(result["engine"], "local")
        self.assertEqual(result["planningEngine"], "local")
        self.assertEqual(len(result["findings"]), len(sample()["questions"]))
        self.assertIn("temporarily busy", fallback["notice"])

    def test_private_model_review_requires_loopback_opt_in_and_consent_together(self):
        private = sample(questions=["Are interpreters available?"], allowModel=True)
        with patch.dict(os.environ, {"ANTHROPIC_API_KEY": "test-key"}, clear=True):
            with patch.object(model, "invoke_tool", side_effect=model.ProviderUnavailable) as provider:
                api.review(private, local_operator=True)
                with patch.dict(os.environ, {"REVIEW_ALLOW_CUSTOM_MODEL": "1"}):
                    api.review(private)
                    api.review({**private, "allowModel": False}, local_operator=True)
                    provider.assert_not_called()
                    result = api.review(private, local_operator=True)
                    self.assertEqual(result["engine"], "local")
                    self.assertEqual(provider.call_count, 2)
                    self.assertEqual(model.PUBLIC_CACHE, {})

    def test_duplicate_or_omitted_provider_rows_remain_local(self):
        payload = sample()
        _, criteria, pages = validate(payload)
        rows = retrieve(pages, basic_plan(criteria))
        raw = {"id": "q1", "status": "insufficient", "answer": "Gap.", "supporting": [], "counter": []}
        with patch.object(model, "call_provider", return_value=[raw, raw, {**raw, "id": "q2"}]):
            result = model.assess_batch(rows, pages, "test-key")
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
