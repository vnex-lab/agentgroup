import assert from "node:assert/strict";
import test from "node:test";
import {
  activeWithinHour,
  buildWakePrompt,
  canAddConversationTurn,
  createMeta,
  eligibleForWake,
  isDuplicateContribution,
  isQuietTime,
  selectPendingQueue,
  shouldRouteReply,
  type QueueRecord,
} from "./model.ts";

test("quiet hours handle daytime, overnight, and invalid ranges", () => {
  assert.equal(isQuietTime(new Date(2026, 0, 1, 23, 0), true, "22:00", "07:00"), true);
  assert.equal(isQuietTime(new Date(2026, 0, 1, 6, 59), true, "22:00", "07:00"), true);
  assert.equal(isQuietTime(new Date(2026, 0, 1, 7, 0), true, "22:00", "07:00"), false);
  assert.equal(isQuietTime(new Date(2026, 0, 1, 14, 0), true, "22:00", "07:00"), false);
  assert.equal(isQuietTime(new Date(2026, 0, 1, 23, 0), true, "bad", "07:00"), false);
});

test("agent wake eligibility respects pauses, quiet hours, and hourly budgets", () => {
  const meta = createMeta();
  const now = new Date(2026, 0, 1, 12, 0);
  assert.equal(eligibleForWake(meta, "researcher", now, []), true);
  meta.settings.perAgentPaused.researcher = true;
  assert.equal(eligibleForWake(meta, "researcher", now, []), false);
  meta.settings.perAgentPaused.researcher = false;
  meta.paused = true;
  assert.equal(eligibleForWake(meta, "researcher", now, []), false);
  meta.paused = false;
  assert.equal(eligibleForWake(meta, "researcher", now, Array(8).fill(now.getTime())), false);
});

test("duplicate contributions are suppressed only within the same thread and cooldown", () => {
  const recent = [{ authorId: "dev", normalized: "same fix", at: 10_000, threadId: "t1" }];
  assert.equal(isDuplicateContribution(recent, "dev", "Same   fix", "t1", 10_100, 1_000), true);
  assert.equal(isDuplicateContribution(recent, "dev", "Same fix", "t2", 10_100, 1_000), false);
  assert.equal(isDuplicateContribution(recent, "dev", "Same fix", "t1", 12_000, 1_000), false);
  assert.equal(isDuplicateContribution(recent, "dev", "   ", "t1", 10_100, 1_000), true);
});

test("queue selection honors priority and the concurrency cap", () => {
  const queue: QueueRecord[] = [
    { kind: "queue", id: "low", roomId: "r", agentId: "a", threadId: "t", reason: "", priority: 1, status: "pending", createdAt: 1 },
    { kind: "queue", id: "high", roomId: "r", agentId: "b", threadId: "t", reason: "", priority: 4, status: "pending", createdAt: 2 },
    { kind: "queue", id: "running", roomId: "r", agentId: "c", threadId: "t", reason: "", priority: 3, status: "dispatched", createdAt: 0 },
  ];
  assert.deepEqual(selectPendingQueue(queue, 2).map((item) => item.id), ["high"]);
  assert.deepEqual(selectPendingQueue(queue, 1), []);
});

test("message routing handles mentions, help broadcasts, replies, and self-replies", () => {
  const members = ["researcher", "developer", "reviewer"];
  assert.deepEqual(
    shouldRouteReply({ kind: "help", mentions: [], authorId: "researcher", roomAgentIds: members }),
    ["developer", "reviewer"],
  );
  assert.deepEqual(
    shouldRouteReply({ kind: "message", mentions: ["reviewer", "researcher", "outsider"], authorId: "developer", roomAgentIds: members }),
    ["reviewer", "researcher"],
  );
  assert.deepEqual(
    shouldRouteReply({ kind: "message", mentions: [], replyToAgentId: "researcher", authorId: "developer", roomAgentIds: members }),
    ["researcher"],
  );
  assert.deepEqual(
    shouldRouteReply({ kind: "message", mentions: [], replyToAgentId: "developer", authorId: "developer", roomAgentIds: members }),
    [],
  );
});

test("hourly count is bounded to the rolling hour", () => {
  assert.equal(activeWithinHour([0, 3_600_000, 3_600_001], 3_600_000), 1);
});

test("conversation turns stop at the configured maximum", () => {
  assert.equal(canAddConversationTurn(7, 8), true);
  assert.equal(canAddConversationTurn(8, 8), false);
  assert.equal(canAddConversationTurn(9, 8), false);
});

test("wake prompt includes previous shared context and a contribution token", () => {
  const prompt = buildWakePrompt({
    agentName: "Researcher",
    roomName: "Project",
    wakeId: "wake-123",
    reason: "A teammate requested review",
    roomAgents: [
      { id: "developer", name: "Developer" },
      { id: "reviewer", name: "Reviewer" },
    ],
    history: [],
    goals: [],
    tasks: [],
  });
  assert.match(prompt, /Researcher/u);
  assert.match(prompt, /wake-123/u);
  assert.match(prompt, /own existing OpenClaw identity/u);
  assert.match(prompt, /no_contribution to release this wake/u);
});
