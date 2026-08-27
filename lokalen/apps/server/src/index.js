import { createServer } from "node:http";
import { networkInterfaces } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { openDatabase } from "./db.js";
import { setSetting, getSetting, officeInfo } from "./store.js";
import { createRequestHandler } from "./http.js";
import { Hub } from "./realtime.js";

/**
 * Entry point for the office relay.
 *
 * One small Node process serves the REST API, the WebSocket hub and file
 * transfer. Run it on any always-on machine in the office; every client
 * points at its LAN address.
 */
export function createApp({ dataDir, allowOrigin, mode, officeName } = {}) {
  const dir = resolve(dataDir || process.env.COMMS_DATA || "./comms-data");
  const db = openDatabase(dir === ":memory:" ? ":memory:" : resolve(dir, "comms.db"));
  // Mode is fixed the first time an office is created, then remembered, so a
  // restart cannot silently drop an office from passworded to open.
  if (!getSetting(db, "office_mode")) {
    const configured = mode ?? process.env.OFFICE_MODE;
    setSetting(db, "office_mode", configured === "password" ? "password" : "open");
  }
  if (!getSetting(db, "office_name")) {
    setSetting(db, "office_name", officeName ?? process.env.OFFICE_NAME ?? "Lokalen");
  }

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

// Comparing file URLs rather than string-matching the path: on Windows
// process.argv[1] is a backslash path, which no amount of "/" splitting will
// line up against import.meta.url.
const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  const port = Number(process.env.PORT || 8787);
  const host = process.env.HOST || "0.0.0.0";
  const app = createApp();

  app.server.listen(port, host, () => {
    const office = officeInfo(app.db);
    console.log(`Lokalen-relä lyssnar på ${host}:${port}`);
    console.log(`  kontor:  ${office.name} (${office.mode === "open" ? "öppet - bara namn" : "kräver konto"})`);
    console.log(`  data:    ${app.dataDir}`);
    for (const address of lanAddresses()) {
      console.log(`  anslut till:  http://${address}:${port}`);
    }
  });

  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, async () => {
      await app.close();
      process.exit(0);
    });
  }
}
