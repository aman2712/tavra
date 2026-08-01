import { spawn, type ChildProcess } from "node:child_process";

type Service = {
  name: string;
  child: ChildProcess;
};

function start(name: string, script: string): Service {
  const child = spawn("npm", ["run", script], {
    cwd: process.cwd(),
    detached: process.platform !== "win32",
    env: process.env,
    stdio: "inherit",
  });

  return { name, child };
}

const services = [
  start("Tavra server", "dev"),
  start("Dev Tunnel", "tunnel:vscode"),
];
const children = services.map(({ child }) => child);
let stopping = false;

function describeExit(code: number | null, signal: NodeJS.Signals | null): string {
  if (code !== null) return `exit code ${code}`;
  if (signal !== null) return `signal ${signal}`;
  return "an unknown reason";
}

function stopAll(signal: NodeJS.Signals = "SIGTERM") {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) {
      try {
        if (process.platform !== "win32" && child.pid) {
          process.kill(-child.pid, signal);
        } else {
          child.kill(signal);
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    }
  }
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => stopAll(signal));
}

const results = services.map(
  ({ name, child }) =>
    new Promise<number>((resolve) => {
      child.once("error", (error) => {
        if (!stopping) {
          console.error(`[dev:imessage] ${name} failed to start: ${error.message}`);
          stopAll("SIGTERM");
        }
        resolve(1);
      });
      child.once("exit", (code, signal) => {
        if (!stopping) {
          console.error(
            `[dev:imessage] ${name} stopped with ${describeExit(code, signal)}; stopping the other process.`,
          );
          stopAll("SIGTERM");
        }
        resolve(code ?? (signal ? 1 : 0));
      });
    }),
);

const exitCodes = await Promise.all(results);
process.exitCode = exitCodes.find((code) => code !== 0) ?? 0;
