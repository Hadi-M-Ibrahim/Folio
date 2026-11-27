import io
import json
import os
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import patch

from api import review as api
from api._review import model, sessions
from tests.test_pdf_review import pdf_attachment
from tests.test_review import insufficient_assessments


def questionnaire(label):
    return {
        "mode": "questionnaire", "allowModel": True, "modelSharingConsent": True,
        "questions": [f"Who keeps the {label} register?"],
        "documents": [{"id": label, "title": label, "pages": [
            {"number": 4, "text": f"The {label} clerk keeps the register."},
        ]}],
    }


GUIDE = {
    "mode": "guide", "guide": "The office must keep a register.", "documents": questionnaire("filing")["documents"],
    "allowModel": True, "modelSharingConsent": True, "requireComplete": True,
}


def tool_response(name, data, *, stop_reason="tool_use"):
    return io.BytesIO(json.dumps({
        "stop_reason": stop_reason,
        "content": [{"type": "tool_use", "name": name, "input": data}],
    }).encode())


RULE = "The clerk must sign register {} before departure."
EXCEPTION = "During outages the clerk may leave register {} unsigned before departure."


def register_review(mode):
    numbers = range(1, 11)
    pages = [{"number": n, "text": RULE.format(n) + "\n\n" + EXCEPTION.format(n)} for n in numbers]
    # A long policy makes the provider's PDF context depend on the specific batch.
    pages.extend({"number": n, "text": "Visitor parking at reception."} for n in (11, 12, 13))
    policy = pdf_attachment("policy", [page["number"] for page in pages])
    return {
        "mode": mode, "allowModel": True, "modelSharingConsent": True, "requireComplete": True,
        **({"guide": "\n".join(RULE.format(n) for n in numbers)} if mode == "guide" else
           {"questions": [f"Must the clerk sign register {n} before departure?" for n in numbers]}),
        "documents": [{"id": policy["documentId"], "title": policy["title"], "pages": pages}],
        "pdfAttachments": [pdf_attachment("source", [3]), policy],
    }


def register_transport(assess):
    def respond(request, *, timeout):
        body = json.loads(request.data)
        tool = body["tools"][0]["name"]
        rows = json.loads(body["messages"][0]["content"][-1]["text"])
        if tool == "record_search_plan":
            return tool_response(tool, {"criteria": [
                {"sourceId": row["sourceId"], "question": row["text"], "searchTerms": [f"register {n}"]}
                for n, row in enumerate(rows["sources"], 1)
            ]})
        assert tool == "record_review"
        return tool_response(tool, {"assessments": assess(rows)})
    return respond


def mixed_assessments(rows):
    scope = {"actor": "same", "population": "overlaps", "event": "same", "duty": "same",
             "eventComparison": "Both address departure.", "dutyComparison": "Both govern signing the same register."}
    assessments = []
    for row in rows:
        number = int(row["id"][1:])
        passages = {p["quote"]: p["passage"] for p in row["passages"]}
        rule, exception = RULE.format(number), EXCEPTION.format(number)
        assessments.append({
            "id": row["id"], "status": "mixed", "answer": exception,
            "supporting": [{"passage": passages[rule], "quote": rule}],
            "counter": [{"passage": passages[exception], "quote": exception, "scope": scope}],
        })
    return assessments


class ConcurrentReviewTests(unittest.TestCase):
    def setUp(self):
        self.enterContext(patch.dict(os.environ, {"VERCEL": "1", "ANTHROPIC_API_KEY": "test-key"}, clear=True))

    def test_provider_transport_refuses_redirects(self):
        opener = model.open_provider_request.__self__
        redirect_handler, = [h for h in opener.handlers if isinstance(h, model.request.HTTPRedirectHandler)]
        for status in (301, 302, 303, 307, 308):
            with self.subTest(status=status):
                self.assertIsNone(redirect_handler.redirect_request(None, None, status, "", {}, "https://example.invalid/"))

    def test_overlapping_strict_batches_preserve_serial_inputs_findings_and_citations(self):
        for mode in ("questionnaire", "guide"):
            with self.subTest(mode=mode):
                self.check_parallel_registers(mode)

    def test_a_service_limit_wins_over_a_siblings_split_request(self):
        rows = [{"id": f"q{n}"} for n in range(15)]

        def fail(group, **kwargs):
            if group[0]["id"] == "q0":
                raise model.OutputTruncated
            raise model.ProviderServiceError("Provider limit")

        with patch.object(model, "assess_batch", side_effect=fail) as assess:
            with self.assertRaisesRegex(model.ProviderServiceError, "Provider limit"):
                model.assess_findings(rows, {}, "test-key", 100, require_complete=True)
        self.assertCountEqual([call.args[0][0]["id"] for call in assess.call_args_list], ["q0", "q5"])

    def check_parallel_registers(self, mode):
        payload = register_review(mode)
        with (patch.object(model, "MAX_CONCURRENT_CALLS", 1),
              patch.object(model, "open_provider_request", side_effect=register_transport(mixed_assessments)) as serial):
            expected = api.review(payload)

        first_started, second_verified = threading.Event(), threading.Event()
        def overlapping_assessment(rows):
            start = 1 if rows[0]["id"] == "q1" else 6
            self.assertEqual([row["id"] for row in rows], [f"q{n}" for n in range(start, start + 5)])
            if start == 1:
                first_started.set()
                self.assertTrue(second_verified.wait(5), "Second batch never finished while first was in flight")
            else:
                self.assertTrue(first_started.wait(5), "First batch never entered the provider")
            return mixed_assessments(rows)

        real_batch = model.assess_batch
        def finish_batch(*args, **kwargs):
            batch = real_batch(*args, **kwargs)
            if batch[0]["id"] == "q6":
                second_verified.set()
            return batch

        with (patch.object(model, "open_provider_request", side_effect=register_transport(overlapping_assessment)) as concurrent,
              patch.object(model, "assess_batch", side_effect=finish_batch)):
            actual = api.review(payload)

        self.assertEqual(actual, expected)
        self.assertEqual(serial.call_count, 3)
        self.assertCountEqual([call.args[0].data for call in concurrent.call_args_list],
                              [call.args[0].data for call in serial.call_args_list])
        self.assertEqual(len(actual["findings"]), 10)
        for n, finding in enumerate(actual["findings"], 1):
            self.assertEqual((finding["id"], finding["status"]), (f"q{n}", "mixed"))
            for side, quote in (("supporting", RULE.format(n)), ("counter", EXCEPTION.format(n))):
                citation, = finding[side]
                self.assertEqual((citation["documentId"], citation["page"], citation["quote"]),
                                 ("policy-id", n, quote))

    def test_cancelled_session_stops_both_batches_before_repair(self):
        store = sessions.LocalSessions()
        token = sessions.create_session(store)
        both_in_flight = threading.Barrier(2, action=lambda: store.cancel(sessions.session_key(token)), timeout=5)

        def omit_rows(rows):
            both_in_flight.wait()
            return []

        with (patch.object(sessions, "session_store", return_value=store),
              patch.object(model, "open_provider_request", side_effect=register_transport(omit_rows)) as send,
              self.assertRaises(sessions.ReviewCancelled), sessions.review_session(token, local=True)):
            api.review(register_review("questionnaire"))
        self.assertEqual(send.call_count, 3, "A repair reached the provider after session cancellation")

    def test_review_waiting_for_a_shared_connection_honors_revocation(self):
        both_in_flight = threading.Barrier(3, timeout=5)
        queued, release = threading.Event(), threading.Event()
        store = sessions.LocalSessions()
        token = sessions.create_session(store)

        def hold_assessments(rows):
            both_in_flight.wait()
            self.assertTrue(release.wait(10), "Provider connections were never released")
            return mixed_assessments(rows)

        def queued_review():
            with sessions.review_session(token, local=True):
                return api.review(register_review("guide"))

        acquire = model.CONNECTIONS.acquire
        def wait_for_connection(*, timeout):
            if acquire(blocking=False):
                model.CONNECTIONS.release()
                self.fail("A third provider connection was available")
            queued.set()
            return acquire(timeout=timeout)

        with (patch.object(sessions, "session_store", return_value=store),
              patch.object(model, "open_provider_request", side_effect=register_transport(hold_assessments)) as send,
              ThreadPoolExecutor(2) as pool):
            active = pool.submit(api.review, register_review("questionnaire"))
            try:
                both_in_flight.wait()
                with patch.object(model.CONNECTIONS, "acquire", side_effect=wait_for_connection):
                    waiting = pool.submit(queued_review)
                    self.assertTrue(queued.wait(5), "Second review never requested a provider connection")
                    store.cancel(sessions.session_key(token))
                    release.set()
                    with self.assertRaises(sessions.ReviewCancelled):
                        waiting.result(timeout=5)
            finally:
                release.set()
            self.assertEqual(len(active.result(timeout=5)["findings"]), 10)
            self.assertEqual(send.call_count, 3, "Revoked review contacted the provider after waiting")

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
            with self.assertRaisesRegex(model.ProviderUnavailable, "timed out while planning"):
                api.review(GUIDE)

            send.side_effect = None
            send.return_value = tool_response("record_search_plan", {"exceedsLimit": True})
            with self.assertRaisesRegex(model.ProviderUnavailable, "could not complete the search plan"):
                api.review(GUIDE)

            send.side_effect = RuntimeError("interrupted")
            with self.assertRaisesRegex(RuntimeError, "interrupted"):
                api.review(GUIDE)

            send.side_effect = [response for _ in range(2) for response in (
                tool_response("record_search_plan", plan), tool_response("record_review", insufficient_assessments("q1")),
            )]
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
