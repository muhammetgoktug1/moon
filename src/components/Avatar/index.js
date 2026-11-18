"use client";

import { useState } from "react";

// Utils
import { initial } from "@/utils/name";

// Styles
import Styles from "./styles.module.scss";

// Favicon adresi monitör URL'sinden türetilir: daima https (http origin, https
// uygulamada karma içerik olurdu) ve yalnız URL geçerliyse; ayrışmazsa ya da
// yüklenmezse baş-harf avatarına düşülür.
const faviconSrc = (url) => {
  if (!url) return null;
  try {
    const u = new URL("/favicon.ico", url);
    u.protocol = "https:";
    return u.href;
  } catch {
    return null;
  }
};

const Avatar = ({ url, name, size = 32 }) => {
  const [failed, setFailed] = useState(false);
  // url yoksa (ör. herkese açık durum sayfası — URL sızdırmayız) doğrudan baş harf
  const src = failed ? null : faviconSrc(url);

  return (
    <span className={Styles.avatar} style={{ width: size, height: size, fontSize: size * 0.45 }}>
      {src ? <img src={src} alt="" onError={() => setFailed(true)} /> : initial(name)}
    </span>
  );
};

export default Avatar;
