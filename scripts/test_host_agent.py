#!/usr/bin/env python3
"""host-agent.py servis kontrolü testleri — isteğe bağlı (on-demand) servis işareti.

Çalıştır:  python3 scripts/test_host_agent.py
Sahte dünya: yerel kapalı port + geçici işaret dosyası; ağ/gerçek servis yok.
"""

import importlib.util
import os
import pathlib
import socket
import tempfile
import unittest
from unittest import mock

HERE = pathlib.Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("host_agent", HERE / "host-agent.py")
assert spec is not None and spec.loader is not None
host_agent = importlib.util.module_from_spec(spec)
spec.loader.exec_module(host_agent)


def closed_port_url():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()  # nothing listens here any more
    return f"http://127.0.0.1:{port}/"


class OnDemandServiceTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.marker = os.path.join(self.tmp.name, "asleep")
        self.url = closed_port_url()
        # the 5 s retry sleep must never slow the suite down
        self.sleep = mock.patch.object(host_agent.time, "sleep", lambda s: None)
        self.sleep.start()

    def tearDown(self):
        self.sleep.stop()
        self.tmp.cleanup()

    def service(self, **extra):
        return {"name": "svc", "url": self.url, **extra}

    def test_down_without_marker_stays_down(self):
        r = host_agent.check_service(self.service(on_demand_marker=self.marker))
        self.assertEqual(r["status"], "down")

    def test_down_without_marker_config_stays_down(self):
        r = host_agent.check_service(self.service())
        self.assertEqual(r["status"], "down")

    def test_marker_present_and_check_fails_is_up_with_detail(self):
        open(self.marker, "w").close()
        r = host_agent.check_service(self.service(on_demand_marker=self.marker, on_demand_detail="asleep (test)"))
        self.assertEqual(r["status"], "up")
        self.assertEqual(r["detail"], "asleep (test)")
        self.assertEqual(r["name"], "svc")  # entry kept, never dropped

    def test_default_detail_when_not_configured(self):
        open(self.marker, "w").close()
        r = host_agent.check_service(self.service(on_demand_marker=self.marker))
        self.assertEqual((r["status"], r["detail"]), ("up", "sleeping (on demand)"))

    def test_marker_present_skips_the_retry_wait(self):
        open(self.marker, "w").close()
        with mock.patch.object(host_agent, "_check_service_once", wraps=host_agent._check_service_once) as once:
            host_agent.check_service(self.service(on_demand_marker=self.marker))
        self.assertEqual(once.call_count, 1)

    def test_marker_written_during_retry_wait_is_honoured(self):
        calls = []
        real = host_agent._check_service_once

        def once(service):
            calls.append(1)
            if len(calls) == 2:
                open(self.marker, "w").close()  # stopper wrote the marker while the retry was in flight
            return real(service)

        with mock.patch.object(host_agent, "_check_service_once", once):
            r = host_agent.check_service(self.service(on_demand_marker=self.marker))
        self.assertEqual(len(calls), 2)
        self.assertEqual(r["status"], "up")

    def test_healthy_service_ignores_marker(self):
        open(self.marker, "w").close()
        with mock.patch.object(host_agent, "_check_service_once",
                               return_value={"name": "svc", "status": "up", "ms": 3, "code": 200, "detail": None}):
            r = host_agent.check_service(self.service(on_demand_marker=self.marker, on_demand_detail="asleep"))
        self.assertEqual((r["status"], r["code"], r["detail"]), ("up", 200, None))


if __name__ == "__main__":
    unittest.main()
