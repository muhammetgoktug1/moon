"use client";

import { useState } from "react";
import Link from "next/link";

// Utils
import { sha256 } from "@/utils/sha256";

// Styles
import Styles from "./styles.module.scss";

const Login = () => {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      const response = await fetch("/api/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: email.trim().toLowerCase(), digest: sha256(password) }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) {
        setError(result.error || "Giriş yapılamadı.");
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
        <p className={Styles.title}>Panele erişim için giriş yapın</p>

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
            <span className="label">Parola</span>
            <input
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>
          {error && <p className={Styles.error}>{error}</p>}
          <button className={Styles.button} disabled={busy}>
            {busy ? "Giriş yapılıyor…" : "Giriş yap"}
          </button>
          <p className={Styles.info}>
            Parola tarayıcıda SHA-256 özetine çevrilir; düz metin asla gönderilmez. Oturum 30 gün
            kullanılmadığında düşer.
          </p>
        </form>

        <div className={Styles.footer}>
          <Link href="/status">Herkese açık durum sayfası</Link>
          <span>moon</span>
        </div>
      </div>
    </main>
  );
};

export default Login;
