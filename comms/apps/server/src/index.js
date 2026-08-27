import { createServer } from "node:http";
import { networkInterfaces } from "node:os";
import { resolve } from "node:path";
import { openDatabase } from "./db.js";
import { createRequestHandler } from "./http.js";
import { Hub } from "./realtime.js";

/**
 * Entry point for the office relay.
 *
 * One small Node process serves the REST API, the WebSocket hub and file
 * transfer. Run it on any always-on machine in the office; every client
 * points at its LAN address.
 */
export function createApp({ dataDir, allowOrigin } = {}) {
  const dir = resolve(dataDir || process.env.COMMS_DATA || "./comms-data");
  const db = openDatabase(dir === ":memory:" ? ":memory:" : resolve(dir, "comms.db"));
  const hub = new Hub(db);
  const server = createServer(createRequestHandler({ db, dataDir: dir, hub, allowOrigin }));

  server.on("upgrade", (req, socket, head) => hub.handleUpgrade(req, socket, head));
  hub.startHeartbeat();

  const close = () =>
    new Promise((done) => {
      hub.close();
      server.close(() => {
        db.close();
        done();
      });
    });

  return { server, db, hub, dataDir: dir, close };
}

/** Best-effort LAN address so the operator knows what to type into clients. */
function lanAddresses() {
  const out = [];
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === "IPv4" && !entry.internal) out.push(entry.address);
    }
  }
  return out;
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop());

if (isMain) {
  const port = Number(process.env.PORT || 8787);
  const host = process.env.HOST || "0.0.0.0";
  const app = createApp();

  app.server.listen(port, host, () => {
    console.log(`Wrait Comms relay listening on ${host}:${port}`);
    console.log(`  data:  ${app.dataDir}`);
    for (const address of lanAddresses()) {
      console.log(`  point clients at:  http://${address}:${port}`);
    }
  });

  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, async () => {
      await app.close();
      process.exit(0);
    });
  }
}
