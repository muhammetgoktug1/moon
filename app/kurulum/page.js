"use client";

import { useState } from "react";
import Link from "next/link";

// Utils
import { sha256 } from "@/utils/sha256";

// Styles
import Styles from "../giris/styles.module.scss";

const Kurulum = () => {
  const [eposta, setEposta] = useState("");
  const [parola, setParola] = useState("");
  const [parola2, setParola2] = useState("");
  const [hata, setHata] = useState("");
  const [bekle, setBekle] = useState(false);

  const gonder = async (e) => {
    e.preventDefault();
    setHata("");
    if (parola.length < 8) return setHata("Parola en az 8 karakter olmalı.");
    if (parola !== parola2) return setHata("Parolalar eşleşmiyor.");
    setBekle(true);
    try {
      const cevap = await fetch("/api/kurulum", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ eposta: eposta.trim().toLowerCase(), ozet: sha256(parola) }),
      });
      const sonuc = await cevap.json().catch(() => ({}));
      if (!cevap.ok) {
        setHata(sonuc.hata || "Kurulum yapılamadı.");
        return;
      }
      window.location.assign("/");
    } catch {
      setHata("Sunucuya ulaşılamadı.");
    } finally {
      setBekle(false);
    }
  };

  return (
    <main className={`wrap ${Styles.wrap}`}>
      <div className={Styles.kutu}>
        <div className={Styles.logoSatiri}>☾ moon</div>
        <p className={Styles.baslik}>İlk açılış kurulumu</p>

        <form className={`panel ${Styles.form}`} onSubmit={gonder}>
          <label className={Styles.alan}>
            <span className="label">E-posta</span>
            <input
              type="email"
              autoComplete="username"
              required
              value={eposta}
              onChange={(e) => setEposta(e.target.value)}
            />
          </label>
          <label className={Styles.alan}>
            <span className="label">Parola (en az 8 karakter)</span>
            <input
              type="password"
              autoComplete="new-password"
              required
              minLength={8}
              value={parola}
              onChange={(e) => setParola(e.target.value)}
            />
          </label>
          <label className={Styles.alan}>
            <span className="label">Parola (tekrar)</span>
            <input
              type="password"
              autoComplete="new-password"
              required
              value={parola2}
              onChange={(e) => setParola2(e.target.value)}
            />
          </label>
          {hata && <p className={Styles.hata}>{hata}</p>}
          <button className={Styles.dugme} disabled={bekle}>
            {bekle ? "Hesap açılıyor…" : "Yönetici hesabını aç"}
          </button>
          <p className={Styles.bilgi}>
            Kullanıcı tablosu boşken bu sayfa açıktır. Oluşturulan ilk hesap yönetici olur ve kayıt
            hemen kapanır — daha sonra yeni hesap açılamaz. Parola tarayıcıda SHA-256 özetine
            çevrilir, sunucuda bcrypt ile saklanır.
          </p>
        </form>

        <div className={Styles.alt}>
          <Link href="/status">Herkese açık durum sayfası</Link>
          <span>moon · sistem.com</span>
        </div>
      </div>
    </main>
  );
};

export default Kurulum;
