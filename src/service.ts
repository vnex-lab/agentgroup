import { randomUUID } from "node:crypto";
import type { OpenClawPluginApi, PluginServiceSchedulerV1 } from "openclaw/plugin-sdk/plugin-entry";
import type { FeatureEventEmitter } from "openclaw/plugin-sdk/feature-plugin";
import {
  activeWithinHour,
  buildWakePrompt,
  canAddConversationTurn,
  createMeta,
  eligibleForWake,
  isDuplicateContribution,
  isQuietTime,
  normalizeMessage,
  selectPendingQueue,
  shouldRouteReply,
  type ActivityRecord,
  type CivilizationMeta,
  type GoalRecord,
  type MessageRecord,
  type QueueRecord,
  type RoomRecord,
  type StoredRecord,
  type TaskRecord,
} from "./model.js";
import { contract } from "./contract.js";

const STORE_NAMESPACE = "civilization";
const STORE_MAX_ENTRIES = 40_000;
const ROOM_MESSAGE_LIMIT = 300;
const ROOM_LIMIT = 100;
const ACTIVITY_LIMIT = 500;
const QUEUE_LIMIT = 1_000;
const ROOM_AGENT_LIMIT = 32;
const QUEUE_TTL_MS = 30 * 60_000;
const QUEUE_RETENTION_MS = 24 * 60 * 60_000;
const SERVICE_TICK_MS = 60_000;

type JsonRecord = Record<string, unknown>;
type ChangeAction =
  | "create_room"
  | "rename_room"
  | "delete_room"
  | "invite_agent"
  | "remove_agent"
  | "send_message"
  | "react"
  | "pause_all"
  | "set_settings"
  | "pause_agent"
  | "interrupt_agent"
  | "create_task"
  | "update_task"
  | "create_goal"
  | "update_goal";

const asObject = (value: unknown): JsonRecord => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected an object payload.");
  }
  return value as JsonRecord;
};

const boundedString = (value: unknown, name: string, maximum: number): string => {
  if (typeof value !== "string" || !value.trim() || value.length > maximum) {
    throw new Error(`${name} must be a non-empty string of at most ${maximum} characters.`);
  }
  return value.trim();
};

const id = (prefix: string): string => `${prefix}-${randomUUID()}`;
const keyFor = (recordId: string): string => recordId;
const iso = (value: number): string => new Date(value).toISOString();

function isKind<T extends StoredRecord["kind"]>(
  value: StoredRecord | undefined,
  kind: T,
): value is Extract<StoredRecord, { kind: T }> {
  return value?.kind === kind;
}

function normalizeMeta(record: StoredRecord | undefined): CivilizationMeta {
  if (!isKind(record, "meta") || record.version !== 1) return createMeta();
  const defaults = createMeta();
  return {
    ...record,
    settings: {
      ...defaults.settings,
      ...record.settings,
      perAgentPaused: {
        ...defaults.settings.perAgentPaused,
        ...record.settings?.perAgentPaused,
      },
    },
    roomIds: Array.isArray(record.roomIds) ? record.roomIds : [],
    goalIds: Array.isArray(record.goalIds) ? record.goalIds : [],
    taskIds: Array.isArray(record.taskIds) ? record.taskIds : [],
    activityIds: Array.isArray(record.activityIds) ? record.activityIds : [],
    lastReflectionAt: record.lastReflectionAt ?? {},
    recentAgentMessages: record.recentAgentMessages ?? [],
    recentMessages: record.recentMessages ?? [],
  };
}

export function createGroupService(
  api: OpenClawPluginApi,
  events: FeatureEventEmitter<typeof contract>,
) {
  const store = api.runtime.state.openKeyedStoreV2<StoredRecord>({
    namespace: STORE_NAMESPACE,
    maxEntries: STORE_MAX_ENTRIES,
    overflowPolicy: "reject-new",
  });
  let records: Map<string, StoredRecord> | undefined;
  let writeChain: Promise<void> = Promise.resolve();

  const load = async () => {
    if (records) return;
    const entries = await store.entries();
    records = new Map(entries.map(({ key, value }) => [key, value]));
    let meta = normalizeMeta(records.get("meta"));
    if (!records.has("meta")) {
      await store.register("meta", meta);
      records.set("meta", meta);
    }
    if (meta.roomIds.length === 0) {
      const room: RoomRecord = {
        kind: "room",
        id: id("room"),
        name: "General",
        agentIds: [],
        messageIds: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      meta = { ...meta, roomIds: [room.id], revision: meta.revision + 1 };
      await store.register(room.id, room);
      await store.register("meta", meta);
      records.set(room.id, room);
      records.set("meta", meta);
    }
  };

  const put = async (recordId: string, record: StoredRecord) => {
    await store.register(keyFor(recordId), record);
    records?.set(keyFor(recordId), record);
  };

  const remove = async (recordId: string) => {
    await store.delete(keyFor(recordId));
    records?.delete(keyFor(recordId));
  };

  const transaction = <T>(work: () => Promise<T>): Promise<T> => {
    const result = writeChain.then(async () => {
      await load();
      return work();
    });
    writeChain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  const getMeta = (): CivilizationMeta => normalizeMeta(records?.get("meta"));
  const getRoom = (roomId: string): RoomRecord => {
    const room = records?.get(roomId);
    if (!isKind(room, "room")) throw new Error("That room no longer exists.");
    return room;
  };
  const getMessage = (messageId: string): MessageRecord | undefined => {
    const message = records?.get(messageId);
    return isKind(message, "message") ? message : undefined;
  };
  const getTask = (taskId: string): TaskRecord | undefined => {
    const task = records?.get(taskId);
    return isKind(task, "task") ? task : undefined;
  };

  const saveMeta = async (meta: CivilizationMeta) => put("meta", meta);

  const activity = async (
    actorId: string,
    actorName: string,
    text: string,
    priority: ActivityRecord["priority"] = "normal",
  ) => {
    const meta = getMeta();
    const record: ActivityRecord = {
      kind: "activity",
      id: id("activity"),
      actorId,
      actorName,
      text: text.slice(0, 1_000),
      priority,
      createdAt: Date.now(),
    };
    await put(record.id, record);
    const ids = [...meta.activityIds, record.id];
    for (const expired of ids.slice(0, Math.max(0, ids.length - ACTIVITY_LIMIT))) {
      await remove(expired);
    }
    await saveMeta({ ...meta, activityIds: ids.slice(-ACTIVITY_LIMIT) });
  };

  const currentAgentProfiles = () => {
    const configured = api.config.agents?.list ?? [];
    return configured.flatMap((agent) => {
      if (typeof agent.id !== "string" || !agent.id) return [];
      return [{
        id: agent.id,
        name: agent.identity?.name || agent.name || agent.id,
        avatar: agent.identity?.avatar,
      }];
    });
  };

  const assertConfiguredAgent = (agentId: string) => {
    const profiles = currentAgentProfiles();
    if (profiles.length > 0 && !profiles.some((profile) => profile.id === agentId)) {
      throw new Error("That agent is not in the current OpenClaw agent configuration.");
    }
    if (!/^[a-zA-Z0-9._-]{1,128}$/u.test(agentId)) {
      throw new Error("The agent ID is invalid.");
    }
  };

  const profileFor = (agentId: string) =>
    currentAgentProfiles().find((profile) => profile.id === agentId) ?? {
      id: agentId,
      name: agentId,
      avatar: undefined,
    };

  const createMessage = async (params: {
    room: RoomRecord;
    authorId: string;
    authorName: string;
    authorAvatar?: string;
    text: string;
    messageKind: MessageRecord["messageKind"];
    replyToId?: string;
    threadId?: string;
  }): Promise<MessageRecord> => {
    const now = Date.now();
    const threadId =
      params.threadId ??
      (params.replyToId ? getMessage(params.replyToId)?.threadId : undefined) ??
      id("thread");
    const message: MessageRecord = {
      kind: "message",
      id: id("message"),
      roomId: params.room.id,
      threadId,
      replyToId: params.replyToId,
      authorId: params.authorId,
      authorName: params.authorName,
      authorAvatar: params.authorAvatar,
      text: params.text,
      messageKind: params.messageKind,
      createdAt: now,
      reactions: {},
    };
    await put(message.id, message);
    const ids = [...params.room.messageIds, message.id];
    for (const expired of ids.slice(0, Math.max(0, ids.length - ROOM_MESSAGE_LIMIT))) {
      await remove(expired);
    }
    await put(params.room.id, {
      ...params.room,
      messageIds: ids.slice(-ROOM_MESSAGE_LIMIT),
      updatedAt: now,
    });
    const meta = getMeta();
    await saveMeta({
      ...meta,
      recentMessages: [
        ...meta.recentMessages,
        {
          authorId: params.authorId,
          normalized: normalizeMessage(params.text),
          at: now,
          threadId,
        },
      ].slice(-500),
      revision: meta.revision + 1,
    });
    return message;
  };

  const addQueue = async (params: {
    roomId: string;
    agentId: string;
    threadId: string;
    triggerMessageId?: string;
    reason: string;
    priority?: number;
  }) => {
    const pending = [...(records?.values() ?? [])].filter(
      (record) => isKind(record, "queue") && (record.status === "pending" || record.status === "dispatched"),
    ).length;
    const meta = getMeta();
    if (pending >= Math.min(QUEUE_LIMIT, meta.settings.maxBackgroundTasks)) return false;
    const item: QueueRecord = {
      kind: "queue",
      id: id("wake"),
      roomId: params.roomId,
      agentId: params.agentId,
      threadId: params.threadId,
      triggerMessageId: params.triggerMessageId,
      reason: params.reason,
      priority: params.priority ?? 1,
      status: "pending",
      createdAt: Date.now(),
    };
    await put(item.id, item);
    return true;
  };

  const enqueueRecipients = async (
    room: RoomRecord,
    message: MessageRecord,
    recipients: string[],
    reason: string,
    priority: number,
  ) => {
    const activeIds = recipients.filter((agentId) => {
      try {
        assertConfiguredAgent(agentId);
        return true;
      } catch (cause) {
        api.logger.warn(`Skipping an unavailable Group agent ${agentId}: ${String(cause)}`);
        return false;
      }
    });
    for (const agentId of activeIds) {
      const queued = await addQueue({
        roomId: room.id,
        agentId,
        threadId: message.threadId,
        triggerMessageId: message.id,
        reason,
        priority,
      });
      if (!queued) {
        await activity("system", "Group", "The background task queue is full; some agents were not notified.", "human");
      }
    }
  };

  const snapshot = (roomId?: string, search?: string) =>
    transaction(async () => {
      const meta = getMeta();
      const rooms = meta.roomIds
        .map((roomKey) => records?.get(roomKey))
        .filter((room): room is RoomRecord => isKind(room, "room"));
      const selectedRoom =
        rooms.find((room) => room.id === roomId) ?? rooms[0];
      const needle = search?.trim().toLocaleLowerCase() ?? "";
      const messages = selectedRoom
        ? selectedRoom.messageIds
            .map((messageId) => getMessage(messageId))
            .filter((message): message is MessageRecord => Boolean(message))
            .filter((message) => !needle || message.text.toLocaleLowerCase().includes(needle))
            .slice(-40)
        : [];
      const goals = meta.goalIds
        .map((goalId) => records?.get(goalId))
        .filter((goal): goal is GoalRecord => isKind(goal, "goal"))
        .slice(-20);
      const tasks = meta.taskIds
        .map((taskId) => records?.get(taskId))
        .filter((task): task is TaskRecord => isKind(task, "task"))
        .filter((task) => !selectedRoom || task.roomId === selectedRoom.id)
        .slice(-10);
      const activities = meta.activityIds
        .map((activityId) => records?.get(activityId))
        .filter((entry): entry is ActivityRecord => isKind(entry, "activity"))
        .slice(-20)
        .reverse();
      const queue = [...(records?.values() ?? [])].filter(
        (record): record is QueueRecord => isKind(record, "queue"),
      );
      const currentTime = Date.now();
      const data = {
        revision: meta.revision,
        paused: meta.paused,
        settings: meta.settings,
        rooms: rooms.map((room) => ({
          id: room.id,
          name: room.name,
          agentIds: room.id === selectedRoom?.id ? room.agentIds : [],
          messageCount: room.messageIds.length,
          updatedAt: room.updatedAt,
        })),
        selectedRoomId: selectedRoom?.id,
        messages,
        goals,
        tasks,
        activities,
        queue: queue
          .filter(({ status }) => status === "dispatched")
          .map(({ agentId, roomId: queuedRoomId, dispatchedAt }) => ({
          agentId,
          roomId: queuedRoomId,
          dispatchedAt,
          })),
        usage: {
          wakesLastHour: activeWithinHour(
            queue
              .filter((item) => item.dispatchedAt !== undefined)
              .map((item) => item.dispatchedAt ?? item.createdAt),
            currentTime,
          ),
          messagesLastHour: activeWithinHour(
            meta.recentAgentMessages.map((item) => item.at),
            currentTime,
          ),
          queuedTasks: queue.filter((item) => item.status === "pending").length,
        },
      };
      return { json: JSON.stringify(data) };
    });

  const change = (action: ChangeAction, rawJson: string) =>
    transaction(async () => {
      const input = asObject(JSON.parse(rawJson) as unknown);
      const meta = getMeta();
      let result: JsonRecord = { ok: true };

      switch (action) {
        case "create_room": {
          if (meta.roomIds.length >= ROOM_LIMIT) throw new Error(`Room limit reached (${ROOM_LIMIT}).`);
          const room: RoomRecord = {
            kind: "room",
            id: id("room"),
            name: boundedString(input.name, "Room name", 80),
            agentIds: [],
            messageIds: [],
            createdAt: Date.now(),
            updatedAt: Date.now(),
          };
          await put(room.id, room);
          await saveMeta({ ...meta, roomIds: [...meta.roomIds, room.id], revision: meta.revision + 1 });
          result = { ok: true, roomId: room.id };
          break;
        }
        case "rename_room": {
          const room = getRoom(boundedString(input.roomId, "Room ID", 128));
          await put(room.id, { ...room, name: boundedString(input.name, "Room name", 80), updatedAt: Date.now() });
          await saveMeta({ ...meta, revision: meta.revision + 1 });
          break;
        }
        case "delete_room": {
          const room = getRoom(boundedString(input.roomId, "Room ID", 128));
          if (meta.roomIds.length <= 1) throw new Error("Keep at least one room in the civilization.");
          const taskIds = meta.taskIds.filter((taskId) => getTask(taskId)?.roomId !== room.id);
          for (const recordId of room.messageIds) await remove(recordId);
          for (const taskId of meta.taskIds.filter((taskId) => !taskIds.includes(taskId))) await remove(taskId);
          for (const record of [...(records?.values() ?? [])]) {
            if (isKind(record, "queue") && record.roomId === room.id) await remove(record.id);
          }
          await remove(room.id);
          await saveMeta({
            ...meta,
            roomIds: meta.roomIds.filter((roomId) => roomId !== room.id),
            taskIds,
            revision: meta.revision + 1,
          });
          break;
        }
        case "invite_agent": {
          const room = getRoom(boundedString(input.roomId, "Room ID", 128));
          const agentId = boundedString(input.agentId, "Agent ID", 128);
          assertConfiguredAgent(agentId);
          if (!room.agentIds.includes(agentId)) {
            if (room.agentIds.length >= ROOM_AGENT_LIMIT) {
              throw new Error(`Room agent limit reached (${ROOM_AGENT_LIMIT}).`);
            }
            await put(room.id, { ...room, agentIds: [...room.agentIds, agentId], updatedAt: Date.now() });
            await activity(agentId, profileFor(agentId).name, `Joined ${room.name}.`);
          }
          await saveMeta({ ...getMeta(), revision: getMeta().revision + 1 });
          break;
        }
        case "remove_agent": {
          const room = getRoom(boundedString(input.roomId, "Room ID", 128));
          const agentId = boundedString(input.agentId, "Agent ID", 128);
          await put(room.id, {
            ...room,
            agentIds: room.agentIds.filter((member) => member !== agentId),
            updatedAt: Date.now(),
          });
          for (const record of [...(records?.values() ?? [])]) {
            if (isKind(record, "queue") && record.agentId === agentId && record.roomId === room.id) {
              await remove(record.id);
            }
          }
          await saveMeta({ ...meta, revision: meta.revision + 1 });
          break;
        }
        case "send_message": {
          const room = getRoom(boundedString(input.roomId, "Room ID", 128));
          const text = boundedString(input.text, "Message", 8_000);
          const replyToId = typeof input.replyToId === "string" ? input.replyToId : undefined;
          if (replyToId && getMessage(replyToId)?.roomId !== room.id) throw new Error("Reply target is not in this room.");
          const requested = Array.isArray(input.recipientIds)
            ? input.recipientIds.filter((value): value is string => typeof value === "string")
            : room.agentIds;
          const recipients = [...new Set(requested)].filter((agentId) => room.agentIds.includes(agentId));
          const message = await createMessage({
            room,
            authorId: "human",
            authorName: "You",
            text,
            messageKind: "message",
            replyToId,
          });
          await enqueueRecipients(room, message, recipients, "human", 4);
          await activity("human", "You", `Posted in ${room.name}.`);
          result = { ok: true, messageId: message.id };
          break;
        }
        case "react": {
          const message = getMessage(boundedString(input.messageId, "Message ID", 128));
          if (!message) throw new Error("That message no longer exists.");
          const reaction = boundedString(input.reaction, "Reaction", 16);
          if (!/^[\p{Extended_Pictographic}\uFE0F\u200D]+$/u.test(reaction)) throw new Error("Reaction must be an emoji.");
          const reactions = { ...message.reactions };
          const reactors = new Set(reactions[reaction] ?? []);
          if (reactors.has("human")) reactors.delete("human");
          else reactors.add("human");
          if (reactors.size) reactions[reaction] = [...reactors];
          else delete reactions[reaction];
          await put(message.id, { ...message, reactions });
          await saveMeta({ ...meta, revision: meta.revision + 1 });
          break;
        }
        case "pause_all": {
          if (typeof input.paused !== "boolean") throw new Error("paused must be true or false.");
          await saveMeta({ ...meta, paused: input.paused, revision: meta.revision + 1 });
          if (input.paused) {
            for (const record of [...(records?.values() ?? [])]) {
              if (isKind(record, "queue")) {
                if (record.status === "pending") await remove(record.id);
                else if (record.status === "dispatched") await put(record.id, { ...record, status: "failed" });
              }
            }
          }
          await activity("human", "You", input.paused ? "Paused all Group agents." : "Resumed Group agents.", "important");
          break;
        }
        case "set_settings": {
          const patch = asObject(input.settings);
          const settings = { ...meta.settings };
          const integerRanges: Record<string, [number, number]> = {
            wakeIntervalMinutes: [5, 1440],
            maxBackgroundTasks: [1, 200],
            maxConcurrentExecutions: [1, 8],
            maxMessagesPerHour: [1, 200],
            maxMessagesPerAgentPerHour: [1, 50],
            maxConversationTurns: [2, 30],
            cooldownSeconds: [0, 3600],
          };
          const setInteger = (key: string, value: number) => {
            switch (key) {
              case "wakeIntervalMinutes": settings.wakeIntervalMinutes = value; break;
              case "maxBackgroundTasks": settings.maxBackgroundTasks = value; break;
              case "maxConcurrentExecutions": settings.maxConcurrentExecutions = value; break;
              case "maxMessagesPerHour": settings.maxMessagesPerHour = value; break;
              case "maxMessagesPerAgentPerHour": settings.maxMessagesPerAgentPerHour = value; break;
              case "maxConversationTurns": settings.maxConversationTurns = value; break;
              case "cooldownSeconds": settings.cooldownSeconds = value; break;
            }
          };
          for (const [key, [min, max]] of Object.entries(integerRanges)) {
            if (patch[key] === undefined) continue;
            const value = patch[key];
            if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
              throw new Error(`${key} must be an integer from ${min} to ${max}.`);
            }
            setInteger(key, value);
          }
          for (const key of ["autonomous", "quietHoursEnabled"] as const) {
            if (patch[key] !== undefined) {
              if (typeof patch[key] !== "boolean") throw new Error(`${key} must be true or false.`);
              settings[key] = patch[key];
            }
          }
          if (patch.mode !== undefined) {
            if (patch.mode !== "automatic" && patch.mode !== "manual") throw new Error("mode must be automatic or manual.");
            settings.mode = patch.mode;
          }
          for (const key of ["quietHoursStart", "quietHoursEnd"] as const) {
            if (patch[key] !== undefined) {
              if (typeof patch[key] !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/u.test(patch[key])) {
                throw new Error(`${key} must use HH:MM 24-hour time.`);
              }
              settings[key] = patch[key];
            }
          }
          await saveMeta({ ...meta, settings, revision: meta.revision + 1 });
          if (!settings.autonomous || settings.mode === "manual") {
            for (const record of [...(records?.values() ?? [])]) {
              if (isKind(record, "queue") && record.reason !== "human") {
                if (record.status === "pending") await remove(record.id);
                else if (record.status === "dispatched") await put(record.id, { ...record, status: "failed" });
              }
            }
          }
          break;
        }
        case "pause_agent": {
          const agentId = boundedString(input.agentId, "Agent ID", 128);
          assertConfiguredAgent(agentId);
          if (typeof input.paused !== "boolean") throw new Error("paused must be true or false.");
          const settings = {
            ...meta.settings,
            perAgentPaused: { ...meta.settings.perAgentPaused, [agentId]: input.paused },
          };
          await saveMeta({ ...meta, settings, revision: meta.revision + 1 });
          if (input.paused) {
            for (const record of [...(records?.values() ?? [])]) {
              if (isKind(record, "queue") && record.agentId === agentId) {
                if (record.status === "pending") await remove(record.id);
                else if (record.status === "dispatched") await put(record.id, { ...record, status: "failed" });
              }
            }
          }
          await activity("human", "You", `${input.paused ? "Paused" : "Resumed"} ${profileFor(agentId).name}.`, "important");
          break;
        }
        case "interrupt_agent": {
          const agentId = boundedString(input.agentId, "Agent ID", 128);
          assertConfiguredAgent(agentId);
          for (const record of [...(records?.values() ?? [])]) {
            if (isKind(record, "queue") && record.agentId === agentId) {
              if (record.status === "pending") await remove(record.id);
              else if (record.status === "dispatched") await put(record.id, { ...record, status: "failed" });
            }
          }
          result = { ok: true, sessionKey: `agent:${agentId}:main` };
          break;
        }
        case "create_task": {
          const room = getRoom(boundedString(input.roomId, "Room ID", 128));
          const title = boundedString(input.title, "Task title", 240);
          const description = boundedString(input.description ?? title, "Task description", 4_000);
          const assigneeId = typeof input.assigneeId === "string" ? input.assigneeId : undefined;
          if (assigneeId) {
            assertConfiguredAgent(assigneeId);
            if (!room.agentIds.includes(assigneeId)) throw new Error("Invite the assignee to the room first.");
          }
          const task: TaskRecord = {
            kind: "task",
            id: id("task"),
            roomId: room.id,
            title,
            description,
            creatorId: "human",
            assigneeId,
            status: "open",
            createdAt: Date.now(),
            updatedAt: Date.now(),
            needsHuman: false,
          };
          await put(task.id, task);
          await saveMeta({ ...meta, taskIds: [...meta.taskIds, task.id].slice(-1_000), revision: meta.revision + 1 });
          const message = await createMessage({
            room,
            authorId: "human",
            authorName: "You",
            text: `Task: ${title}\n${description}`,
            messageKind: "task",
          });
          await enqueueRecipients(room, message, assigneeId ? [assigneeId] : room.agentIds, "human", 5);
          await activity("human", "You", `Created task: ${title}.`, "important");
          result = { ok: true, taskId: task.id };
          break;
        }
        case "update_task": {
          const task = getTask(boundedString(input.taskId, "Task ID", 128));
          if (!task) throw new Error("That task no longer exists.");
          const status = input.status;
          if (!["open", "accepted", "rejected", "completed"].includes(String(status))) {
            throw new Error("Task status is invalid.");
          }
          await put(task.id, {
            ...task,
            status: status as TaskRecord["status"],
            needsHuman: Boolean(input.needsHuman),
            updatedAt: Date.now(),
          });
          await saveMeta({ ...meta, revision: meta.revision + 1 });
          const room = getRoom(task.roomId);
          const message = await createMessage({
            room,
            authorId: "human",
            authorName: "You",
            text: `Task update: ${task.title} is now ${String(status)}.`,
            messageKind: "task",
          });
          await enqueueRecipients(room, message, room.agentIds, "human", 4);
          await activity("human", "You", `Updated task: ${task.title} (${String(status)}).`, "important");
          break;
        }
        case "create_goal": {
          const room = typeof input.roomId === "string" ? getRoom(input.roomId) : undefined;
          const goal: GoalRecord = {
            kind: "goal",
            id: id("goal"),
            text: boundedString(input.text, "Goal", 1_000),
            proposedBy: "human",
            status: "active",
            createdAt: Date.now(),
          };
          await put(goal.id, goal);
          await saveMeta({ ...meta, goalIds: [...meta.goalIds, goal.id].slice(-200), revision: meta.revision + 1 });
          if (room) {
            const message = await createMessage({
              room,
              authorId: "human",
              authorName: "You",
              text: `New shared goal: ${goal.text}`,
              messageKind: "decision",
            });
            await enqueueRecipients(room, message, room.agentIds, "human", 3);
          }
          await activity("human", "You", `Added shared goal: ${goal.text}.`, "important");
          break;
        }
        case "update_goal": {
          const goalId = boundedString(input.goalId, "Goal ID", 128);
          const goal = records?.get(goalId);
          if (!isKind(goal, "goal")) throw new Error("That goal no longer exists.");
          if (!["proposed", "active", "completed"].includes(String(input.status))) {
            throw new Error("Goal status is invalid.");
          }
          await put(goal.id, { ...goal, status: input.status as GoalRecord["status"] });
          await saveMeta({ ...meta, revision: meta.revision + 1 });
          break;
        }
      }

      emitChanged();
      return { json: JSON.stringify(result) };
    });

  const contribute = (
    input: {
      wakeId: string;
      roomId: string;
      kind: "message" | "no_contribution" | "help" | "offer" | "task" | "decision" | "goal" | "task_accept" | "task_reject" | "task_complete";
      text: string;
      mentions?: string[];
      replyToId?: string;
      taskId?: string;
      taskTitle?: string;
    },
    agentId: string,
  ) =>
    transaction(async () => {
      assertConfiguredAgent(agentId);
      const wake = records?.get(input.wakeId);
      if (!isKind(wake, "queue") || wake.status !== "dispatched" || wake.agentId !== agentId) {
        throw new Error("This Group wake has expired or does not belong to this agent.");
      }
      const room = getRoom(input.roomId);
      if (wake.roomId !== room.id || !room.agentIds.includes(agentId)) {
        throw new Error("The agent is no longer a member of this room.");
      }
      const now = Date.now();
      const meta = getMeta();
      if (input.kind === "no_contribution") {
        await put(wake.id, { ...wake, status: "done" });
        await saveMeta({ ...meta, revision: meta.revision + 1 });
        emitChanged();
        return { messageId: "no-contribution" };
      }
      if (meta.paused || meta.settings.perAgentPaused[agentId]) {
        throw new Error("This agent is currently paused in Group.");
      }
      if (
        wake.reason !== "human" &&
        (!meta.settings.autonomous ||
          meta.settings.mode !== "automatic" ||
          isQuietTime(
            new Date(now),
            meta.settings.quietHoursEnabled,
            meta.settings.quietHoursStart,
            meta.settings.quietHoursEnd,
          ))
      ) {
        throw new Error("Autonomous Group contributions are currently disabled.");
      }
      const lastMessageAt = [...meta.recentAgentMessages]
        .reverse()
        .find((item) => item.agentId === agentId)?.at;
      if (
        wake.reason !== "human" &&
        lastMessageAt !== undefined &&
        now - lastMessageAt < meta.settings.cooldownSeconds * 1000
      ) {
        throw new Error("This agent is in its configured Group cooldown.");
      }
      const activeMessages = meta.recentAgentMessages
        .filter((item) => item.agentId === agentId)
        .map((item) => item.at);
      if (
        activeWithinHour(activeMessages, now) >= meta.settings.maxMessagesPerAgentPerHour ||
        activeWithinHour(meta.recentAgentMessages.map((item) => item.at), now) >= meta.settings.maxMessagesPerHour
      ) {
        throw new Error("Group message budget reached; try again after the hourly limit resets.");
      }
      const threadMessages = room.messageIds
        .map((messageId) => getMessage(messageId))
        .filter((message): message is MessageRecord => message?.threadId === wake.threadId);
      if (!canAddConversationTurn(threadMessages.length, meta.settings.maxConversationTurns)) {
        await put(wake.id, { ...wake, status: "done" });
        throw new Error("This conversation reached its configured turn limit.");
      }
      if (
        isDuplicateContribution(
          meta.recentMessages,
          agentId,
          input.text,
          wake.threadId,
          now,
          meta.settings.cooldownSeconds * 1000,
        )
      ) {
        throw new Error("Duplicate or empty contribution suppressed.");
      }
      const profile = profileFor(agentId);
      if (input.kind === "goal") boundedString(input.text, "Goal", 1_000);
      const taskTitle =
        input.kind === "task"
          ? boundedString(input.taskTitle ?? input.text.slice(0, 100), "Task title", 240)
          : undefined;
      const taskAssignee =
        input.kind === "task"
          ? input.mentions?.find((target) => target !== agentId && room.agentIds.includes(target))
          : undefined;
      if (taskAssignee) assertConfiguredAgent(taskAssignee);
      const messageKind: MessageRecord["messageKind"] =
        input.kind === "help" || input.kind === "offer" || input.kind === "task" || input.kind === "decision"
          ? input.kind
          : "message";
      const targetMessageId = input.replyToId ?? wake.triggerMessageId;
      const targetMessage = targetMessageId ? getMessage(targetMessageId) : undefined;
      if (input.replyToId && targetMessage?.roomId !== room.id) {
        throw new Error("Reply target is not in this room.");
      }
      if (input.kind === "task" && input.taskTitle !== undefined) {
        boundedString(input.taskTitle, "Task title", 240);
      }
      if (input.kind === "task_accept" || input.kind === "task_reject" || input.kind === "task_complete") {
        const targetTask = input.taskId ? getTask(input.taskId) : undefined;
        if (!targetTask || targetTask.roomId !== room.id) throw new Error("The task is not available in this room.");
        if (targetTask.assigneeId && targetTask.assigneeId !== agentId) {
          throw new Error("Only the assigned agent may update this task.");
        }
      }
      const replyToId =
        targetMessage?.roomId === room.id ? targetMessage.id : undefined;
      const message = await createMessage({
        room,
        authorId: agentId,
        authorName: profile.name,
        authorAvatar: profile.avatar,
        text: boundedString(input.text, "Contribution", 8_000),
        messageKind,
        replyToId,
        threadId: wake.threadId,
      });

      if (input.kind === "task") {
        const task: TaskRecord = {
          kind: "task",
          id: id("task"),
          roomId: room.id,
          title: taskTitle ?? input.text.slice(0, 100),
          description: input.text,
          creatorId: agentId,
          assigneeId: taskAssignee,
          status: "open",
          createdAt: now,
          updatedAt: now,
          needsHuman: false,
        };
        await put(task.id, task);
        await saveMeta({
          ...getMeta(),
          taskIds: [...getMeta().taskIds, task.id].slice(-1_000),
          revision: getMeta().revision + 1,
        });
      } else if (input.kind === "goal") {
        const goal: GoalRecord = {
          kind: "goal",
          id: id("goal"),
          text: boundedString(input.text, "Goal", 1_000),
          proposedBy: agentId,
          status: "proposed",
          createdAt: now,
        };
        await put(goal.id, goal);
        const updatedMeta = getMeta();
        await saveMeta({
          ...updatedMeta,
          goalIds: [...updatedMeta.goalIds, goal.id].slice(-200),
          revision: updatedMeta.revision + 1,
        });
        await activity(agentId, profile.name, `Proposed a shared goal: ${goal.text}.`, "human");
      } else if (input.kind === "task_accept" || input.kind === "task_reject" || input.kind === "task_complete") {
        const task = input.taskId ? getTask(input.taskId) : undefined;
        if (!task || task.roomId !== room.id) throw new Error("The task is not available in this room.");
        if (task.assigneeId && task.assigneeId !== agentId) throw new Error("Only the assigned agent may update this task.");
        const status =
          input.kind === "task_accept" ? "accepted" : input.kind === "task_reject" ? "rejected" : "completed";
        await put(task.id, { ...task, assigneeId: task.assigneeId ?? agentId, status, updatedAt: now });
        if (status === "rejected") {
          await put(task.id, { ...task, assigneeId: task.assigneeId ?? agentId, status, updatedAt: now, needsHuman: true });
          await activity(agentId, profile.name, `Needs human help with: ${task.title}.`, "human");
        }
      }

      await put(wake.id, { ...wake, status: "done" });
      const updatedMeta = getMeta();
      await saveMeta({
        ...updatedMeta,
        recentAgentMessages: [
          ...updatedMeta.recentAgentMessages,
          { agentId, at: now },
        ].slice(-1_000),
        revision: updatedMeta.revision + 1,
      });
      await activity(
        agentId,
        profile.name,
        `${input.kind === "help" ? "Asked for help" : input.kind === "offer" ? "Offered help" : "Contributed"} in ${room.name}.`,
        input.kind === "help" ? "important" : "normal",
      );

      const replyToAgentId = targetMessage?.authorId;
      const recipients = shouldRouteReply({
        kind: input.kind === "goal" || input.kind.startsWith("task_") ? "task" : message.messageKind,
        mentions: input.mentions ?? [],
        replyToAgentId,
        authorId: agentId,
        roomAgentIds: room.agentIds,
      });
      await enqueueRecipients(room, message, recipients, "agent", input.kind === "help" || input.kind === "task" ? 4 : 2);
      emitChanged();
      return { messageId: message.id };
    });

  const emitChanged = () => {
    const revision = getMeta().revision;
    try {
      events.emit("changed", { revision });
    } catch (cause) {
      api.logger.warn(`Group event notification failed; clients will refresh on reconnect: ${String(cause)}`);
    }
  };

  const makePrompt = (queueItem: QueueRecord) => {
    const room = getRoom(queueItem.roomId);
    const meta = getMeta();
    const history = room.messageIds
      .map((messageId) => getMessage(messageId))
      .filter((message): message is MessageRecord => Boolean(message));
    const goals = meta.goalIds
      .map((goalId) => records?.get(goalId))
      .filter((goal): goal is GoalRecord => isKind(goal, "goal"));
    const tasks = meta.taskIds
      .map((taskId) => records?.get(taskId))
      .filter((task): task is TaskRecord => isKind(task, "task") && task.roomId === room.id);
    return buildWakePrompt({
      agentName: profileFor(queueItem.agentId).name,
      roomName: room.name,
      wakeId: queueItem.id,
      reason: queueItem.reason,
      roomAgents: room.agentIds.map((agentId) => ({
        id: agentId,
        name: profileFor(agentId).name,
      })),
      history,
      goals,
      tasks,
    });
  };

  const dispatch = async (scheduler: PluginServiceSchedulerV1) => {
    const now = Date.now();
    const toDispatch = await transaction(async () => {
      const meta = getMeta();
      const queued = [...(records?.values() ?? [])].filter(
        (record): record is QueueRecord => isKind(record, "queue"),
      );
      for (const item of queued) {
        if (item.status === "dispatched" && now - (item.dispatchedAt ?? item.createdAt) > QUEUE_TTL_MS) {
          await put(item.id, {
            ...item,
            status: item.reason === "scheduled reflection" ? "done" : "failed",
          });
          if (item.reason !== "scheduled reflection") {
            await activity(
              item.agentId,
              profileFor(item.agentId).name,
              "A Group wake expired without a contribution. The human owner can retry it.",
              "human",
            );
          }
        } else if (
          (item.status === "done" || item.status === "failed") &&
          now - item.createdAt > QUEUE_RETENTION_MS
        ) {
          await remove(item.id);
        }
      }

      if (meta.settings.autonomous && meta.settings.mode === "automatic" && !meta.paused) {
        const nowDate = new Date(now);
        const interval = meta.settings.wakeIntervalMinutes * 60_000;
        const reflectedAgents = new Set<string>();
        const rooms = meta.roomIds
          .map((roomId) => records?.get(roomId))
          .filter((room): room is RoomRecord => isKind(room, "room"));
        for (const room of rooms) {
          for (const agentId of room.agentIds) {
            if (reflectedAgents.has(agentId)) continue;
            if (now - (meta.lastReflectionAt[agentId] ?? 0) < interval) continue;
            const latestQueue = [...(records?.values() ?? [])].filter(
              (record): record is QueueRecord => isKind(record, "queue"),
            );
            if (
              latestQueue.some(
                (item) =>
                  item.agentId === agentId &&
                  (item.status === "pending" || item.status === "dispatched"),
              )
            ) {
              reflectedAgents.add(agentId);
              continue;
            }
            const profileMessages = latestQueue
              .filter((item) => item.agentId === agentId && item.dispatchedAt !== undefined)
              .map((item) => item.dispatchedAt ?? item.createdAt);
            if (!eligibleForWake(meta, agentId, nowDate, profileMessages)) continue;
            const recentDispatches = latestQueue
              .filter((item) => item.dispatchedAt !== undefined)
              .map((item) => item.dispatchedAt ?? item.createdAt);
            if (activeWithinHour(recentDispatches, now) >= meta.settings.maxMessagesPerHour) continue;
            const threadId = id("reflection");
            const accepted = await addQueue({
              roomId: room.id,
              agentId,
              threadId,
              reason: "scheduled reflection",
              priority: 0,
            });
            if (accepted) {
              const current = getMeta();
              await saveMeta({
                ...current,
                lastReflectionAt: { ...current.lastReflectionAt, [agentId]: now },
              });
              reflectedAgents.add(agentId);
            }
            break;
          }
        }
      }

      const liveQueue = [...(records?.values() ?? [])].filter(
        (record): record is QueueRecord => isKind(record, "queue"),
      );
      const candidates = selectPendingQueue(liveQueue, meta.settings.maxConcurrentExecutions);
      let activeQueueCount = liveQueue.filter(
        (item) => item.status === "pending" || item.status === "dispatched",
      ).length;
      const recentWakeTimes = liveQueue
        .filter((item) => item.dispatchedAt !== undefined)
        .map((item) => item.dispatchedAt ?? item.createdAt);
      let totalRecentWakes = activeWithinHour(recentWakeTimes, now);
      const recentWakesByAgent = new Map<string, number>();
      for (const item of liveQueue) {
        if (item.dispatchedAt === undefined || item.dispatchedAt <= now - 60 * 60_000 || item.dispatchedAt > now) continue;
        recentWakesByAgent.set(item.agentId, (recentWakesByAgent.get(item.agentId) ?? 0) + 1);
      }
      const eligible: QueueRecord[] = [];
      for (const item of candidates) {
        const current = getMeta();
        if (activeQueueCount > current.settings.maxBackgroundTasks) continue;
        if (current.paused || current.settings.perAgentPaused[item.agentId]) continue;
        if (
          totalRecentWakes >= current.settings.maxMessagesPerHour ||
          (recentWakesByAgent.get(item.agentId) ?? 0) >= current.settings.maxMessagesPerAgentPerHour
        ) continue;
        if (
          item.reason !== "human" &&
          (!current.settings.autonomous ||
            current.settings.mode !== "automatic" ||
            isQuietTime(
              new Date(now),
              current.settings.quietHoursEnabled,
              current.settings.quietHoursStart,
              current.settings.quietHoursEnd,
            ))
        ) continue;
        eligible.push(item);
        activeQueueCount += 1;
        totalRecentWakes += 1;
        recentWakesByAgent.set(item.agentId, (recentWakesByAgent.get(item.agentId) ?? 0) + 1);
      }
      const marked: QueueRecord[] = [];
      for (const item of eligible) {
        const updated = { ...item, status: "dispatched" as const, dispatchedAt: now };
        await put(item.id, updated);
        marked.push(updated);
      }
      return marked;
    });

    for (const item of toDispatch) {
      try {
        const profile = profileFor(item.agentId);
        const prompt = makePrompt(item);
        const receipt = api.runtime.system.enqueueSessionEvent(prompt, {
          agentId: item.agentId,
          sessionKey: `agent:${item.agentId}:main`,
          contextKey: `group-chat:${item.roomId}:${item.threadId}`,
          createIfMissing: true,
          abortSignal: scheduler.signal,
        });
        const admission = await receipt.accepted;
        if (!admission.ok) throw new Error(admission.error);
        await transaction(async () => {
          await activity(item.agentId, profile.name, `Woke for ${item.reason}.`);
          emitChanged();
        });
      } catch (cause) {
        await transaction(async () => {
          const latest = records?.get(item.id);
          if (isKind(latest, "queue")) await put(item.id, { ...latest, status: "failed" });
          await activity(item.agentId, profileFor(item.agentId).name, `Could not start Group wake: ${String(cause)}`, "human");
          emitChanged();
        });
        api.logger.error(`Group could not start a wake for ${item.agentId}: ${String(cause)}`);
      }
    }
  };

  const backgroundService = {
    id: "group-coordinator",
    apiVersion: 2 as const,
    start({ scheduler }: { scheduler: PluginServiceSchedulerV1 }) {
      scheduler.schedule({
        id: "coordination",
        delayMs: 0,
        everyMs: SERVICE_TICK_MS,
        run: () => dispatch(scheduler),
      });
    },
  };

  const applyChange = (action: ChangeAction, json: string) => change(action, json);

  const addAgentContribution = (
    input: Parameters<typeof contribute>[0],
    agentId: string | undefined,
  ) => {
    if (!agentId) throw new Error("OpenClaw did not provide the invoking agent identity.");
    return contribute(input, agentId);
  };

  return {
    snapshot,
    applyChange,
    addAgentContribution,
    backgroundService,
  };
}
