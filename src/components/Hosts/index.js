"use client";

import useLiveStore from "@/store/useLiveStore";
import useNow from "@/hooks/useNow";

// Utils
import { hostsSection, barTone, fmtUptimeH } from "@/lib/hosts";

// Styles
import Styles from "./styles.module.scss";

// Panel "Hosts" bölümü: host-agent.py'den gelen son kaynak raporlarının kartları.
// Rapor yoksa bölüm TAMAMEN gizlenir (boş durum yok); bayat rapor (>10 dk) amber.
// Adlar veriden gelir; /status herkese açık sayfasında bu bölüm ASLA render edilmez.
const Hosts = () => {
  const hosts = useLiveStore((s) => s.hosts);
  const now = useNow();
  const cards = hostsSection(hosts, now);
  if (!cards) return null;

  return (
    <section className={Styles.section} aria-label="Hosts">
      <div className={Styles.head}>
        <h2>Hosts</h2>
        <span className={`label ${Styles.hint}`}>resource reports · refreshed by the host agent</span>
      </div>
      <div className={Styles.grid}>
        {cards.map((c) => (
          <article key={c.name} className={`panel ${Styles.card}`}>
            <header className={Styles.cardHead} data-stale={c.stale ? "true" : undefined}>
              <i className="lamp" data-tone={c.stale ? "warn" : "up"} />
              <strong>{c.name}</strong>
              {c.stale && <span className={Styles.stale}>stale report</span>}
            </header>

            <div className={Styles.bars}>
              {c.bars.map((b) => (
                <div key={b.key} className={Styles.barRow}>
                  <span className="label">
                    {b.label}
                    {b.sub ? <small className={Styles.sub}> · {b.sub}</small> : null}
                  </span>
                  <span className={Styles.bar} aria-hidden="true">
                    <i style={{ width: `${b.pct ?? 0}%` }} data-tone={barTone(b.pct)} />
                  </span>
                  <span className={Styles.pct} data-tone={barTone(b.pct)}>
                    {b.pct == null ? "—" : `${b.pct}%`}
                  </span>
                </div>
              ))}
            </div>

            <div className={Styles.meta}>
              <span className="label">
                Load <b>{c.load.length ? c.load.join(" ") : "—"}</b>
              </span>
              <span className="label">
                Uptime <b>{fmtUptimeH(c.uptimeH)}</b>
              </span>
            </div>

            {!!c.services.length && (
              <ul className={Styles.services}>
                {c.services.map((s) => (
                  <li key={s.name} data-tone={s.status}>
                    <i className="lamp" data-tone={s.status} />
                    {s.name}
                  </li>
                ))}
              </ul>
            )}

            {c.lastAlert && <p className={Styles.lastAlert}>{c.lastAlert.text}</p>}
          </article>
        ))}
      </div>
    </section>
  );
};

export default Hosts;
