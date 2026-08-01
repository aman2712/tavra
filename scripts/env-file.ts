import { readFile, writeFile } from "node:fs/promises";

export async function setDotEnvValue(
  path: string,
  name: string,
  value: string,
): Promise<void> {
  let contents = "";
  try {
    contents = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const line = `${name}=${value}`;
  const expression = new RegExp(`^${name}=.*$`, "m");
  const next = expression.test(contents)
    ? contents.replace(expression, line)
    : `${contents}${contents && !contents.endsWith("\n") ? "\n" : ""}${line}\n`;
  await writeFile(path, next, { encoding: "utf8", mode: 0o600 });
}
