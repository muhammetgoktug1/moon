import { useEffect } from "react";

// Store
import useLiveStore from "@/store/useLiveStore";

// Utils
import { getSocket } from "@/utils/socket";

let bound = false;

// Wires the socket into useLiveStore once per page load; later calls do nothing.
const bind = () => {
  if (bound) return;
  bound = true;

  const socket = getSocket();
  const { setMonitors, setGroups, setConnected, addCheck, setHosts } = useLiveStore.getState();
  const load = () => {
    setConnected(true);
    socket.emit("list", setMonitors);
    socket.emit("groups", setGroups);
    socket.emit("hosts", setHosts); // Faz A: oturum yoksa sunucu hata döner → bölüm gizli
  };

  if (socket.connected) load();
  socket.on("connect", load);
  socket.on("disconnect", () => setConnected(false));
  socket.on("monitors", setMonitors);
  socket.on("groups", setGroups);
  socket.on("check", addCheck);
  socket.on("hosts", setHosts); // yeni host raporu yazılınca canlı itilir
};

const useLiveSync = () => {
  useEffect(bind, []);
};

export default useLiveSync;
