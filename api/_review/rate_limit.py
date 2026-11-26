"""Short-lived review quotas for the HTTP worker, including loopback development."""

import math
import threading
import time
from collections import OrderedDict
from ipaddress import ip_address

LIMIT = 30
WINDOW_SECONDS = 600


def network_key(headers, peer, *, vercel):
    # Only Vercel's own runtime may supply the edge-authenticated client address.
    address = headers.get("X-Vercel-Forwarded-For") if vercel else peer
    try:
        ip = ip_address(address)
        return (getattr(ip, "ipv4_mapped", None) or ip).packed
    except ValueError:
        return b"unknown"


class ReviewRateLimit:
    def __init__(self, limit=LIMIT, window=WINDOW_SECONDS, max_clients=8192, clock=time.monotonic):
        self.limit = limit
        self.window = window
        self.max_clients = max_clients
        self.clock = clock
        self.clients = OrderedDict()
        self.lock = threading.Lock()

    def claim(self, key):
        """Return (HTTP status, retry seconds) on refusal, otherwise reserve one request."""
        with self.lock:
            now = self.clock()
            # First-request windows expire in insertion order. Hits never extend them.
            while self.clients:
                oldest = next(iter(self.clients))
                if self.clients[oldest][0] > now:
                    break
                self.clients.popitem(last=False)
            entry = self.clients.get(key)
            if entry is None:
                if len(self.clients) == self.max_clients:
                    # Preserve existing quotas and bound memory during heavy traffic.
                    first_expiry = next(iter(self.clients.values()))[0]
                    return 503, math.ceil(first_expiry - now)
                self.clients[key] = (now + self.window, 1)
            else:
                expires, count = entry
                if count >= self.limit:
                    return 429, math.ceil(expires - now)
                self.clients[key] = (expires, count + 1)
            return None
