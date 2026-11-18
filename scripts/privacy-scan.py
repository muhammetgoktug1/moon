#!/usr/bin/env python3
"""Gizlilik taraması — push öncesi diff kanıtı (Faz A).

Repo herkese açık olduğu için İNŞA/DEĞİŞTİRÜLEN satırlarda alan adı, IP, port,
ev dizini izi olmamalı. Bu betik `git diff <base>...<head>` içindeki EKLENEN
satırları tarar ve izin listesi dışında bir şey bulursa kırmızı çıkar.

Kullanım:
  python3 scripts/privacy-scan.py                 # base = origin/develop
  python3 scripts/privacy-scan.py origin/main     # başka base

İzin listesi (bilinçli):
  - example.com / example.net / example.org / localhost (sentetik fikstürler)
  - 127.0.0.1, 0.0.0.0 (loopback), RFC 5737 test ağları (192.0.2.x,
    198.51.100.x, 203.0.113.x), 1.1.1.1/8.8.8.8 (genel DNS sabitleri)
  - bilinen varsayılan portlar (80, 443, 3000, 8080, 27017) ve IANA özel
    aralığı (>= 49152) — sentetik fikstür portları
Gerçek adlar repoda bulunmadığı için betik kendisi ek desen İÇERMEZ; makineye
özel desenler çalıştırma anında `PRIVACY_EXTRA_PATTERNS` env'iyle verilir
(virgülle ayrılmış regex listesi; örn. gerçek alan adı, kullanıcı adı).
"""

import os
import re
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

DOMAIN_ALLOW = {"example.com", "example.net", "example.org", "localhost"}
IP_ALLOW = {"127.0.0.1", "0.0.0.0", "255.255.255.255", "1.1.1.1", "8.8.8.8"}
TEST_NETS = re.compile(r"^(192\.0\.2|198\.51\.100|203\.0\.113)\.")
PORT_DEFAULTS = {80, 443, 3000, 8080, 27017}
SKIP_FILES = ("package-lock.json",)

IP_RE = re.compile(r"\b(?:\d{1,3}\.){3}\d{1,3}\b")
DOMAIN_RE = re.compile(
    r"\b(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+"
    r"(?:com|net|org|io|dev|app|tr|co|me|sh|xyz|cloud|tech|systems|network|info|biz|site|online|store)\b",
    re.IGNORECASE,
)
PORT_RE = re.compile(r":(\d{2,5})\b")
HOME_RE = re.compile(r"~/|/Users/[A-Za-z]")


def git(*args):
    proc = subprocess.run(["git", "-C", ROOT, *args], capture_output=True, text=True)
    if proc.returncode != 0:
        sys.exit(f"git hatası: {' '.join(args)}\n{proc.stderr.strip()}")
    return proc.stdout


def added_lines(base):
    diff = git("diff", "--unified=0", f"{base}...HEAD")
    file_name = None
    for line in diff.splitlines():
        if line.startswith("+++ b/"):
            file_name = line[6:]
        elif line.startswith("+") and not line.startswith("+++"):
            if file_name and not file_name.endswith(SKIP_FILES):
                yield file_name, line[1:]


def ip_ok(ip):
    return ip in IP_ALLOW or bool(TEST_NETS.match(ip))


def scan(base, extra_patterns):
    findings = []
    scanned = 0
    for file_name, text in added_lines(base):
        scanned += 1
        for ip in IP_RE.findall(text):
            if not ip_ok(ip):
                findings.append((file_name, "IP", ip, text.strip()[:120]))
        for domain in DOMAIN_RE.findall(text):
            if domain.lower() not in DOMAIN_ALLOW:
                findings.append((file_name, "alan adi", domain, text.strip()[:120]))
        for port in PORT_RE.findall(text):
            if int(port) not in PORT_DEFAULTS and int(port) < 49152:
                findings.append((file_name, "port", ":" + port, text.strip()[:120]))
        home = HOME_RE.search(text)
        if home:
            findings.append((file_name, "ev dizini", home.group(0), text.strip()[:120]))
        for pattern in extra_patterns:
            if re.search(pattern, text, re.IGNORECASE):
                findings.append((file_name, "ek desen", pattern, text.strip()[:120]))
    return scanned, findings


def main():
    base = sys.argv[1] if len(sys.argv) > 1 else "origin/develop"
    extra = [p for p in os.environ.get("PRIVACY_EXTRA_PATTERNS", "").split(",") if p.strip()]
    git("rev-parse", "--verify", base)  # base yoksa erken hata
    scanned, findings = scan(base, extra)
    print(f"taranan eklenen satir: {scanned} (base: {base})")
    print(f"izin listesi: alan adi={sorted(DOMAIN_ALLOW)} ip=loopback+RFC5737+genel-DNS port={sorted(PORT_DEFAULTS)}+>=49152")
    if extra:
        print(f"ek desen sayisi: {len(extra)}")
    if findings:
        print(f"\nBULGU: {len(findings)} eslesme")
        for file_name, kind, what, line in findings:
            print(f"  {file_name} [{kind}] {what} :: {line}")
        sys.exit(1)
    print("\nSONUC: 0 eslesme — diff temiz")


if __name__ == "__main__":
    main()
