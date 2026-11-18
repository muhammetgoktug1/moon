#!/usr/bin/env python3
"""Bozma (mutation) testleri — Faz 2b host-servis WhatsApp bildirimi.

Her bozma lib/hostAlerts.js içindeki bir kural satırını geçici olarak bozar,
`npm test` KIRMIZI çıkmalıdır (testler bozmayı YAKALAMALI), sonra dosya geri
yüklenir. Sonunda ağaç temiz + tests yeşil doğrulanır. Çıktı: her bozma için
YAKALANDI/KAÇTI + özet. 0 kaçılmış bozma = başarılı.

Kullanım: python3 scripts/bozma-host-uyari.py            (tüm bozmalar)
          python3 scripts/bozma-host-uyari.py 1 3        (sadece 1. ve 3. bozma)
"""

import pathlib
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent

# (ad, dosya, birebir eski metin, bozumalı yeni metin)
MUTATIONS = [
    (
        "up→down geçişi yutuluyor (DÜŞTÜ mesajı gitmiyor)",
        "lib/hostAlerts.js",
        'if (!before || before.status === "up") downs.push({ name: s.name, detail: s.detail || "" });',
        'if (false) downs.push({ name: s.name, detail: s.detail || "" }); // BOZMA: down yutuldu',
    ),
    (
        "rapordan çıkan servis için DÜŞTÜ mesajı üretiliyor (sessiz kural yok)",
        "lib/hostAlerts.js",
        "return { downs, ups, removed };",
        'return { downs: [...downs, ...removed.map((name) => ({ name, detail: "" }))], ups, removed: [] }; // BOZMA',
    ),
    (
        "down→up geçişi yutuluyor (TOPARLANDI mesajı gitmiyor)",
        "lib/hostAlerts.js",
        "} else if (before && before.status === \"down\") {",
        "} else if (false) { // BOZMA: up yutuldu",
    ),
    (
        "eksik-rapor uyarısı her taramada TEKRARLANIYOR (tek sefer kuralı yok)",
        "lib/hostAlerts.js",
        "for (const doc of await HostReport.find({ missedAlerts: { $ne: true } }).lean()) {",
        "for (const doc of await HostReport.find({}).lean()) { // BOZMA: tekrar",
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
