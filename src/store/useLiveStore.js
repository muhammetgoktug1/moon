import { create } from "zustand";

// Utils
import { RECENT } from "@/lib/stats";

// Monitors and tabs as the server last sent them, kept live over socket.io (see useLiveSync).
// Faz A: `hosts` — host-agent.py kaynak raporlarının son hâli (yalnız oturumlu panel).
const useLiveStore = create((set) => ({
  monitors: [],
  groups: [],
  hosts: [],
  loaded: false,
  connected: false,

  setMonitors: (monitors) => set({ monitors, loaded: true }),
  setGroups: (groups) => set({ groups }),
  setHosts: (hosts) => set({ hosts: Array.isArray(hosts) ? hosts : [] }),
  setConnected: (connected) => set({ connected }),

  // a new check for one monitor; only the latest RECENT are kept
  addCheck: ({ id, check, cert }) =>
    set((state) => ({
      monitors: state.monitors.map((m) =>
        m.id === id ? { ...m, cert: cert || m.cert, checks: [...m.checks, check].slice(-RECENT) } : m,
      ),
    })),
}));

export default useLiveStore;
