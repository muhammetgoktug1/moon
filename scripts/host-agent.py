#!/usr/bin/env python3
"""Host resource agent — sends CPU/RAM/disk/load/uptime + local service checks
to a moon instance over POST /api/internal/host-report (Faz A).

GENERIC tool: no host names, URLs, ports or tokens live in this file. Everything
machine-specific comes from the environment:

  MOON_REPORT_URL      full report endpoint URL (https://…/api/internal/host-report)
  MOON_SERVICE_TOKEN   bearer token the endpoint authenticates with
  HOST_AGENT_CONFIG    path to a JSON config file:
                       {
                         "host": {"name": "…", "os": "darwin"|"linux"},   # os optional
                         "interval": 60,                                  # seconds, loop mode
                         "services": [{"name": "svc-a", "url": "http://…"}]
                       }

Usage:
  host-agent.py             loop forever: measure, send, sleep(interval)
  host-agent.py --once      a single measure+send cycle, then exit
  host-agent.py --dry-run   measure and print the report JSON, never send

Only the Python standard library is used (urllib, subprocess, json) — no psutil,
so it runs on a bare macOS/Linux host with the system interpreter. Metrics:
  darwin: top -l 1 / vm_stat + sysctl hw.memsize / df -P / uptime
  linux:  /proc/stat (two samples) / /proc/meminfo / df -P / /proc/loadavg + /proc/uptime

Service checks are plain HTTP GETs: 2xx-3xx = up, anything else or a network
error = down (code/error kept in `detail`, truncated). The report body carries
no secrets; the server stamps `at` and never stores the token.
"""

import argparse
import json
import os
import platform
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request

SERVICE_TIMEOUT_S = 10
SEND_TIMEOUT_S = 15
DETAIL_MAX = 300


def run(cmd):
    """subprocess.run helper: returns stdout text, or raises."""
    out = subprocess.run(cmd, capture_output=True, text=True, check=True, timeout=15)
    return out.stdout


def num_or_none(value):
    try:
        f = float(value)
        return f if f == f and f not in (float("inf"), float("-inf")) else None
    except (TypeError, ValueError):
        return None


# --- darwin (macOS) -----------------------------------------------------------


def cpu_darwin():
    # "CPU usage: 5.25% user, 3.10% sys, 91.65% idle" → busy = 100 - idle
    text = run(["top", "-l", "1", "-n", "0", "-s", "0"])
    m = re.search(r"CPU usage:.*?([0-9.]+)% idle", text)
    if not m:
        return None
    idle = num_or_none(m.group(1))
    return None if idle is None else round(100 - idle, 1)


def mem_darwin():
    # available ≈ free + inactive + speculative + purgeable; total from sysctl
    try:
        total = int(run(["sysctl", "-n", "hw.memsize"]).strip())
    except (subprocess.SubprocessError, ValueError):
        return None, None
    pages = {}
    try:
        text = run(["vm_stat"])
    except subprocess.SubprocessError:
        return None, None
    m = re.search(r"page size of (\d+) bytes", text)
    size = int(m.group(1)) if m else 16384
    for key, value in re.findall(r"Pages\s+([^:]+):\s+(\d+)", text):
        pages[key.strip().lower()] = int(value) * size
    free = pages.get("free", 0) + pages.get("inactive", 0) + pages.get("speculative", 0) + pages.get("purgeable", 0)
    if total <= 0 or free > total:
        return None, None
    return round(100 * (total - free) / total, 1), round(total / 1048576)


def disk_darwin():
    return disk_df()


def load_uptime_darwin():
    # "14:23  up 12 days, 3:52, 2 users, load averages: 1.86 1.69 1.83"
    try:
        text = run(["uptime"])
    except subprocess.SubprocessError:
        return [], None
    loads_m = re.search(r"load averages?:\s*([0-9.]+)\s+([0-9.]+)\s+([0-9.]+)", text)
    loads = [num_or_none(x) for x in (loads_m.groups() if loads_m else [])]
    uptime_h = None
    m = re.search(r"up\s+(.+?),\s+\d+ user", text)
    if m:
        part = m.group(1)
        days = 0
        dm = re.search(r"(\d+)\s+day", part)
        if dm:
            days = int(dm.group(1))
        hm = re.search(r"(\d+):(\d+)", part)
        if hm or days:
            minutes = days * 1440 + (int(hm.group(1)) * 60 + int(hm.group(2)) if hm else 0)
            uptime_h = round(minutes / 60, 2)
    return loads, uptime_h


# --- linux --------------------------------------------------------------------


def read_file(path):
    with open(path, "r", encoding="utf-8") as fh:
        return fh.read()


def cpu_linux(sample_s=0.25):
    def ticks():
        fields = [float(x) for x in read_file("/proc/stat").splitlines()[0].split()[1:]]
        idle = fields[3] + (fields[4] if len(fields) > 4 else 0)  # idle + iowait
        return idle, sum(fields)
    try:
        idle1, total1 = ticks()
        time.sleep(sample_s)
        idle2, total2 = ticks()
    except OSError:
        return None
    didle, dtotal = idle2 - idle1, total2 - total1
    return None if dtotal <= 0 else round(100 * (dtotal - didle) / dtotal, 1)


def mem_linux():
    try:
        info = dict(
            (parts[0].rstrip(":"), int(parts[1]) * 1024)
            for parts in (line.split() for line in read_file("/proc/meminfo").splitlines())
            if len(parts) >= 2
        )
    except (OSError, ValueError, IndexError):
        return None, None
    total, avail = info.get("MemTotal"), info.get("MemAvailable", info.get("MemFree"))
    if not total or avail is None:
        return None, None
    return round(100 * (total - avail) / total, 1), round(total / 1048576)


def disk_df():
    # POSIX df (-P): one header line + one row for "/" → 1K-blocks, capacity %
    try:
        lines = run(["df", "-k", "-P", "/"]).splitlines()
        fields = lines[1].split()
        total_kb, cap = float(fields[1]), int(fields[4].rstrip("%"))
    except (subprocess.SubprocessError, IndexError, ValueError):
        return None, None
    return cap, round(total_kb / 1048576)


def load_uptime_linux():
    try:
        parts = read_file("/proc/loadavg").split()
        loads = [num_or_none(x) for x in parts[:3]]
        uptime_s = float(read_file("/proc/uptime").split()[0])
        return loads, round(uptime_s / 3600, 2)
    except (OSError, ValueError, IndexError):
        return [], None


# --- report -------------------------------------------------------------------


def detect_os(configured):
    if configured in ("darwin", "linux"):
        return configured
    system = platform.system().lower()
    return system if system in ("darwin", "linux") else None


def measure(host_os):
    if host_os == "darwin":
        cpu, (mem_pct, mem_mb) = cpu_darwin(), mem_darwin()
        disk_pct, disk_gb = disk_darwin()
        loads, uptime_h = load_uptime_darwin()
    else:
        cpu, (mem_pct, mem_mb) = cpu_linux(), mem_linux()
        disk_pct, disk_gb = disk_df()
        loads, uptime_h = load_uptime_linux()
    return {
        "name": None,  # filled by the caller from the config
        "cpuPct": cpu,
        "memPct": mem_pct,
        "memMB": mem_mb,
        "diskPct": disk_pct,
        "diskGB": disk_gb,
        "uptimeH": uptime_h,
        "load": [x for x in loads if x is not None],
    }


def check_service(service):
    # Tek seferlik takılma (ör. Supermemory takastan dönerken 10 sn+) yanlış "düştü"
    # alarmı üretmesin: başarısız denemeyi 5 sn sonra bir kez daha dene.
    r = _check_service_once(service)
    if r["status"] == "down":
        time.sleep(5)
        r2 = _check_service_once(service)
        if r2["status"] == "up":
            return r2
    return r


def _check_service_once(service):
    url = str(service.get("url") or "")
    started = time.monotonic()
    code, detail = None, None
    try:
        with urllib.request.urlopen(url, timeout=SERVICE_TIMEOUT_S) as resp:
            code = resp.status
    except urllib.error.HTTPError as e:
        code = e.code
        detail = f"HTTP {e.code}"
    except Exception as e:  # URLError, timeout, invalid URL…
        detail = str(e)[:DETAIL_MAX]
    ms = round((time.monotonic() - started) * 1000)
    ok = code is not None and 200 <= code < 400
    return {"name": str(service.get("name") or ""), "status": "up" if ok else "down", "ms": ms, "code": code, "detail": detail}


def build_report(config):
    host_cfg = config.get("host") or {}
    host_os = detect_os(host_cfg.get("os"))
    if not host_os:
        raise SystemExit("host-agent: config 'host.os' must be darwin or linux (or omit it for autodetect)")
    name = str(host_cfg.get("name") or "").strip()
    if not name:
        raise SystemExit("host-agent: config 'host.name' is required")
    host = measure(host_os)
    host["name"] = name
    services = [check_service(s) for s in (config.get("services") or []) if isinstance(s, dict)]
    return {"host": host, "services": services}


def send_report(report, url, token):
    body = json.dumps(report).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=body,
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {token}"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=SEND_TIMEOUT_S) as resp:
            print(f"host-agent: sent ({resp.status}) {resp.read(200).decode('utf-8', 'replace')}", flush=True)
    except urllib.error.HTTPError as e:
        print(f"host-agent: send failed HTTP {e.code}: {e.read(200).decode('utf-8', 'replace')}", flush=True)
        return False
    except Exception as e:
        print(f"host-agent: send failed: {e}", flush=True)
        return False
    return True


def load_config(path):
    if not path:
        raise SystemExit("host-agent: HOST_AGENT_CONFIG env var (path to the JSON config) is required")
    try:
        with open(path, "r", encoding="utf-8") as fh:
            return json.load(fh)
    except (OSError, ValueError) as e:
        raise SystemExit(f"host-agent: cannot read config {path}: {e}")


def main():
    parser = argparse.ArgumentParser(description="Send host resource reports to moon (Faz A).")
    parser.add_argument("--once", action="store_true", help="single measure+send cycle, then exit")
    parser.add_argument("--dry-run", action="store_true", help="print the report JSON, never send")
    args = parser.parse_args()

    config = load_config(os.environ.get("HOST_AGENT_CONFIG"))
    interval = max(30, int(config.get("interval") or 60))  # server drops reports <30s apart

    while True:
        report = build_report(config)
        if args.dry_run:
            print(json.dumps(report, indent=2))
        else:
            url = os.environ.get("MOON_REPORT_URL") or ""
            token = os.environ.get("MOON_SERVICE_TOKEN") or ""
            if not url or not token:
                raise SystemExit("host-agent: MOON_REPORT_URL and MOON_SERVICE_TOKEN env vars are required")
            send_report(report, url, token)
        if args.once or args.dry_run:
            break
        time.sleep(interval)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        sys.exit(0)
