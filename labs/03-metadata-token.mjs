#!/usr/bin/env node
// Lab 03: put a short-lived text token on your own pane.
//
// Writes "lab 3...", "lab 2...", "lab 1..." to the pane token
// `herdr_inside_lab`, one second apart, each with ttl_ms = 2500.
// It never clears the token. After the last write, Herdr drops it by itself.
//
// Zero dependencies, Node 20+.
//   node labs/03-metadata-token.mjs             # needs a running Herdr pane
//   node labs/03-metadata-token.mjs --dry-run   # print requests, do not connect

import net from "node:net";

const TOKEN = "herdr_inside_lab"; // 1-32 chars: letters, digits, _ and -
const SOURCE = "herdr-inside.lab03"; // letters, digits, : . _ - (max 80)
const TTL_MS = 2500; // Herdr accepts 1..86400000; this lab stays under 5000
const STEPS = ["lab 3…", "lab 2…", "lab 1…"];
const STEP_MS = 1000;

const dryRun = process.argv.includes("--dry-run");
const socketPath = process.env.HERDR_SOCKET_PATH;
const paneId = dryRun ? "<HERDR_PANE_ID>" : process.env.HERDR_PANE_ID;

if (!dryRun && (!socketPath || !paneId)) {
  console.error("HERDR_SOCKET_PATH and HERDR_PANE_ID are not set.");
  console.error("Run this inside a Herdr pane, or add --dry-run.");
  process.exit(1);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// One request per connection, one JSON object per line.
function call(line) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(socketPath);
    let buf = "";
    sock.setTimeout(3000, () => sock.destroy(new Error("socket timeout")));
    sock.on("connect", () => sock.write(line + "\n"));
    sock.on("data", (chunk) => {
      buf += chunk;
      if (buf.includes("\n")) sock.end();
    });
    sock.on("error", reject);
    sock.on("close", () => resolve(buf.trim()));
  });
}

console.log(`Writing token "${TOKEN}" to ${dryRun ? paneId : "the pane in HERDR_PANE_ID"}`);
console.log(`ttl_ms = ${TTL_MS}, source = ${SOURCE}\n`);

for (const [i, text] of STEPS.entries()) {
  const request = {
    id: `lab03-${i + 1}`,
    method: "pane.report_metadata",
    params: {
      pane_id: paneId,
      source: SOURCE,
      tokens: { [TOKEN]: text },
      ttl_ms: TTL_MS,
    },
  };
  const line = JSON.stringify(request);
  console.log(`-> ${line}`);
  if (!dryRun) {
    const reply = await call(line);
    console.log(`<- ${reply}`);
  }
  if (i < STEPS.length - 1) await sleep(dryRun ? 0 : STEP_MS);
}

console.log(`
Done. This script sent no "clear" request.
The last write carried ttl_ms=${TTL_MS}, so Herdr removes the token about
${TTL_MS / 1000} seconds after it, even if this process had crashed.
Check with:  herdr pane get "$HERDR_PANE_ID"   (look for ${TOKEN} under tokens)

To see it in the sidebar, add this to your Herdr config and reload it:

  [ui.sidebar.agents]
  rows = [
    [{ token = "$${TOKEN}", fg = "#fab387", dim = false }, "agent"],
  ]
`);
