import io
import json
import os
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import patch

from api import review as api
from api._review import model
from api._review.search import InvalidRequest


def questionnaire(label):
    return {
        "mode": "questionnaire", "allowModel": True, "modelSharingConsent": True,
        "questions": [f"Who keeps the {label} register?"],
        "documents": [{"id": label, "title": label, "pages": [
            {"number": 4, "text": f"The {label} clerk keeps the register."},
        ]}],
    }


GUIDE = {
    "mode": "guide", "guide": "The office must keep a register.", "documents": [],
    "allowModel": True, "modelSharingConsent": True,
}


def tool_response(name, data, *, stop_reason="tool_use"):
    return io.BytesIO(json.dumps({
        "stop_reason": stop_reason,
        "content": [{"type": "tool_use", "name": name, "input": data}],
    }).encode())


class ConcurrentReviewTests(unittest.TestCase):
    def setUp(self):
        self.enterContext(patch.dict(os.environ, {"VERCEL": "1", "ANTHROPIC_API_KEY": "test-key"}, clear=True))

    def test_provider_transport_refuses_redirects(self):
        opener = model.open_provider_request.__self__
        redirect_handler, = [h for h in opener.handlers if isinstance(h, model.request.HTTPRedirectHandler)]
        for status in (301, 302, 303, 307, 308):
            with self.subTest(status=status):
                self.assertIsNone(redirect_handler.redirect_request(None, None, status, "", {}, "https://example.invalid/"))

    def test_two_reviews_share_capacity_through_planning_and_assessment(self):
        assessing, planning = threading.Event(), threading.Event()
        finish_assessment, finish_plan = threading.Event(), threading.Event()
        first = questionnaire("intake")
        overflow = questionnaire("renewal")

        def respond(request, *, timeout):
            body = json.loads(request.data)
            tool = body["tools"][0]["name"]
            inputs = json.loads(body["messages"][0]["content"])
            if tool == "record_search_plan":
                source, = inputs["sources"]
                if inputs["mode"] == "guide":
                    planning.set()
                    self.assertTrue(finish_plan.wait(10), "Guide planner was never released")
                return tool_response(tool, {"criteria": [{
                    "sourceId": source["sourceId"], "question": source["text"], "searchTerms": ["register"],
                }]})

            self.assertEqual(tool, "record_review")
            row, = inputs
            if row["criterion"] == first["questions"][0]:
                assessing.set()
                self.assertTrue(finish_assessment.wait(10), "Questionnaire assessment was never released")
            passage, = row["passages"]
            return tool_response(tool, {"assessments": [{
                "id": row["id"], "status": "supported", "answer": passage["quote"],
                "supporting": [{"passage": passage["passage"], "quote": passage["quote"]}], "counter": [],
            }]})

        with patch.object(model, "open_provider_request", side_effect=respond) as send, ThreadPoolExecutor(3) as pool:
            try:
                active = pool.submit(api.review, first)
                self.assertTrue(assessing.wait(3), "First review never reached assessment")
                guide = pool.submit(api.review, GUIDE)
                self.assertTrue(planning.wait(3), "Second review never reached planning")

                for _ in range(2):
                    with self.assertRaisesRegex(model.ProviderUnavailable, "busy"):
                        pool.submit(api.review, overflow).result(timeout=3)
                self.assertEqual(send.call_count, 3, "Overflow contacted the model")

                finish_assessment.set()
                completed = active.result(timeout=3)
                self.assertEqual(completed["findings"][0]["supporting"][0]["documentId"], "intake")
                retry = pool.submit(api.review, overflow).result(timeout=3)
                self.assertEqual(retry["engine"], "anthropic")
                self.assertEqual(retry["findings"][0]["supporting"][0]["documentId"], "renewal")
            finally:
                # Unblock workers even if the implementation regresses to a blocking acquire.
                finish_assessment.set()
                finish_plan.set()
            self.assertEqual(guide.result(timeout=3)["planningEngine"], "anthropic")

    def test_guide_releases_model_capacity_after_return_or_exception(self):
        # Leave one slot available. A leak on any exit path blocks the next real review.
        self.assertTrue(model.SLOTS.acquire(blocking=False))
        self.addCleanup(model.SLOTS.release)
        plan = {"criteria": [{"sourceId": "s1", "question": GUIDE["guide"], "searchTerms": ["register"]}]}
        with patch.object(model, "open_provider_request") as send:
            send.side_effect = TimeoutError
            with self.assertRaisesRegex(model.ProviderUnavailable, "could not complete the search plan"):
                api.review(GUIDE)

            send.side_effect = None
            send.return_value = tool_response("record_search_plan", {"exceedsLimit": True})
            with self.assertRaisesRegex(InvalidRequest, "limit"):
                api.review(GUIDE)

            send.side_effect = RuntimeError("interrupted")
            with self.assertRaisesRegex(RuntimeError, "interrupted"):
                api.review(GUIDE)

            send.side_effect = lambda *args, **kwargs: tool_response("record_search_plan", plan)
            for _ in range(2):
                self.assertEqual(api.review(GUIDE)["planningEngine"], "anthropic")

    def test_invalid_assessment_reports_an_error_and_frees_capacity(self):
        self.assertTrue(model.SLOTS.acquire(blocking=False))
        self.addCleanup(model.SLOTS.release)
        payload = questionnaire("intake")
        plan = {"criteria": [{"sourceId": "s1", "searchTerms": ["register"]}]}
        quote = payload["documents"][0]["pages"][0]["text"]
        assessment = {"assessments": [{
            "id": "q1", "status": "supported", "answer": quote,
            "supporting": [{"passage": "p1", "quote": quote}], "counter": [],
        }]}
        invalid_responses = {
            "truncated": tool_response("record_review", assessment, stop_reason="max_tokens"),
            "unexpected tool": tool_response("other_tool", assessment),
            "invalid assessments": tool_response("record_review", {"assessments": {}}),
            "missing assessments": tool_response("record_review", {"assessments": []}),
            "missing citation arrays": tool_response("record_review", {"assessments": [{
                "id": "q1", "status": "supported", "answer": quote,
            }]}),
            "duplicate calls": io.BytesIO(json.dumps({
                "stop_reason": "tool_use",
                "content": [{"type": "tool_use", "name": "record_review", "input": assessment}] * 2,
            }).encode()),
            "oversized envelope": io.BytesIO(tool_response("record_review", assessment).getvalue()
                                             + b" " * model.MAX_RESPONSE_BYTES),
        }
        for label, response in invalid_responses.items():
            with self.subTest(label), patch.object(model, "open_provider_request", side_effect=[
                tool_response("record_search_plan", plan), response,
            ]) as send:
                with self.assertRaisesRegex(model.ProviderUnavailable, "could not complete the assessment"):
                    api.review(payload)
                self.assertEqual(send.call_count, 2)

        with patch.object(model, "open_provider_request", side_effect=[
            tool_response("record_search_plan", plan), tool_response("record_review", assessment),
        ]):
            retry = api.review(payload)
        self.assertEqual(retry["engine"], "anthropic")
        self.assertEqual(retry["findings"][0]["supporting"][0]["quote"], quote)
