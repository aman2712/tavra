import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";

import "dotenv/config";

const apiKey = process.env.SENSO_API_KEY?.trim();
const baseUrl = new URL(
  process.env.SENSO_BASE_URL?.trim() || "https://apiv2.senso.ai/api/v1/",
);
const sourcePath = resolve(
  process.cwd(),
  process.env.SENSO_PRIVATE_PROFILE_PATH?.trim() ||
    "senso/demo-config/employee-profile.local.md",
);
const identityPath = resolve(
  process.cwd(),
  process.env.SENSO_IDENTITY_MAP_PATH?.trim() ||
    "senso/demo-config/identity-map.local.json",
);

if (!apiKey) throw new Error("SENSO_API_KEY is required");
if (baseUrl.protocol !== "https:") throw new Error("SENSO_BASE_URL must use HTTPS");

const source = await readFile(sourcePath);
const filename = basename(sourcePath);
const headers = {
  "X-API-Key": apiKey,
  "Content-Type": "application/json",
};

const uploadRequest = await fetch(new URL("org/kb/upload", baseUrl), {
  method: "POST",
  headers,
  body: JSON.stringify({
    files: [
      {
        filename,
        file_size_bytes: source.byteLength,
        content_type: "text/markdown",
        content_hash_md5: createHash("md5").update(source).digest("hex"),
      },
    ],
  }),
});
if (!uploadRequest.ok) {
  throw new Error(`Senso upload preparation failed with HTTP ${uploadRequest.status}`);
}
const uploadPayload = (await uploadRequest.json()) as {
  results?: Array<{ content_id?: string; upload_url?: string }>;
};
const upload = uploadPayload.results?.[0];
if (!upload?.content_id || !upload.upload_url) {
  throw new Error("Senso upload preparation returned an invalid response");
}

const objectUpload = await fetch(upload.upload_url, {
  method: "PUT",
  headers: { "Content-Type": "text/markdown" },
  body: source,
});
if (!objectUpload.ok) {
  throw new Error(`Senso source upload failed with HTTP ${objectUpload.status}`);
}

let nodeId: string | null = null;
for (let attempt = 0; attempt < 30 && !nodeId; attempt += 1) {
  const found = await fetch(
    new URL(`org/kb/find?q=${encodeURIComponent(filename)}`, baseUrl),
    { headers: { "X-API-Key": apiKey } },
  );
  if (found.ok) {
    const payload = (await found.json()) as {
      nodes?: Array<{ kb_node_id?: string; content_id?: string }>;
    };
    nodeId =
      payload.nodes?.find((node) => node.content_id === upload.content_id)
        ?.kb_node_id ?? null;
  }
  if (!nodeId) await new Promise((resolveWait) => setTimeout(resolveWait, 1_000));
}
if (!nodeId) throw new Error("Senso did not expose the uploaded profile in time");

for (let attempt = 0; attempt < 90; attempt += 1) {
  const status = await fetch(new URL(`org/kb/nodes/${nodeId}/content`, baseUrl), {
    headers: { "X-API-Key": apiKey },
  });
  if (!status.ok) {
    throw new Error(`Senso profile status failed with HTTP ${status.status}`);
  }
  const payload = (await status.json()) as { processing_status?: string };
  if (["complete", "completed"].includes(payload.processing_status ?? "")) break;
  if (["failed", "error"].includes(payload.processing_status ?? "")) {
    throw new Error("Senso failed to process the private employee profile");
  }
  if (attempt === 89) throw new Error("Senso profile processing timed out");
  await new Promise((resolveWait) => setTimeout(resolveWait, 1_000));
}

const identityDocument = JSON.parse(await readFile(identityPath, "utf8")) as {
  identities?: Array<{
    employee_id?: string;
    employee_profile_content_id?: string;
  }>;
};
const identity = identityDocument.identities?.find(
  (entry) => entry.employee_id === "emp_demo_001",
);
if (!identity) throw new Error("Private identity map is missing emp_demo_001");
identity.employee_profile_content_id = upload.content_id;
await writeFile(identityPath, `${JSON.stringify(identityDocument, null, 2)}\n`, {
  mode: 0o600,
});

console.log("Private employee profile synced to Senso and identity mapping updated.");
