"use client";

import { useState } from "react";

// Styles
import Styles from "./styles.module.scss";

const Avatar = ({ url, name, size = 32 }) => {
  const [failed, setFailed] = useState(false);
  // url yoksa (ör. herkese açık durum sayfası — URL sızdırmayız) doğrudan baş harf
  const src = url && !failed ? new URL("/favicon.ico", url).href : null;

  return (
    <span className={Styles.avatar} style={{ width: size, height: size, fontSize: size * 0.45 }}>
      {src ? <img src={src} alt="" onError={() => setFailed(true)} /> : name[0]?.toUpperCase()}
    </span>
  );
};

export default Avatar;
