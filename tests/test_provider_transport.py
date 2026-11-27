import io
import json
import unittest
from email.message import Message
from unittest.mock import patch
from urllib.error import HTTPError, URLError

from api._review import model


def http_error(status, retry_after=None, *, should_retry=None):
    headers = Message()
    if retry_after is not None:
        headers["retry-after"] = retry_after
    if should_retry is not None:
        headers["x-should-retry"] = should_retry
    return HTTPError("https://example.invalid/", status, "private reason", headers, io.BytesIO(b"private body"))


def reply(stop, content):
    return io.BytesIO(json.dumps({"stop_reason": stop, "content": content}).encode())


class ProviderTransportTests(unittest.TestCase):
    def setUp(self):
        self.now = 100
        self.enterContext(patch.object(model.time, "monotonic", side_effect=lambda: self.now))
        self.sleep = self.enterContext(patch.object(model.time, "sleep", side_effect=self.advance))
        self.enterContext(patch.object(model.random, "uniform", return_value=0.75))
        self.send = self.enterContext(patch.object(model, "open_provider_request"))

    def advance(self, seconds):
        self.now += seconds

    def invoke(self, *, deadline=200):
        return model.invoke_tool("synthetic", model.TOOL, ["private source"], "private key", deadline)

    def test_short_rate_limit_recovers_inside_original_call_budget(self):
        failure = http_error(429, "2")
        parts = [{"type": "tool_use", "name": model.TOOL["name"], "input": {"assessments": []}}]

        def respond(outgoing, *, timeout):
            if self.send.call_count == 1:
                self.advance(4)
                raise failure
            self.assertTrue(failure.closed)
            return reply("tool_use", parts)

        self.send.side_effect = respond
        with self.assertLogs(model.logger) as logs:
            self.assertEqual(self.invoke(), {"assessments": []})
        self.assertEqual([r.getMessage() for r in logs.records], ["anthropic_http_error status=429 retry=True"])
        self.sleep.assert_called_once_with(2)
        self.assertEqual([call.kwargs["timeout"] for call in self.send.call_args_list],
                         [model.CALL_SECONDS, model.CALL_SECONDS - 6])
        first, second = self.send.call_args_list
        self.assertIs(first.args[0], second.args[0])

    def test_repeated_overload_stops_after_one_retry(self):
        failures = [http_error(529), http_error(503, "1")]
        self.send.side_effect = failures
        with self.assertLogs(model.logger) as logs, self.assertRaises(model.ProviderUnavailable) as error:
            self.invoke()
        self.assertIsInstance(error.exception, model.ProviderServiceError)
        self.assertIn("temporarily unavailable", str(error.exception))
        self.assertEqual([r.getMessage() for r in logs.records],
                         ["anthropic_http_error status=529 retry=True", "anthropic_http_error status=503 retry=False"])
        self.assertEqual(self.send.call_count, 2)
        self.sleep.assert_called_once_with(0.75)
        self.assertTrue(all(failure.closed for failure in failures))

    def test_account_errors_and_impractical_waits_fail_without_replay_or_subdivision(self):
        cases = [
            (http_error(400, "1"), 200), (http_error(401, "1"), 200), (http_error(402, "1"), 200),
            (http_error(403, "1"), 200), (http_error(404, "1"), 200), (http_error(429), 200),
            (http_error(429, "3600"), 200), (http_error(503, "invalid"), 200),
            (http_error(503, "1", should_retry="false"), 200), (http_error(503, "2"), 103),
        ]
        for failure, deadline in cases:
            with self.subTest(status=failure.code, deadline=deadline):
                self.send.reset_mock()
                self.send.side_effect = failure
                with self.assertLogs(model.logger) as logs, self.assertRaises(model.ProviderUnavailable) as error:
                    self.invoke(deadline=deadline)
                if failure.code == 400:
                    self.assertIs(type(error.exception), model.ProviderUnavailable)
                else:
                    self.assertIsInstance(error.exception, model.ProviderServiceError)
                    expected = "request limit" if failure.code == 429 else (
                        "temporarily unavailable" if failure.code >= 500 else "API configuration")
                    self.assertIn(expected, str(error.exception))
                    self.assertNotIn("private", str(error.exception))
                self.assertEqual([r.getMessage() for r in logs.records],
                                 [f"anthropic_http_error status={failure.code} retry=False"])
                self.send.assert_called_once()
                self.sleep.assert_not_called()
                self.assertTrue(failure.closed)

    def test_retry_after_date_uses_wall_clock_and_review_deadline(self):
        self.send.side_effect = [http_error(503, "Thu, 01 Jan 1970 00:01:43 GMT"), http_error(503)]
        with patch.object(model.time, "time", return_value=100), self.assertLogs(model.logger), \
             self.assertRaises(model.ProviderUnavailable):
            self.invoke(deadline=110)
        self.sleep.assert_called_once_with(3)
        self.assertEqual([call.kwargs["timeout"] for call in self.send.call_args_list], [10, 7])

    def test_late_wakeup_cannot_replay_a_rate_limited_request_or_trigger_a_split(self):
        self.send.side_effect = http_error(429, "1")
        self.sleep.side_effect = lambda seconds: self.advance(seconds + 4)
        with self.assertLogs(model.logger), self.assertRaises(model.ProviderUnavailable) as error:
            self.invoke(deadline=105)
        self.assertIsInstance(error.exception, model.ProviderServiceError)
        self.assertIn("request limit", str(error.exception))
        self.send.assert_called_once()

    def test_timeout_exposes_budget_failure_without_replaying_request(self):
        for failure in (TimeoutError("private reason"), URLError(TimeoutError("private reason"))):
            with self.subTest(failure=type(failure)):
                self.send.reset_mock()
                self.send.side_effect = failure
                with self.assertRaises(model.DeadlineExceeded) as error:
                    self.invoke()
                self.assertEqual(str(error.exception), "")
                self.send.assert_called_once()
                self.sleep.assert_not_called()

    def test_only_completed_turns_missing_the_requested_tool_get_that_diagnostic(self):
        text = [{"type": "text", "text": "private source"}]
        other_tool = [{"type": "tool_use", "name": "private name", "input": {}}]
        for stop, content, expected, diagnostic in (
            ("end_turn", text, model.MissingToolCall, "anthropic_missing_tool_call"),
            ("tool_use", other_tool, model.MissingToolCall, "anthropic_missing_tool_call"),
            ("refusal", text, model.ProviderUnavailable, "anthropic_unexpected_stop reason=refusal"),
            ("private reason", text, model.ProviderUnavailable, "anthropic_unexpected_stop reason=other"),
        ):
            with self.subTest(stop=stop):
                self.send.reset_mock()
                self.send.return_value = reply(stop, content)
                with self.assertRaises(model.ProviderUnavailable) as error, self.assertLogs(model.logger) as logs:
                    self.invoke()
                self.assertIs(type(error.exception), expected)
                self.assertEqual([r.getMessage() for r in logs.records], [diagnostic])
                self.send.assert_called_once()
                self.sleep.assert_not_called()
