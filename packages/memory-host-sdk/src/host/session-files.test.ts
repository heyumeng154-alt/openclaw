import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { replaceSqliteSessionTranscriptEvents } from "../../../../src/config/sessions/transcript-store.sqlite.js";
import { closeOpenClawStateDatabaseForTest } from "../../../../src/state/openclaw-state-db.js";
import {
  buildSessionEntry,
  listSessionFilesForAgent,
  sessionPathForFile,
} from "./session-files.js";

let fixtureRoot: string;
let tmpDir: string;
let originalStateDir: string | undefined;
let fixtureId = 0;

beforeAll(() => {
  fixtureRoot = fsSync.mkdtempSync(path.join(os.tmpdir(), "session-entry-test-"));
});

afterAll(() => {
  fsSync.rmSync(fixtureRoot, { recursive: true, force: true });
});

beforeEach(() => {
  tmpDir = path.join(fixtureRoot, `case-${fixtureId++}`);
  fsSync.mkdirSync(tmpDir, { recursive: true });
  originalStateDir = process.env.OPENCLAW_STATE_DIR;
  process.env.OPENCLAW_STATE_DIR = tmpDir;
});

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  if (originalStateDir === undefined) {
    delete process.env.OPENCLAW_STATE_DIR;
  } else {
    process.env.OPENCLAW_STATE_DIR = originalStateDir;
  }
});

function seedTranscript(params: {
  agentId?: string;
  sessionId: string;
  transcriptPath?: string;
  events: unknown[];
  now?: number;
}): string {
  const agentId = params.agentId ?? "main";
  const transcriptPath =
    params.transcriptPath ??
    path.join(tmpDir, "agents", agentId, "sessions", `${params.sessionId}.jsonl`);
  replaceSqliteSessionTranscriptEvents({
    agentId,
    sessionId: params.sessionId,
    transcriptPath,
    events: params.events,
    now: () => params.now ?? 1_770_000_000_000,
  });
  return transcriptPath;
}

describe("listSessionFilesForAgent", () => {
  it("lists SQLite transcript handles for an agent", async () => {
    const includedPath = seedTranscript({
      sessionId: "active",
      events: [{ type: "session", id: "active" }],
    });
    seedTranscript({
      agentId: "other",
      sessionId: "other-active",
      events: [{ type: "session", id: "other-active" }],
    });

    const files = await listSessionFilesForAgent("main");

    expect(files).toEqual([includedPath]);
  });
});

describe("sessionPathForFile", () => {
  it("includes the owning agent id when the transcript lives under an agent sessions dir", () => {
    const absPath = path.join(tmpDir, "agents", "main", "sessions", "active-session.jsonl");

    expect(sessionPathForFile(absPath)).toBe("sessions/main/active-session.jsonl");
  });

  it("keeps the legacy basename-only path when the agent owner cannot be derived", () => {
    expect(sessionPathForFile(path.join(tmpDir, "loose-session.jsonl"))).toBe(
      "sessions/loose-session.jsonl",
    );
  });
});

describe("buildSessionEntry", () => {
  it("returns lineMap tracking original JSONL line numbers", async () => {
    // Simulate a real transcript event stream with metadata records interspersed
    // Lines 1-3: non-message metadata records
    // Line 4: user message
    // Line 5: metadata
    // Line 6: assistant message
    // Line 7: user message
    const events = [
      { type: "custom", customType: "model-snapshot", data: {} },
      { type: "custom", customType: "openclaw.cache-ttl", data: {} },
      { type: "session-meta", agentId: "test" },
      { type: "message", message: { role: "user", content: "Hello world" } },
      { type: "custom", customType: "tool-result", data: {} },
      {
        type: "message",
        message: { role: "assistant", content: "Hi there, how can I help?" },
      },
      { type: "message", message: { role: "user", content: "Tell me a joke" } },
    ];
    const filePath = seedTranscript({ sessionId: "session", events });

    const entry = await buildSessionEntry(filePath);
    expect(entry).not.toBeNull();

    // The content should have 3 lines (3 message records)
    const contentLines = entry!.content.split("\n");
    expect(contentLines).toHaveLength(3);
    expect(contentLines[0]).toContain("User: Hello world");
    expect(contentLines[1]).toContain("Assistant: Hi there");
    expect(contentLines[2]).toContain("User: Tell me a joke");

    // lineMap should map each content line to its original JSONL line (1-indexed)
    // Content line 0 → JSONL line 4 (the first user message)
    // Content line 1 → JSONL line 6 (the assistant message)
    // Content line 2 → JSONL line 7 (the second user message)
    expect(entry!.lineMap).toBeDefined();
    expect(entry!.lineMap).toEqual([4, 6, 7]);
  });

  it("returns empty lineMap when no messages are found", async () => {
    const filePath = seedTranscript({
      sessionId: "empty-session",
      events: [
        { type: "custom", customType: "model-snapshot", data: {} },
        { type: "session-meta", agentId: "test" },
      ],
    });

    const entry = await buildSessionEntry(filePath);
    expect(entry).not.toBeNull();
    expect(entry!.content).toBe("");
    expect(entry!.lineMap).toEqual([]);
  });

  it("skips checkpoint artifacts so snapshots do not double-index session content", async () => {
    const checkpointPath = path.join(
      tmpDir,
      "agents",
      "main",
      "sessions",
      "ordinary.checkpoint.11111111-1111-4111-8111-111111111111.jsonl",
    );
    seedTranscript({
      sessionId: "ordinary.checkpoint.11111111-1111-4111-8111-111111111111",
      transcriptPath: checkpointPath,
      events: [
        {
          type: "message",
          message: { role: "user", content: "Archived hello" },
        },
      ],
    });

    const checkpointEntry = await buildSessionEntry(checkpointPath);

    expect(checkpointEntry).not.toBeNull();
    expect(checkpointEntry?.content).toBe("");
    expect(checkpointEntry?.lineMap).toEqual([]);
  });

  it("skips non-message events without breaking lineMap", async () => {
    const filePath = seedTranscript({
      sessionId: "gaps",
      events: [
        { type: "custom", customType: "ignored" },
        { type: "message", message: { role: "user", content: "First" } },
        { type: "custom", customType: "ignored-again" },
        { type: "message", message: { role: "assistant", content: "Second" } },
      ],
    });

    const entry = await buildSessionEntry(filePath);
    expect(entry).not.toBeNull();
    expect(entry!.lineMap).toEqual([2, 4]);
  });

  it("strips inbound metadata when a user envelope is split across text blocks", async () => {
    const filePath = seedTranscript({
      sessionId: "enveloped-session-array",
      events: [
        {
          type: "message",
          message: {
            role: "user",
            content: [
              { type: "text", text: "Conversation info (untrusted metadata):" },
              { type: "text", text: "```json" },
              { type: "text", text: '{"message_id":"msg-100","chat_id":"-100123"}' },
              { type: "text", text: "```" },
              { type: "text", text: "" },
              { type: "text", text: "Sender (untrusted metadata):" },
              { type: "text", text: "```json" },
              { type: "text", text: '{"label":"Chris","id":"42"}' },
              { type: "text", text: "```" },
              { type: "text", text: "" },
              { type: "text", text: "Actual user text" },
            ],
          },
        },
      ],
    });

    const entry = await buildSessionEntry(filePath);
    expect(entry).not.toBeNull();
    expect(entry!.content).toBe("User: Actual user text");
  });

  it("skips inter-session user messages", async () => {
    const filePath = seedTranscript({
      sessionId: "inter-session-session",
      events: [
        {
          type: "message",
          message: {
            role: "user",
            content: "A background task completed. Internal relay text.",
            provenance: { kind: "inter_session", sourceTool: "subagent_announce" },
          },
        },
        {
          type: "message",
          message: { role: "assistant", content: "User-facing summary." },
        },
        {
          type: "message",
          message: { role: "user", content: "Actual user follow-up." },
        },
      ],
    });

    const entry = await buildSessionEntry(filePath);
    expect(entry).not.toBeNull();
    expect(entry!.content).toBe("Assistant: User-facing summary.\nUser: Actual user follow-up.");
    expect(entry!.lineMap).toEqual([2, 3]);
  });
});
