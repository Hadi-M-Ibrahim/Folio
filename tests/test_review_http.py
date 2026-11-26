import http.client
import json
import os
import threading
import unittest
from contextlib import closing
from http.server import ThreadingHTTPServer
from unittest.mock import patch

from api import review as api
from api._review import model
from api._review.rate_limit import LIMIT, WINDOW_SECONDS, ReviewRateLimit


class HttpContractTests(unittest.TestCase):
    def setUp(self):
        self.server = self.enterContext(ThreadingHTTPServer(("127.0.0.1", 0), api.handler))
        self.now = 0
        limiter = ReviewRateLimit(clock=lambda: self.now)
        self.enterContext(patch.object(api, "REVIEW_LIMIT", limiter))
        thread = threading.Thread(target=self.server.serve_forever, kwargs={"poll_interval": 0.01})
        thread.start()
        self.addCleanup(thread.join)
        self.addCleanup(self.server.shutdown)

    def request(self, body="{}", *, method="POST", path="/api/review", headers=None):
        headers = {"Content-Type": "application/json", **(headers or {})}
        with closing(http.client.HTTPConnection(*self.server.server_address, timeout=3)) as connection:
            connection.request(method, path, body, headers)
            response = connection.getresponse()
            return response.status, response.headers, json.loads(response.read())

    def test_http_entry_point_and_errors(self):
        guide = {"mode": "guide", "guide": "Staff must keep records.", "documents": []}
        self.assertEqual(self.request(json.dumps(guide))[0], 200)
        self.assertEqual(self.request("{")[0], 400)
        self.assertEqual(self.request()[0], 422)
        self.assertEqual(self.request(headers={"Content-Type": "text/plain"})[0], 415)
        self.assertEqual(self.request(None, method="GET")[0], 405)
        self.assertEqual(self.request(path="/nonexistent")[0], 404)

    def test_http_size_limit_and_no_store_apply_before_body_read(self):
        status, headers, _ = self.request(None, headers={"Content-Length": str(api.MAX_BODY + 1)})
        self.assertEqual(status, 413)
        self.assertEqual(headers["Cache-Control"], "no-store")

    def test_required_model_returns_503_and_the_same_request_can_be_retried(self):
        payload = json.dumps({"mode": "guide", "guide": "Staff must keep records.", "documents": [],
                              "allowModel": True, "modelSharingConsent": True})
        plan = {"criteria": [{"sourceId": "s1", "question": "Do staff keep records?", "searchTerms": ["records"]}]}
        for local in (True, False):
            self.server.local_operator = local
            with self.subTest(local=local), patch.dict(os.environ, {} if local else {"VERCEL": "1"}, clear=True), \
                 patch.object(model, "invoke_tool", side_effect=[model.ProviderUnavailable, plan]) as invoke:
                status, headers, body = self.request(payload)
                self.assertEqual((status, headers["Cache-Control"]), (503, "no-store"))
                self.assertIn("missing its Anthropic API key", body["error"])
                invoke.assert_not_called()
                with patch.dict(os.environ, {"ANTHROPIC_API_KEY": "test-key"}):
                    status, _, body = self.request(payload)
                    self.assertEqual(status, 503)
                    self.assertIn("Try again", body["error"])
                    status, _, body = self.request(payload)
                    self.assertEqual((status, body["engine"]), (200, "anthropic"))

    def test_large_result_returns_a_complete_error(self):
        with patch.object(api, "MAX_RESPONSE", 256), patch.object(api, "review", return_value={"text": "é" * 80}):
            status, _, body = self.request()
        self.assertEqual(status, 422)
        self.assertIn("Select fewer questions", body["error"])

    def test_local_operator_authority(self):
        for headers in [
            {"Host": "localhost:5173", "Origin": "http://localhost:5173"},
            {"Host": "[::1]:8000"},
        ]:
            self.assertTrue(api.allowed_local_request(headers))
        for headers in [
            {"Host": "example.org"}, {"Host": "localhost:8000", "Origin": "null"},
            {"Host": "localhost:8000", "Origin": "http://localhost:5173"},
        ]:
            self.assertFalse(api.allowed_local_request(headers))

    def test_http_quota_precedes_review_work_and_returns_retry_after(self):
        self.server.local_operator = True
        with patch.object(api, "review", return_value={}) as review:
            self.assertEqual(self.request(headers={"Host": "example.org"})[0], 403)
            self.assertEqual(self.request(headers={"Sec-Fetch-Site": "cross-site"})[0], 403)
            for _ in range(LIMIT):
                self.assertEqual(self.request()[0], 200)
            self.now = 52
            status, headers, body = self.request()
            self.assertEqual((status, headers["Retry-After"]), (429, "548"))
            self.assertEqual(body["error"], "This network has reached its limit of 30 review submissions per 10 minutes. Try again in 548 seconds.")
            self.assertEqual(review.call_count, LIMIT)
            self.now = WINDOW_SECONDS
            self.assertEqual(self.request()[0], 200)
