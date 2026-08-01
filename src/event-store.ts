import { appendFile, readFile } from "node:fs/promises";

export interface ProcessedEventStore {
  has(eventId: string): Promise<boolean>;
  add(eventId: string): Promise<void>;
}

export class JsonlProcessedEventStore implements ProcessedEventStore {
  private readonly loaded: Promise<Set<string>>;

  constructor(private readonly path: string) {
    this.loaded = this.load();
  }

  async has(eventId: string): Promise<boolean> {
    return (await this.loaded).has(eventId);
  }

  async add(eventId: string): Promise<void> {
    const events = await this.loaded;
    if (events.has(eventId)) return;

    await appendFile(
      this.path,
      `${JSON.stringify({ event_id: eventId, processed_at: new Date().toISOString() })}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    events.add(eventId);
  }

  private async load(): Promise<Set<string>> {
    try {
      const contents = await readFile(this.path, "utf8");
      const eventIds = contents
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { event_id?: unknown })
        .flatMap((record) =>
          typeof record.event_id === "string" ? [record.event_id] : [],
        );
      return new Set(eventIds);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return new Set();
      }
      throw error;
    }
  }
}

export class InMemoryProcessedEventStore implements ProcessedEventStore {
  private readonly events = new Set<string>();

  async has(eventId: string): Promise<boolean> {
    return this.events.has(eventId);
  }

  async add(eventId: string): Promise<void> {
    this.events.add(eventId);
  }
}
