#!/usr/bin/env node
// Lab 01: talk to the Herdr socket API. Read-only.
// Usage: node labs/01-socket.mjs [--fixture] [--raw]
//   --fixture  use fixtures/01-responses.json, no Herdr needed
//   --raw      print full responses (may show your workspace names and titles)
import net from 'node:net';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const args = new Set(process.argv.slice(2));
const useFixture = args.has('--fixture');
const raw = args.has('--raw');

// Keys whose string values are safe to show. Everything else is masked.
const SAFE_KEYS = new Set([
  'id', 'type', 'agent', 'agent_status', 'code', 'version',
  'workspace_id', 'tab_id', 'pane_id', 'active_tab_id', 'terminal_id',
]);

function mask(value, key = '') {
  if (raw) return value;
  if (Array.isArray(value)) {
    // keep the first item only, so the shape is visible without the noise
    const first = value.slice(0, 1).map((v) => mask(v, key));
    if (value.length > 1) first.push(`... ${value.length - 1} more`);
    return first;
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, mask(v, k)]));
  }
  if (typeof value === 'string' && !SAFE_KEYS.has(key)) return '<string>';
  return value;
}

// One request = one connection: connect, write one JSON line, read one line.
function request(socketPath, payload) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(socketPath);
    let buf = '';
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new Error('timed out waiting for a response line'));
    }, 5000);
    sock.on('connect', () => sock.write(JSON.stringify(payload) + '\n'));
    sock.on('data', (chunk) => {
      buf += chunk;
      const nl = buf.indexOf('\n');
      if (nl === -1) return;
      clearTimeout(timer);
      sock.end();
      try {
        resolve(JSON.parse(buf.slice(0, nl)));
      } catch (err) {
        reject(new Error(`response was not JSON: ${err.message}`));
      }
    });
    sock.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    sock.on('close', () => {
      clearTimeout(timer);
      if (!buf.includes('\n')) reject(new Error('connection closed with no response'));
    });
  });
}

let send;
if (useFixture) {
  const fixture = JSON.parse(
    readFileSync(fileURLToPath(new URL('../fixtures/01-responses.json', import.meta.url)), 'utf8'),
  );
  console.log('mode: fixture (no Herdr needed)\n');
  send = async (payload) => fixture[payload.method === 'nope' ? 'bad.method' : payload.method];
} else {
  const socketPath = process.env.HERDR_SOCKET_PATH;
  if (!socketPath) {
    console.error('HERDR_SOCKET_PATH is not set. Run this from a pane inside Herdr, or use --fixture.');
    process.exit(1);
  }
  console.log('mode: live, socket from $HERDR_SOCKET_PATH\n');
  send = (payload) => request(socketPath, payload);
}

async function call(id, method, params = {}) {
  const payload = { id, method, params };
  console.log(`-> ${JSON.stringify(payload)}`);
  const res = await send(payload);
  console.log(`<- ${JSON.stringify(mask(res))}\n`);
  return res;
}

function tally(items, key) {
  const counts = {};
  for (const item of items) counts[item[key] ?? 'none'] = (counts[item[key] ?? 'none'] ?? 0) + 1;
  return counts;
}

try {
  const pong = await call('lab:ping', 'ping');
  if (pong.error) throw new Error(`${pong.error.code}: ${pong.error.message}`);
  console.log(`server version ${pong.result.version}, protocol ${pong.result.protocol}\n`);

  const ws = await call('lab:workspaces', 'workspace.list');
  const agents = await call('lab:agents', 'agent.list');
  // A deliberately wrong method shows the error shape. It changes nothing.
  const bad = await call('lab:bad', 'nope');

  console.log('summary');
  console.log(`  workspaces: ${ws.result.workspaces.length}`);
  console.log(`  workspace fields: ${Object.keys(ws.result.workspaces[0] ?? {}).join(', ')}`);
  console.log(`  agents: ${agents.result.agents.length}`);
  console.log(`  agent kinds: ${JSON.stringify(tally(agents.result.agents, 'agent'))}`);
  console.log(`  agent status: ${JSON.stringify(tally(agents.result.agents, 'agent_status'))}`);
  console.log(`  error shape: id=${bad.error.id ?? bad.id}, code=${bad.error.code}`);
} catch (err) {
  console.error(`error: ${err.message}`);
  if (err.code === 'ENOENT' || err.code === 'ECONNREFUSED') {
    console.error('Is the Herdr server running? Try --fixture to see the output without it.');
  }
  process.exit(1);
}
