export interface DevTunnelTarget {
  publicHostToken: string;
  port: number;
  publicOrigin: string;
}

export interface DevTunnelDescription {
  tunnelId: string;
  ports?: Array<{
    portNumber: number;
    portUri?: string;
  }>;
}

export function parseDevTunnelTarget(
  publicUrl: URL,
  expectedPort: number,
): DevTunnelTarget {
  const match = publicUrl.hostname.match(
    /^([a-z0-9]+)-(\d+)\.[a-z0-9-]+\.devtunnels\.ms$/i,
  );
  if (!match) {
    throw new Error(
      "PUBLIC_BASE_URL is not a VS Code/Microsoft Dev Tunnels URL",
    );
  }

  const [, tunnelId, portText] = match;
  const port = Number(portText);
  if (!tunnelId || !Number.isInteger(port)) {
    throw new Error("Could not parse the configured Dev Tunnels URL");
  }
  if (port !== expectedPort) {
    throw new Error(
      `PUBLIC_BASE_URL forwards port ${port}, but PORT is ${expectedPort}`,
    );
  }

  return {
    publicHostToken: tunnelId,
    port,
    publicOrigin: publicUrl.origin,
  };
}

export function findTunnelIdForTarget(
  target: DevTunnelTarget,
  tunnels: DevTunnelDescription[],
): string | null {
  for (const tunnel of tunnels) {
    const matches = tunnel.ports?.some((port) => {
      if (port.portNumber !== target.port) return false;
      if (!port.portUri) return false;
      try {
        return new URL(port.portUri).origin === target.publicOrigin;
      } catch {
        return false;
      }
    });
    if (matches) return tunnel.tunnelId;
  }

  const portMatches = tunnels.filter((tunnel) =>
    tunnel.ports?.some((port) => port.portNumber === target.port),
  );
  return portMatches.length === 1 ? portMatches[0]?.tunnelId ?? null : null;
}
