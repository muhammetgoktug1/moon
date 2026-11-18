#!/usr/bin/env python3
"""Bozma (mutation) testleri — Faz A host kaynak izleme.

Her bozma kaynaktaki bir güvenlik/kritik satırı geçici olarak bozar, `npm test`
kırmızı çıkmalıdır (test o bozmayı YAKALAMALI), sonra dosya geri yüklenir.
Sonunda ağaç temiz + tests yeşil doğrulanır. Çıktı: her bozma için
YAKALANDI/KAÇTI + özet. 0 kaçılmış bozma = başarılı.

Kullanım: python3 scripts/bozma-host.py            (tüm bozmalar)
          python3 scripts/bozma-host.py 1 3        (sadece 1. ve 3. bozma)
"""

import pathlib
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent

# (ad, dosya, birebir eski metin, bozumalı yeni metin)
MUTATIONS = [
    (
        "host-report uçunda token denetimi kaldırıldı (401 gitti)",
        "lib/hostReport.js",
        'if (String(req.headers.authorization || "") !== `Bearer ${token}`) {',
        "if (false) { // BOZMA: token denetimi",
    ),
    (
        "eksik host.name kabul ediliyor (400 gitti)",
        "lib/hostReport.js",
        'if (!name) throw new ValidationError("host.name is required.");',
        "if (false) throw new ValidationError(\"host.name is required.\"); // BOZMA",
    ),
    (
        "30 sn aralık kuralı yok sayıldı (eski rapor ezilir)",
        "lib/hostReport.js",
        "if (existing && Date.now() - new Date(existing.at).getTime() < HOST_MIN_INTERVAL_S * 1000) return false;",
        "if (false) return false; // BOZMA: aralık",
    ),
    (
        "/status herkese açık verisine hosts sızmaya başladı",
        "lib/statusPage.js",
        "const data = { groups, services };",
        'const data = { groups, services, hosts: ["host-alpha"] }; // BOZMA: sızıntı',
    ),
    (
        "panel Hosts bölümü veri yokken de render ediliyor (boş durum)",
        "lib/hosts.js",
        "if (!Array.isArray(hosts) || !hosts.length) return null;",
        "if (!Array.isArray(hosts) || !hosts.length) return []; // BOZMA: boş durum",
    ),
]


def run_tests():
    proc = subprocess.run(
        ["npm", "test"],
        cwd=ROOT,
        capture_output=True,
        text=True,
        timeout=600,
    )
    return proc.returncode, proc.stdout + proc.stderr


def main():
    picked = [int(a) for a in sys.argv[1:] if a.isdigit()] or None
    results = []
    originals = {}
    for index, (name, rel, old, new) in enumerate(MUTATIONS, start=1):
        if picked and index not in picked:
            continue
        path = ROOT / rel
        original = path.read_text(encoding="utf-8")
        originals[str(path)] = original
        if old not in original:
            results.append((index, name, "BULUNAMADI", f"{rel} içinde bozma metni yok"))
            continue
        path.write_text(original.replace(old, new, 1), encoding="utf-8")
        try:
            code, output = run_tests()
            caught = code != 0
            # kırmızı sebebi bozmada olmalı — özet satırını yakala
            summary = [line for line in output.splitlines() if line.startswith("ℹ fail") or "failing tests" in line]
            detail = summary[0].strip() if summary else ("fail!=0" if caught else "tests yeşil kaldı")
            results.append((index, name, "YAKALANDI" if caught else "KAÇTI", detail))
        finally:
            path.write_text(original, encoding="utf-8")

    print(f"{'#':<3} {'sonuç':<10} bozma")
    missed = 0
    for index, name, status, detail in results:
        print(f"{index:<3} {status:<10} {name}  [{detail}]")
        if status != "YAKALANDI":
            missed += 1

    # restorasyon: her bozulan dosya özgün içeriğine dönmüş mü (içerik karşılaştırması;
    # git status yeni dosyalarda "??" verip yanlış alarm ürettiği için kullanılmaz)
    restored = all(pathlib.Path(p).read_text(encoding="utf-8") == t for p, t in originals.items())
    code, _ = run_tests()
    print(f"\nrestorasyon: {'TEMIZ' if restored else 'KIRLI: icerik farki var'}")
    print(f"son tests:   {'YESIL' if code == 0 else 'KIRMIZI'}")
    ok = missed == 0 and restored and code == 0
    print(f"ozet: {len(results)} bozma, {missed} kacti -> {'BASARI' if ok else 'HATA'}")
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
