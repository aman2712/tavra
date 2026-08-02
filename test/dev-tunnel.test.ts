import assert from "node:assert/strict";
import test from "node:test";

import {
  findTunnelIdForTarget,
  isDevTunnelAuthenticationError,
  parseDevTunnelTarget,
} from "../src/dev-tunnel.js";

test("recognizes expired and missing Dev Tunnels authentication", () => {
  assert.equal(isDevTunnelAuthenticationError("Login token expired."), true);
  assert.equal(isDevTunnelAuthenticationError("Error: Login required."), true);
  assert.equal(isDevTunnelAuthenticationError("You are not logged in"), true);
  assert.equal(isDevTunnelAuthenticationError("Tunnel not found"), false);
});

test("parses a VS Code forwarded-port URL", () => {
  assert.deepEqual(
    parseDevTunnelTarget(
      new URL("https://tavratest-3000.euw.devtunnels.ms"),
      3000,
    ),
    {
      publicHostToken: "tavratest",
      port: 3000,
      publicOrigin: "https://tavratest-3000.euw.devtunnels.ms",
    },
  );
});

test("resolves the public hostname to the account's actual tunnel ID", () => {
  const target = parseDevTunnelTarget(
    new URL("https://tavratest-3000.euw.devtunnels.ms"),
    3000,
  );
  assert.equal(
    findTunnelIdForTarget(target, [
      {
        tunnelId: "majestic-hill-10gklb9.euw",
        ports: [
          {
            portNumber: 3000,
            portUri: "https://tavratest-3000.euw.devtunnels.ms/",
          },
        ],
      },
    ]),
    "majestic-hill-10gklb9.euw",
  );
});

test("resolves one offline tunnel when Microsoft omits its public URI", () => {
  const target = parseDevTunnelTarget(
    new URL("https://tavratest-3000.euw.devtunnels.ms"),
    3000,
  );
  assert.equal(
    findTunnelIdForTarget(target, [
      {
        tunnelId: "majestic-hill-10gklb9.euw",
        ports: [{ portNumber: 3000 }],
      },
    ]),
    "majestic-hill-10gklb9.euw",
  );
});

test("does not guess between multiple offline tunnels on the same port", () => {
  const target = parseDevTunnelTarget(
    new URL("https://tavratest-3000.euw.devtunnels.ms"),
    3000,
  );
  assert.equal(
    findTunnelIdForTarget(target, [
      { tunnelId: "first.euw", ports: [{ portNumber: 3000 }] },
      { tunnelId: "second.euw", ports: [{ portNumber: 3000 }] },
    ]),
    null,
  );
});

test("rejects the wrong forwarded port", () => {
  assert.throws(
    () =>
      parseDevTunnelTarget(
        new URL("https://tavratest-4000.euw.devtunnels.ms"),
        3000,
      ),
    /forwards port 4000, but PORT is 3000/,
  );
});

test("rejects a non-Microsoft tunnel URL", () => {
  assert.throws(
    () => parseDevTunnelTarget(new URL("https://example.com"), 3000),
    /not a VS Code\/Microsoft Dev Tunnels URL/,
  );
});
