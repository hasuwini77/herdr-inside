#!/usr/bin/env node
// Lab 02: watch agent status changes in a running Herdr, read-only.
//
//   node labs/02-status-watch.mjs [--seconds N] [--interval MS]
//   node labs/02-status-watch.mjs --fixture fixtures/02-status-sequence.json [--speed N]
//
// Live mode sends one request, `agent.list`, on a fresh connection every
// second. It never sends input and never changes panes. It prints only the
// time, short pane id, agent kind and status. No titles, paths or names.
// Why polling: `pane.agent_status_changed` subscriptions need a pane_id up
// front, so they miss panes created later. Polling sees every pane.

import net from 'node:net';
import { readFileSync } from 'node:fs';

// Exit quietly when the reader closes the pipe, e.g. `node labs/02-status-watch.mjs | head`.
process.stdout.on('error', (err) => {
  if (err.code === 'EPIPE') process.exit(0);
  throw err;
});

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i === -1 ? fallback : args[i + 1];
};
const seconds = Number(opt('--seconds', 0));
const interval = Number(opt('--interval', 1000));
const fixturePath = opt('--fixture', null);
const speed = Number(opt('--speed', 20));

const stamp = (d = new Date()) => d.toTimeString().slice(0, 8);
const emit = (time, pane, agent, from, to) =>
  console.log(`${time}  ${pane.padEnd(7)} ${agent.padEnd(10)} ${from} -> ${to}`);

let stopped = false;
const wakers = new Set();
const sleep = (ms) =>
  new Promise((resolve) => {
    const t = setTimeout(done, ms);
    function done() { clearTimeout(t); wakers.delete(done); resolve(); }
    wakers.add(done);
  });
const stop = () => {
  stopped = true;
  for (const wake of [...wakers]) wake(); // end any sleep right away
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
if (seconds > 0) setTimeout(stop, seconds * 1000).unref();

// Remember last status per pane, print a line when it changes.
const last = new Map();
function observe(time, pane, agent, status) {
  const from = last.get(pane) ?? 'new';
  if (from === status) return;
  last.set(pane, status);
  emit(time, pane, agent, from, status);
}

// One request, one line back, then close.
function agentList(socketPath) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(socketPath);
    let buf = '';
    const fail = (err) => { sock.destroy(); reject(err); };
    sock.setTimeout(2000, () => fail(new Error('timeout')));
    sock.on('error', fail);
    sock.on('connect', () =>
      sock.write(JSON.stringify({ id: 'lab02', method: 'agent.list', params: {} }) + '\n'));
    sock.on('data', (chunk) => {
      buf += chunk;
      const nl = buf.indexOf('\n');
      if (nl === -1) return;
      sock.end();
      try {
        const msg = JSON.parse(buf.slice(0, nl));
        if (msg.error) return reject(new Error(msg.error.code));
        resolve(msg.result.agents ?? []);
      } catch (err) { reject(err); }
    });
  });
}

async function live() {
  const socketPath = process.env.HERDR_SOCKET_PATH;
  if (!socketPath) {
    console.error('HERDR_SOCKET_PATH is not set. Run inside Herdr, or use --fixture.');
    process.exit(2);
  }
  console.log('watching (read-only, agent.list every ' + interval + ' ms). Ctrl+C to stop.');
  let failures = 0;
  while (!stopped) {
    try {
      const agents = await agentList(socketPath);
      failures = 0;
      const seen = new Set();
      for (const a of agents) {
        seen.add(a.pane_id);
        observe(stamp(), a.pane_id, a.agent ?? 'unknown', a.agent_status);
      }
      for (const pane of [...last.keys()]) {
        if (!seen.has(pane)) { emit(stamp(), pane, '-', last.get(pane), 'gone'); last.delete(pane); }
      }
    } catch (err) {
      if (++failures === 1) console.error(`poll failed: ${err.message}`);
    }
    await sleep(interval);
  }
}

async function replay() {
  const { events } = JSON.parse(readFileSync(fixturePath, 'utf8'));
  console.log(`replaying ${events.length} fixture events at ${speed}x. Ctrl+C to stop.`);
  let prev = 0;
  for (const e of events) {
    if (stopped) break;
    await sleep((e.t - prev) / speed);
    prev = e.t;
    const s = Math.floor(e.t / 1000);
    const time = `00:00:${String(s).padStart(2, '0')}`;
    observe(time, e.pane, e.agent, e.status);
  }
}

await (fixturePath ? replay() : live());
if (seconds > 0 || stopped) console.log('stopped.');
process.exit(0);
