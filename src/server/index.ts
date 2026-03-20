#!/usr/bin/env bun
/**
 * Usage: files-serve [--port 19432]
 * Default port: 19432. Auto-finds next free port if taken.
 */
import { startServer } from "./serve.js";
import { getCurrentMachine } from "../db/machines.js";
import { listSources } from "../db/sources.js";
import { indexLocalSource } from "../lib/indexer.js";
import { getAutosyncPeers, markPeerSynced } from "../db/peers.js";
import { syncWithPeer } from "../lib/sync.js";

const DEFAULT_PORT = 19432;

function getRequestedPort(): number {
  const portArg = process.argv.find((a) => a === "--port" || a.startsWith("--port="));
  if (portArg) {
    if (portArg.includes("=")) return parseInt(portArg.split("=")[1]!, 10) || DEFAULT_PORT;
    const idx = process.argv.indexOf(portArg);
    return parseInt(process.argv[idx + 1]!, 10) || DEFAULT_PORT;
  }
  return DEFAULT_PORT;
}

async function findFreePort(start: number): Promise<number> {
  for (let port = start; port < start + 100; port++) {
    try {
      const server = Bun.serve({ port, fetch: () => new Response("") });
      server.stop();
      return port;
    } catch {
      continue;
    }
  }
  return start;
}

const requestedPort = getRequestedPort();
const port = await findFreePort(requestedPort);
if (port !== requestedPort) console.log(`Port ${requestedPort} in use, using ${port}`);
startServer(port);

// Auto-index all enabled local sources on startup (non-blocking)
const machine = getCurrentMachine();
for (const source of listSources(machine.id).filter((s) => s.enabled && s.type === "local")) {
  indexLocalSource(source, machine.id).catch(() => {});
}

// Auto-sync peers on their configured intervals
function scheduleAutoSync(): void {
  const peers = getAutosyncPeers();
  for (const peer of peers) {
    const intervalMs = peer.sync_interval_minutes * 60 * 1000;
    setInterval(async () => {
      try {
        await syncWithPeer(peer.url);
        markPeerSynced(peer.id);
      } catch { /* ignore */ }
    }, intervalMs);
  }
}
scheduleAutoSync();
