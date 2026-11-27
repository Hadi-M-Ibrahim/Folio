import json
import os
import unittest
from unittest.mock import patch

from api._review import draft, model
from api._review.search import MAX_PAGE_NUMBER, MAX_PASSAGE_CHARS, InvalidRequest
from tests.test_review_concurrency import tool_response


def response_request(**changes):
    return {
        "action": "draft", "question": "How does the office notify applicants?", "status": "mixed",
        "assessment": "The policy provides an exception for urgent requests.", "answer": "",
        "citations": [
            {"documentId": "notice", "title": "Notice policy", "page": 2, "quote": "We issue a written notice."},
            {"documentId": "notice", "title": "Notice policy", "page": 3, "quote": "For urgent requests we call instead."},
        ],
        **changes,
    }


class ResponseDraftTests(unittest.TestCase):
    def setUp(self):
        self.enterContext(patch.dict(os.environ, {"VERCEL": "1", "ANTHROPIC_API_KEY": "test-key"}, clear=True))
        self.send = self.enterContext(patch.object(model, "open_provider_request"))

    def test_each_action_requests_one_model_response_with_only_the_current_question(self):
        generated = {"answer": "We issue a written notice except for urgent requests, when we call."}
        for action in ("draft", "shorten", "simplify", "expand"):
            with self.subTest(action=action):
                self.send.reset_mock()
                self.send.return_value = tool_response("record_response_draft", generated)
                payload = response_request(action=action, answer="" if action == "draft" else "Our staff send notices per policy.")
                self.assertEqual(draft.draft_response(payload), generated)
                self.send.assert_called_once()
                request, = self.send.call_args.args
                body = json.loads(request.data)
                self.assertEqual(body["tools"], [draft.TOOL])
                self.assertIn(draft.INSTRUCTIONS[action], body["system"])
                message, = body["messages"]
                self.assertEqual((message["role"], json.loads(message["content"])), ("user", payload))

    def test_no_evidence_goes_to_the_model_with_an_explicit_gap_instruction(self):
        generated = {"answer": "The available evidence does not establish how applicants are notified."}
        self.send.return_value = tool_response("record_response_draft", generated)
        payload = response_request(status="insufficient", citations=[])
        self.assertEqual(draft.draft_response(payload), generated)
        body = json.loads(self.send.call_args.args[0].data)
        self.assertIn("Explicitly state what the available evidence cannot establish", body["system"])
        self.assertEqual(json.loads(body["messages"][0]["content"])["citations"], [])

    def test_malformed_or_oversize_context_never_reaches_transport(self):
        cite = response_request()["citations"][0]
        for payload in (
            None, {}, response_request(documents=[]), response_request(action=[]), response_request(action="freeform"),
            response_request(status="verified"), response_request(question=" "), response_request(question="a" * 12_001),
            response_request(assessment=[]), response_request(assessment="a" * 2001), response_request(answer=None),
            response_request(answer="a" * (draft.MAX_ANSWER_CHARS + 1)), response_request(action="shorten", answer=" "),
            response_request(citations=None), response_request(citations=[cite] * (draft.MAX_CITATIONS + 1)),
            *(response_request(citations=[{**cite, **change}]) for change in (
                {"body": "full file"}, {"documentId": ""}, {"title": "x" * 241}, {"quote": "x" * (MAX_PASSAGE_CHARS + 1)},
                {"page": False}, {"page": 0}, {"page": MAX_PAGE_NUMBER + 1},
            )),
        ):
            with self.subTest(payload=str(payload)[:100]), self.assertRaises(InvalidRequest):
                draft.draft_response(payload)
        self.send.assert_not_called()

    def test_invalid_result_fails_without_replacing_author_text_and_releases_slot(self):
        self.assertTrue(model.SLOTS.acquire(blocking=False))
        self.addCleanup(model.SLOTS.release)
        payload = response_request(action="simplify", answer="The original answer.")
        for tool, result in (
            ("record_review", {}), ("record_response_draft", {}), ("record_response_draft", {"answer": None}),
            ("record_response_draft", {"answer": " "}), ("record_response_draft", {"answer": "x", "citations": []}),
            ("record_response_draft", {"answer": "a" * (draft.MAX_ANSWER_CHARS + 1)}),
        ):
            with self.subTest(tool=tool, fields=list(result)):
                self.send.reset_mock()
                self.send.return_value = tool_response(tool, result)
                with self.assertRaisesRegex(model.ProviderUnavailable, "Try again"):
                    draft.draft_response(payload)
                self.send.assert_called_once()
        self.send.side_effect = OSError("private transport details")
        with self.assertRaisesRegex(model.ProviderServiceError, "could not reach Anthropic"):
            draft.draft_response(payload)
        self.assertEqual(payload["answer"], "The original answer.")
