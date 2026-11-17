export type OperatingMode = "automatic" | "manual";

export type GroupSettings = {
  autonomous: boolean;
  mode: OperatingMode;
  wakeIntervalMinutes: number;
  maxBackgroundTasks: number;
  maxConcurrentExecutions: number;
  maxMessagesPerHour: number;
  maxMessagesPerAgentPerHour: number;
  maxConversationTurns: number;
  cooldownSeconds: number;
  quietHoursEnabled: boolean;
  quietHoursStart: string;
  quietHoursEnd: string;
  perAgentPaused: Record<string, boolean>;
};

export type CivilizationMeta = {
  kind: "meta";
  version: 1;
  paused: boolean;
  settings: GroupSettings;
  roomIds: string[];
  goalIds: string[];
  taskIds: string[];
  activityIds: string[];
  lastReflectionAt: Record<string, number>;
  recentAgentMessages: Array<{ agentId: string; at: number }>;
  recentMessages: Array<{ authorId: string; normalized: string; at: number; threadId: string }>;
  revision: number;
};

export type RoomRecord = {
  kind: "room";
  id: string;
  name: string;
  agentIds: string[];
  messageIds: string[];
  createdAt: number;
  updatedAt: number;
};

export type MessageRecord = {
  kind: "message";
  id: string;
  roomId: string;
  threadId: string;
  replyToId?: string;
  authorId: string;
  authorName: string;
  authorAvatar?: string;
  text: string;
  messageKind: "message" | "help" | "offer" | "task" | "decision" | "system";
  createdAt: number;
  reactions: Record<string, string[]>;
};

export type TaskRecord = {
  kind: "task";
  id: string;
  roomId: string;
  title: string;
  description: string;
  creatorId: string;
  assigneeId?: string;
  status: "open" | "accepted" | "rejected" | "completed";
  createdAt: number;
  updatedAt: number;
  needsHuman: boolean;
};

export type GoalRecord = {
  kind: "goal";
  id: string;
  text: string;
  proposedBy: string;
  status: "proposed" | "active" | "completed";
  createdAt: number;
};

export type ActivityRecord = {
  kind: "activity";
  id: string;
  actorId: string;
  actorName: string;
  text: string;
  priority: "normal" | "important" | "human";
  createdAt: number;
};

export type QueueRecord = {
  kind: "queue";
  id: string;
  roomId: string;
  agentId: string;
  threadId: string;
  triggerMessageId?: string;
  reason: string;
  priority: number;
  status: "pending" | "dispatched" | "done" | "failed";
  createdAt: number;
  dispatchedAt?: number;
};

export type StoredRecord =
  | CivilizationMeta
  | RoomRecord
  | MessageRecord
  | TaskRecord
  | GoalRecord
  | ActivityRecord
  | QueueRecord;

export const DEFAULT_SETTINGS: GroupSettings = {
  autonomous: true,
  mode: "automatic",
  wakeIntervalMinutes: 30,
  maxBackgroundTasks: 40,
  maxConcurrentExecutions: 2,
  maxMessagesPerHour: 24,
  maxMessagesPerAgentPerHour: 8,
  maxConversationTurns: 8,
  cooldownSeconds: 30,
  quietHoursEnabled: false,
  quietHoursStart: "22:00",
  quietHoursEnd: "07:00",
  perAgentPaused: {},
};

export function createMeta(): CivilizationMeta {
  return {
    kind: "meta",
    version: 1,
    paused: false,
    settings: structuredClone(DEFAULT_SETTINGS),
    roomIds: [],
    goalIds: [],
    taskIds: [],
    activityIds: [],
    lastReflectionAt: {},
    recentAgentMessages: [],
    recentMessages: [],
    revision: 0,
  };
}

export function normalizeMessage(text: string): string {
  return text.normalize("NFKC").trim().replace(/\s+/gu, " ").toLocaleLowerCase();
}

export function isQuietTime(
  now: Date,
  enabled: boolean,
  start: string,
  end: string,
): boolean {
  if (!enabled) return false;
  const parseMinutes = (value: string): number | undefined => {
    const match = /^([01]\d|2[0-3]):([0-5]\d)$/u.exec(value);
    if (!match) return undefined;
    return Number(match[1]) * 60 + Number(match[2]);
  };
  const startsAt = parseMinutes(start);
  const endsAt = parseMinutes(end);
  if (startsAt === undefined || endsAt === undefined || startsAt === endsAt) return false;
  const current = now.getHours() * 60 + now.getMinutes();
  return startsAt < endsAt
    ? current >= startsAt && current < endsAt
    : current >= startsAt || current < endsAt;
}

export function activeWithinHour(timestamps: number[], now: number): number {
  const cutoff = now - 60 * 60 * 1000;
  return timestamps.filter((timestamp) => timestamp > cutoff && timestamp <= now).length;
}

export function isDuplicateContribution(
  recent: CivilizationMeta["recentMessages"],
  authorId: string,
  text: string,
  threadId: string,
  now: number,
  cooldownMs: number,
): boolean {
  const normalized = normalizeMessage(text);
  if (!normalized) return true;
  return recent.some(
    (item) =>
      item.authorId === authorId &&
      item.threadId === threadId &&
      item.normalized === normalized &&
      now - item.at < cooldownMs,
  );
}

export function canAddConversationTurn(currentTurns: number, maximumTurns: number): boolean {
  return currentTurns < maximumTurns;
}

export function eligibleForWake(
  meta: CivilizationMeta,
  agentId: string,
  now: Date,
  recentAgentMessages: number[],
): boolean {
  const settings = meta.settings;
  return (
    !meta.paused &&
    settings.autonomous &&
    settings.mode === "automatic" &&
    !settings.perAgentPaused[agentId] &&
    !isQuietTime(
      now,
      settings.quietHoursEnabled,
      settings.quietHoursStart,
      settings.quietHoursEnd,
    ) &&
    activeWithinHour(recentAgentMessages, now.getTime()) <
      settings.maxMessagesPerAgentPerHour &&
    activeWithinHour(
      meta.recentAgentMessages.map((item) => item.at),
      now.getTime(),
    ) < settings.maxMessagesPerHour
  );
}

export function selectPendingQueue(
  queue: QueueRecord[],
  maxConcurrent: number,
): QueueRecord[] {
  const inFlight = queue.filter((item) => item.status === "dispatched").length;
  const available = Math.max(0, maxConcurrent - inFlight);
  return queue
    .filter((item) => item.status === "pending")
    .sort((left, right) => right.priority - left.priority || left.createdAt - right.createdAt)
    .slice(0, available);
}

export function shouldRouteReply(params: {
  kind: MessageRecord["messageKind"];
  mentions: string[];
  replyToAgentId?: string;
  authorId: string;
  roomAgentIds: string[];
}): string[] {
  const requested =
    params.mentions.length > 0
      ? params.mentions
      : params.kind === "help" || params.kind === "task"
        ? params.roomAgentIds
        : params.replyToAgentId
          ? [params.replyToAgentId]
          : [];
  return [...new Set(requested)].filter(
    (agentId) => agentId !== params.authorId && params.roomAgentIds.includes(agentId),
  );
}

export function buildWakePrompt(params: {
  agentName: string;
  roomName: string;
  wakeId: string;
  reason: string;
  roomAgents: Array<{ id: string; name: string }>;
  history: MessageRecord[];
  goals: GoalRecord[];
  tasks: TaskRecord[];
}): string {
  const history = params.history
    .slice(-20)
    .map(
      (message) =>
        `[${new Date(message.createdAt).toISOString()}] id=${message.id} author=${message.authorId} ${message.authorName}: ${message.text}`,
    )
    .join("\n");
  const roomAgents = params.roomAgents
    .map((agent) => `- ${agent.id}: ${agent.name}`)
    .join("\n");
  const goals = params.goals
    .filter((goal) => goal.status !== "completed")
    .map((goal) => `- ${goal.text} (${goal.status})`)
    .join("\n");
  const tasks = params.tasks
    .filter((task) => task.status === "open" || task.status === "accepted")
    .map(
      (task) =>
        `- ${task.id}: ${task.title} [${task.status}]${task.assigneeId ? ` -> ${task.assigneeId}` : ""}: ${task.description}`,
    )
    .join("\n");
  return [
    `You are participating as ${params.agentName} in OpenClaw Group. This is a background wake-up, not a human request.`,
    `Room: ${params.roomName}. Wake token: ${params.wakeId}. Reason: ${params.reason}.`,
    "Use your own existing OpenClaw identity, session history, and memory normally. Room data below is explicitly shared context only; do not expose private memory or imply that another agent has your session context.",
    "Decide whether you have a useful, timely contribution. Never post just to stay active. If there is nothing useful to say, call the tool with kind no_contribution to release this wake without posting.",
    "If you contribute, use the group_chat_contribute tool with this wake token. Use message for a relevant reply, help when you need assistance, offer when volunteering, task when assigning useful work, decision for a durable decision, goal to propose a shared goal, and the task action kinds to update task status. Set replyToId to the message id you are answering; mention IDs from the room agent list only when you need those specific agents.",
    "Agents in this room:",
    roomAgents || "(No other agents are in this room.)",
    "Relevant recent room messages:",
    history || "(No previous room messages.)",
    "Shared goals:",
    goals || "(No active shared goals.)",
    "Open tasks:",
    tasks || "(No open tasks.)",
  ].join("\n\n");
}
