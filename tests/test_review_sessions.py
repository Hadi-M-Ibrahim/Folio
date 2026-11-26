import unittest
from unittest.mock import Mock, patch

from vercel.cache.cache_in_memory import InMemoryCache

from api._review import sessions


class ReviewSessionTests(unittest.TestCase):
    def test_local_lease_storage_is_bounded_and_reclaims_expired_entries(self):
        now = 10
        store = sessions.LocalSessions(capacity=1, clock=lambda: now)
        first = sessions.session_key(sessions.create_session(store))
        self.assertTrue(store.active(first))
        with self.assertRaises(sessions.SessionUnavailable):
            sessions.create_session(store)
        now += sessions.SESSION_TTL
        self.assertFalse(store.active(first))
        second = sessions.session_key(sessions.create_session(store))
        self.assertEqual(list(store.entries), [second])
        store.cancel(second)
        self.assertFalse(store.active(second))

    def test_separate_sdk_clients_share_only_hashed_keys_tags_and_constant_values(self):
        backend = Mock(wraps=InMemoryCache())
        with patch("vercel.cache.runtime_cache.resolve_cache", return_value=backend) as resolve:
            start, review, stop = (sessions.HostedSessions() for _ in range(3))
            token = sessions.create_session(start)
            key = sessions.session_key(token)
            self.assertTrue(review.active(key))
            stop.cancel(key)
            self.assertFalse(review.active(key))
            backend.expire_tag.assert_called_once_with(key)
            self.assertNotIn(token, str(backend.mock_calls))
            self.assertEqual([call.args[:2] for call in backend.set.call_args_list],
                             [(key, "active"), (key + "-stop", "cancelled")])
            for call in resolve.call_args_list:
                self.assertTrue(call.kwargs["strict"])

    def test_revocation_receipt_stops_work_before_tag_invalidation_arrives(self):
        backend = Mock(wraps=InMemoryCache())
        backend.expire_tag.side_effect = lambda key: None
        with patch("vercel.cache.runtime_cache.resolve_cache", return_value=backend):
            store = sessions.HostedSessions()
            key = sessions.session_key(sessions.create_session(store))
            store.cancel(key)
            self.assertEqual(backend.get(key), "active")
            self.assertFalse(store.active(key))

    def test_cache_misses_errors_and_silently_dropped_writes_fail_closed(self):
        backend = Mock()
        backend.get.return_value = None
        with patch("vercel.cache.runtime_cache.resolve_cache", return_value=backend):
            store = sessions.HostedSessions()
            self.assertFalse(store.active("absent"))
            with self.assertRaises(sessions.SessionUnavailable):
                sessions.create_session(store)
            with self.assertRaises(sessions.SessionUnavailable):
                store.cancel("absent")
            backend.get.side_effect = OSError("unavailable")
            with self.assertRaises(sessions.SessionUnavailable):
                store.active("key")
