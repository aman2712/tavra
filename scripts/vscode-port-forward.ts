import { accessSync, constants } from "node:fs";
import { spawn, spawnSync } from "node:child_process";

import { loadPublicBaseUrl } from "../src/config.js";
import {
  findTunnelIdForTarget,
  parseDevTunnelTarget,
  type DevTunnelDescription,
} from "../src/dev-tunnel.js";

function executable(): string {
  const configured = process.env.DEVTUNNEL_BIN?.trim();
  const candidates = [
    configured,
    "/opt/homebrew/bin/devtunnel",
    "/usr/local/bin/devtunnel",
  ].filter((candidate): candidate is string => Boolean(candidate));

  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Continue to the next known install location.
    }
  }

  const fromPath = spawnSync("command", ["-v", "devtunnel"], {
    encoding: "utf8",
    shell: true,
  }).stdout.trim();
  if (fromPath) return fromPath;

  throw new Error(
    "Microsoft Dev Tunnels CLI is missing. Install it with: brew install --cask devtunnel",
  );
}

function jsonCommand<T>(cli: string, args: string[]): T {
  const result = spawnSync(cli, args, { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || result.stdout.trim() || "Dev Tunnels command failed");
  }
  return JSON.parse(result.stdout) as T;
}

const port = Number(process.env.PORT || "3000");
if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error("PORT must be an integer between 1 and 65535");
}

const target = parseDevTunnelTarget(loadPublicBaseUrl(), port);
const cli = executable();
const login = spawnSync(cli, ["user", "show"], { encoding: "utf8" });
const loginOutput = `${login.stdout}\n${login.stderr}`;
if (login.status !== 0 || /not logged in/i.test(loginOutput)) {
  throw new Error(
    `Dev Tunnels is not signed in. Run '${cli} user login -g' once, then retry.`,
  );
}

const listed = jsonCommand<{ tunnels: Array<{ tunnelId: string }> }>(cli, [
  "list",
  "-j",
]);
const descriptions = listed.tunnels.map(({ tunnelId }) =>
  jsonCommand<{ tunnel: DevTunnelDescription }>(cli, ["show", tunnelId, "-j"])
    .tunnel,
);
const tunnelId = findTunnelIdForTarget(target, descriptions);
if (!tunnelId) {
  throw new Error(
    `No tunnel in the authenticated account owns ${target.publicOrigin}. Re-forward port ${target.port} once in VS Code, then retry.`,
  );
}

if (process.argv.includes("--check")) {
  console.log(
    `Dev Tunnel preflight passed: ${target.publicOrigin} maps to ${tunnelId} on port ${target.port}.`,
  );
  process.exit(0);
}

console.log(`Forwarding Tavra on port ${target.port} through ${target.publicOrigin}`);
console.log("The tunnel is public because LINQ cannot authenticate to a private port.");

const tunnel = spawn(
  cli,
  ["host", tunnelId, "--allow-anonymous"],
  { stdio: "inherit" },
);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => tunnel.kill(signal));
}

const exitCode = await new Promise<number>((resolve, reject) => {
  tunnel.once("error", reject);
  tunnel.once("exit", (code) => resolve(code ?? 1));
});
process.exitCode = exitCode;
