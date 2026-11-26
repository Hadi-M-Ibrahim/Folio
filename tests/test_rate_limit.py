import http.client
import json
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from http.server import ThreadingHTTPServer
from unittest.mock import patch

from api import review as api
from api._review.rate_limit import LIMIT, WINDOW_SECONDS, ReviewRateLimit, network_key


class RateLimitTests(unittest.TestCase):
    def test_concurrent_clients_and_window_reset(self):
        now = 0.25
        limiter = ReviewRateLimit(clock=lambda: now)
        with ThreadPoolExecutor(8) as pool:
            results = list(pool.map(limiter.claim, ["network"] * (LIMIT + 5)))
        self.assertEqual(results.count(None), LIMIT)
        self.assertEqual(results.count((429, WINDOW_SECONDS)), 5)
        self.assertIsNone(limiter.claim("another network"))
        now += WINDOW_SECONDS - 0.5
        self.assertEqual(limiter.claim("network"), (429, 1))
        now += 0.5
        self.assertIsNone(limiter.claim("network"))

    def test_full_table_preserves_active_quotas_and_recovers(self):
        now = 0
        limiter = ReviewRateLimit(limit=1, window=5, max_clients=1, clock=lambda: now)
        self.assertIsNone(limiter.claim("first"))
        self.assertEqual(limiter.claim("second"), (503, 5))
        self.assertEqual(limiter.claim("first"), (429, 5))
        now = 5
        self.assertIsNone(limiter.claim("second"))

    def test_uses_edge_identity_only_on_vercel(self):
        peer = "127.0.0.1"
        headers = {"X-Vercel-Forwarded-For": "192.0.2.3", "X-Forwarded-For": "192.0.2.4"}
        self.assertEqual(network_key(headers, peer, vercel=False), bytes([127, 0, 0, 1]))
        self.assertEqual(network_key(headers, peer, vercel=True), bytes([192, 0, 2, 3]))
        self.assertEqual(network_key({}, peer, vercel=True),
                         network_key({"X-Vercel-Forwarded-For": "unknown"}, peer, vercel=True))
        self.assertEqual(network_key({}, "::ffff:192.0.2.3", vercel=False), bytes([192, 0, 2, 3]))

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
        now = 0
        limiter = ReviewRateLimit(limit=LIMIT, window=WINDOW_SECONDS, clock=lambda: now)
        for _ in range(LIMIT - 1):
            limiter.claim(bytes([127, 0, 0, 1]))
        with ThreadingHTTPServer(("127.0.0.1", 0), api.handler) as server:
            server.local_operator = True
            thread = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.02})
            thread.start()

            def submit(**headers):
                connection = http.client.HTTPConnection(*server.server_address, timeout=2)
                try:
                    connection.request("POST", "/api/review", "{}", {"Content-Type": "application/json", **headers})
                    response = connection.getresponse()
                    return response.status, response.getheader("Retry-After"), json.loads(response.read())
                finally:
                    connection.close()

            try:
                with patch.object(api, "REVIEW_LIMIT", limiter), patch.object(api, "review", return_value={}) as review:
                    self.assertEqual(submit(Host="example.org")[0], 403)
                    self.assertEqual(submit(**{"Sec-Fetch-Site": "cross-site"})[0], 403)
                    self.assertEqual(submit()[0], 200)
                    now = 52
                    status, retry, body = submit()
                    self.assertEqual((status, retry), (429, "548"))
                    self.assertEqual(body["error"], "This network has reached its limit of 30 review submissions per 10 minutes. Try again in 548 seconds.")
                    review.assert_called_once()
                    now = WINDOW_SECONDS
                    self.assertEqual(submit()[0], 200)
            finally:
                server.shutdown()
                thread.join()
