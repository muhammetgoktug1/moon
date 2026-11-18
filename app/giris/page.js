"use client";

import { useState } from "react";
import Link from "next/link";

// Utils
import { sha256 } from "@/utils/sha256";

// Styles
import Styles from "./styles.module.scss";

const Giris = () => {
  const [eposta, setEposta] = useState("");
  const [parola, setParola] = useState("");
  const [hata, setHata] = useState("");
  const [bekle, setBekle] = useState(false);

  const gonder = async (e) => {
    e.preventDefault();
    setHata("");
    setBekle(true);
    try {
      const cevap = await fetch("/api/giris", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ eposta: eposta.trim().toLowerCase(), ozet: sha256(parola) }),
      });
      const sonuc = await cevap.json().catch(() => ({}));
      if (!cevap.ok) {
        setHata(sonuc.hata || "Giriş yapılamadı.");
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
        <p className={Styles.baslik}>Panele erişim için giriş yapın</p>

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
            <span className="label">Parola</span>
            <input
              type="password"
              autoComplete="current-password"
              required
              value={parola}
              onChange={(e) => setParola(e.target.value)}
            />
          </label>
          {hata && <p className={Styles.hata}>{hata}</p>}
          <button className={Styles.dugme} disabled={bekle}>
            {bekle ? "Giriş yapılıyor…" : "Giriş yap"}
          </button>
          <p className={Styles.bilgi}>
            Parola tarayıcıda SHA-256 özetine çevrilir; düz metin asla gönderilmez. Oturum 30 gün
            kullanılmadığında düşer.
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

export default Giris;
