import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes, createHash } from "node:crypto";
import WebSocket from "ws";
import { createApp } from "../src/index.js";
import { CHUNK_SIZE, chunkCountFor } from "@comms/protocol";

let app, base, wsBase, dataDir;

before(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "comms-test-"));
  app = createApp({ dataDir });
  await new Promise((done) => app.server.listen(0, "127.0.0.1", done));
  const { port } = app.server.address();
  base = `http://127.0.0.1:${port}`;
  wsBase = `ws://127.0.0.1:${port}/ws`;
});

after(async () => {
  await app.close();
  await rm(dataDir, { recursive: true, force: true });
});

const api = (path, options = {}) =>
  fetch(base + path, {
    ...options,
    method: options.method || (options.body ? "POST" : "GET"),
    headers: {
      ...(options.body && !options.raw ? { "content-type": "application/json" } : {}),
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      ...options.headers,
    },
    body: options.raw ? options.body : options.body ? JSON.stringify(options.body) : undefined,
  });

/** Opens a socket and resolves once the server has sent `ready`. */
function connect(token) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${wsBase}?token=${token}`);
    const queue = [];
    const waiters = [];
    ws.on("message", (raw) => {
      const event = JSON.parse(raw.toString());
      const waiter = waiters.findIndex((w) => w.match(event));
      if (waiter >= 0) waiters.splice(waiter, 1)[0].resolve(event);
      else queue.push(event);
    });
    ws.on("error", reject);
    /**
     * Waits for the next event matching `type` and an optional predicate,
     * checking anything already buffered first. The predicate matters because
     * a broadcast fans out to everyone: a test watching for one person going
     * offline must not latch onto somebody else's presence event.
     */
    ws.next = (type, where = () => true, timeout = 3000) => {
      const match = (e) => e.t === type && where(e);
      return new Promise((res, rej) => {
        const found = queue.findIndex(match);
        if (found >= 0) return res(queue.splice(found, 1)[0]);
        const timer = setTimeout(() => rej(new Error(`timed out waiting for "${type}"`)), timeout);
        waiters.push({ match, resolve: (e) => { clearTimeout(timer); res(e); } });
      });
    };
    ws.on("open", async () => {
      ws.ready = await ws.next("ready");
      resolve(ws);
    });
  });
}

const send = (ws, event) => ws.send(JSON.stringify(event));

/** Closes sockets and waits for the server to observe it. */
const shut = (...sockets) =>
  Promise.all(sockets.map((ws) => new Promise((done) => { ws.on("close", done); ws.close(); })));

let alice, bob, carol;

test("registers accounts and rejects bad input", async () => {
  const res = await api("/api/register", {
    body: { username: "alice", displayName: "Alice Nakamura", password: "correct-horse" },
  });
  assert.equal(res.status, 201);
  alice = await res.json();
  assert.equal(alice.user.username, "alice");
  assert.equal(alice.user.initials, "AN", "monogram is derived from the display name");
  assert.ok(alice.token);

  bob = await (await api("/api/register", {
    body: { username: "bob", displayName: "Bob Ortiz", password: "hunter2hunter2" },
  })).json();
  carol = await (await api("/api/register", {
    body: { username: "carol", displayName: "Carol Vance", password: "passphrase123" },
  })).json();

  const dupe = await api("/api/register", {
    body: { username: "ALICE", displayName: "Impostor", password: "whatever12" },
  });
  assert.equal(dupe.status, 409, "usernames are case-insensitively unique");

  const weak = await api("/api/register", {
    body: { username: "dave", displayName: "Dave", password: "short" },
  });
  assert.equal(weak.status, 400);
});

test("logs in and rejects a wrong password", async () => {
  const ok = await api("/api/login", { body: { username: "alice", password: "correct-horse" } });
  assert.equal(ok.status, 200);
  assert.ok((await ok.json()).token);

  const bad = await api("/api/login", { body: { username: "alice", password: "wrong-password" } });
  assert.equal(bad.status, 401);

  const missing = await api("/api/login", { body: { username: "nobody", password: "wrong-password" } });
  assert.equal(missing.status, 401, "an unknown account is indistinguishable from a bad password");
});

test("rejects an unauthenticated socket", async () => {
  await assert.rejects(connect("not-a-real-token"));
});

test("delivers a chat message with an alert, and acks the sender", async () => {
  const a = await connect(alice.token);
  const b = await connect(bob.token);

  assert.ok(a.ready.users.some((u) => u.username === "bob"), "roster lists the office directory");

  send(a, { t: "send", clientId: "c-1", to: bob.user.id, body: "Standup in five?", alert: true });

  const received = await b.next("message");
  assert.equal(received.message.body, "Standup in five?");
  assert.equal(received.message.from, alice.user.id);
  assert.equal(received.message.alert, true, "the alert flag reaches the recipient so it can play a sound");

  const ack = await a.next("ack");
  assert.equal(ack.clientId, "c-1", "the sender can reconcile its optimistic copy");
  assert.equal(ack.message.id, received.message.id);

  await shut(a, b);
});

test("relays a nudge and a typing indicator", async () => {
  const a = await connect(alice.token);
  const b = await connect(bob.token);

  send(a, { t: "typing", to: bob.user.id });
  assert.equal((await b.next("typing")).from, alice.user.id);

  send(a, { t: "nudge", to: bob.user.id });
  assert.equal((await b.next("nudge")).from, alice.user.id);

  await shut(a, b);
});

test("broadcasts presence when someone connects and disconnects", async () => {
  // A fresh account guarantees a genuine offline -> online transition; a user
  // who already has a socket open produces no broadcast, by design.
  const dana = await (await api("/api/register", {
    body: { username: "dana", displayName: "Dana Reyes", password: "danapassword" },
  })).json();

  const a = await connect(alice.token);
  const d = await connect(dana.token);

  const online = await a.next("presence", (e) => e.userId === dana.user.id);
  assert.equal(online.presence, "online");

  await shut(d);
  const offline = await a.next("presence", (e) => e.userId === dana.user.id);
  assert.equal(offline.presence, "offline");
  assert.ok(offline.lastSeen, "the roster can show when they were last around");

  await shut(a);
});

test("transfers a file in chunks and guards who may download it", async () => {
  // Deliberately larger than one chunk so the offset writes are exercised.
  const payload = randomBytes(CHUNK_SIZE + 1234);
  const digest = createHash("sha256").update(payload).digest("hex");

  const init = await (await api("/api/files/init", {
    token: alice.token,
    body: { name: "quarterly.pdf", size: payload.length, mime: "application/pdf", to: bob.user.id },
  })).json();

  assert.equal(init.chunkSize, CHUNK_SIZE);
  const total = chunkCountFor(payload.length);
  assert.equal(total, 2);

  // Upload out of order to prove chunks are placed by offset, not appended.
  for (const index of [1, 0]) {
    const slice = payload.subarray(index * CHUNK_SIZE, (index + 1) * CHUNK_SIZE);
    const res = await api(`/api/files/${init.fileId}/chunk?index=${index}`, {
      method: "PUT",
      token: alice.token,
      raw: true,
      body: slice,
      headers: { "content-type": "application/octet-stream" },
    });
    assert.equal(res.status, 200);
    const state = await res.json();
    if (index === 0) assert.equal(state.complete, true, "completes once every chunk has landed");
  }

  const b = await connect(bob.token);
  const a = await connect(alice.token);
  send(a, {
    t: "send", clientId: "c-file", to: bob.user.id, body: "Here's the report",
    attachment: { fileId: init.fileId },
  });

  const message = (await b.next("message")).message;
  assert.equal(message.attachment.name, "quarterly.pdf");
  assert.equal(message.attachment.size, payload.length);

  const download = await api(`/api/files/${init.fileId}`, { token: bob.token });
  assert.equal(download.status, 200);
  const bytes = Buffer.from(await download.arrayBuffer());
  assert.equal(bytes.length, payload.length);
  assert.equal(createHash("sha256").update(bytes).digest("hex"), digest, "bytes survive the round trip intact");

  const intruder = await api(`/api/files/${init.fileId}`, { token: carol.token });
  assert.equal(intruder.status, 403, "a third party cannot fetch a file they were not sent");

  const anonymous = await api(`/api/files/${init.fileId}`);
  assert.equal(anonymous.status, 401);

  await shut(a, b);
});

test("refuses an attachment the sender does not own", async () => {
  const init = await (await api("/api/files/init", {
    token: alice.token,
    body: { name: "secret.txt", size: 4, mime: "text/plain", to: bob.user.id },
  })).json();

  const hijack = await api(`/api/files/${init.fileId}/chunk?index=0`, {
    method: "PUT", token: carol.token, raw: true, body: Buffer.from("evil"),
    headers: { "content-type": "application/octet-stream" },
  });
  assert.equal(hijack.status, 403, "only the uploader may write chunks");

  const c = await connect(carol.token);
  send(c, { t: "send", clientId: "x", to: bob.user.id, body: "steal", attachment: { fileId: init.fileId } });
  assert.equal((await c.next("error")).code, "bad_attachment");
  await shut(c);
});

test("marks messages read and tells the sender", async () => {
  const a = await connect(alice.token);
  const b = await connect(bob.token);
  send(a, { t: "send", clientId: "c-read", to: bob.user.id, body: "ping" });
  const message = (await b.next("message")).message;

  send(b, { t: "read", withUser: alice.user.id, upTo: message.sentAt });
  const receipt = await a.next("read");
  assert.equal(receipt.from, bob.user.id);

  await shut(a, b);
});
