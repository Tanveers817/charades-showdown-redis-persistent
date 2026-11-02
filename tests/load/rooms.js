import { check, sleep } from "k6";
import { io } from "k6/experimental/websockets";

export const options = {
  scenarios: {
    socket_connections: {
      executor: "constant-vus",
      vus: Number(__ENV.VUS || 40),
      duration: __ENV.DURATION || "30s"
    }
  },
  thresholds: {
    checks: ["rate>0.99"]
  }
};

export default function () {
  const url = __ENV.WS_URL || "ws://localhost:3001/socket.io/?EIO=4&transport=websocket";
  const socket = io.connect(url, {}, ws => {
    ws.on("open", () => check(ws, { "socket opens": s => s.readyState === 1 }));
    ws.on("error", () => check(false, { "socket error": () => false }));
    ws.setTimeout(() => ws.close(), 1500);
  });
  sleep(1);
}
