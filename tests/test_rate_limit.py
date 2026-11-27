import unittest

from api._review.rate_limit import LIMIT, WINDOW_SECONDS, ReviewRateLimit, network_key


class RateLimitTests(unittest.TestCase):
    def test_independent_client_quota_and_window_reset(self):
        now = 0.25
        limiter = ReviewRateLimit(clock=lambda: now)
        for _ in range(LIMIT):
            self.assertIsNone(limiter.claim("network"))
        self.assertEqual(limiter.claim("network"), (429, WINDOW_SECONDS))
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
