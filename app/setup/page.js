"use client";

import { useState } from "react";
import Link from "next/link";

// Utils
import { sha256 } from "@/utils/sha256";

// Styles
import Styles from "../login/styles.module.scss";

const Setup = () => {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [password2, setPassword2] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setError("");
    if (password.length < 8) return setError("Parola en az 8 karakter olmalı.");
    if (password !== password2) return setError("Parolalar eşleşmiyor.");
    setBusy(true);
    try {
      const response = await fetch("/api/setup", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: email.trim().toLowerCase(), digest: sha256(password) }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) {
        setError(result.error || "Kurulum yapılamadı.");
        return;
      }
      window.location.assign("/");
    } catch {
      setError("Sunucuya ulaşılamadı.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className={`wrap ${Styles.wrap}`}>
      <div className={Styles.box}>
        <div className={Styles.logoRow}>☾ moon</div>
        <p className={Styles.title}>İlk açılış kurulumu</p>

        <form className={`panel ${Styles.form}`} onSubmit={submit}>
          <label className={Styles.field}>
            <span className="label">E-posta</span>
            <input
              type="email"
              autoComplete="username"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </label>
          <label className={Styles.field}>
            <span className="label">Parola (en az 8 karakter)</span>
            <input
              type="password"
              autoComplete="new-password"
              required
              minLength={8}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>
          <label className={Styles.field}>
            <span className="label">Parola (tekrar)</span>
            <input
              type="password"
              autoComplete="new-password"
              required
              value={password2}
              onChange={(e) => setPassword2(e.target.value)}
            />
          </label>
          {error && <p className={Styles.error}>{error}</p>}
          <button className={Styles.button} disabled={busy}>
            {busy ? "Hesap açılıyor…" : "Yönetici hesabını aç"}
          </button>
          <p className={Styles.info}>
            Kullanıcı tablosu boşken bu sayfa açıktır. Oluşturulan ilk hesap yönetici olur ve kayıt
            hemen kapanır — daha sonra yeni hesap açılamaz. Parola tarayıcıda SHA-256 özetine
            çevrilir, sunucuda bcrypt ile saklanır.
          </p>
        </form>

        <div className={Styles.footer}>
          <Link href="/status">Herkese açık durum sayfası</Link>
          <span>moon · sistem.com</span>
        </div>
      </div>
    </main>
  );
};

export default Setup;
