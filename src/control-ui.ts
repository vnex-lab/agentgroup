import { createFeatureClient } from "openclaw/plugin-sdk/feature-contract";
import { defineControlUiPlugin } from "openclaw/plugin-sdk/control-ui";
import { contract } from "./contract.js";
import "./control-ui.css";

type Agent = { id: string; name: string; avatar?: string; status?: string };
type Message = {
  id: string;
  roomId: string;
  threadId: string;
  replyToId?: string;
  authorId: string;
  authorName: string;
  authorAvatar?: string;
  text: string;
  messageKind: string;
  createdAt: number;
  reactions: Record<string, string[]>;
};
type Room = { id: string; name: string; agentIds: string[]; messageCount: number; updatedAt: number };
type Task = {
  id: string;
  title: string;
  description: string;
  assigneeId?: string;
  status: string;
  needsHuman: boolean;
};
type Goal = { id: string; text: string; status: string; proposedBy: string };
type Activity = { id: string; actorName: string; text: string; priority: string; createdAt: number };
type ChangeName =
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
type Snapshot = {
  revision: number;
  paused: boolean;
  settings: {
    autonomous: boolean;
    mode: "automatic" | "manual";
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
  rooms: Room[];
  selectedRoomId?: string;
  messages: Message[];
  goals: Goal[];
  tasks: Task[];
  activities: Activity[];
  queue: Array<{ agentId: string; roomId: string; dispatchedAt?: number }>;
  usage: {
    wakesLastHour: number;
    messagesLastHour: number;
    queuedTasks: number;
  };
};

const browserContract = {
  pluginId: contract.pluginId,
  operations: {
    snapshot: { kind: "query" },
    change: { kind: "action" },
    contribute: { kind: "action" },
  },
} as const;

const reactions = ["👍", "❤️", "💡"];

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function discoverAgents(response: unknown): Agent[] {
  const record = object(response);
  const rows = Array.isArray(response) ? response : Array.isArray(record?.agents) ? record.agents : [];
  return rows.flatMap((item) => {
    const agent = object(item);
    if (!agent) return [];
    const identity = object(agent.identity);
    const id = typeof agent.id === "string" ? agent.id : typeof agent.agentId === "string" ? agent.agentId : "";
    if (!id) return [];
    return [
      {
        id,
        name:
          (typeof identity?.name === "string" && identity.name) ||
          (typeof agent.name === "string" && agent.name) ||
          id,
        avatar:
          (typeof identity?.avatar === "string" && identity.avatar) ||
          (typeof agent.avatar === "string" && agent.avatar) ||
          undefined,
        status: typeof agent.status === "string" ? agent.status : undefined,
      },
    ];
  });
}

function parseSnapshot(json: string): Snapshot {
  const value: unknown = JSON.parse(json);
  const data = object(value);
  if (!data || !Array.isArray(data.rooms) || !Array.isArray(data.messages)) {
    throw new Error("Group returned an invalid snapshot.");
  }
  return data as unknown as Snapshot;
}

function button(label: string, className = "gc-button"): HTMLButtonElement {
  const element = document.createElement("button");
  element.type = "button";
  element.className = className;
  element.textContent = label;
  return element;
}

function text(value: string, className?: string): HTMLSpanElement {
  const element = document.createElement("span");
  if (className) element.className = className;
  element.textContent = value;
  return element;
}

function avatar(agent: Agent | undefined, fallback: string): HTMLElement {
  if (agent?.avatar) {
    const image = document.createElement("img");
    image.className = "gc-avatar";
    image.src = agent.avatar;
    image.alt = "";
    image.referrerPolicy = "no-referrer";
    image.onerror = () => image.replaceWith(text(fallback.slice(0, 1).toUpperCase(), "gc-avatar gc-avatar-fallback"));
    return image;
  }
  return text(fallback.slice(0, 1).toUpperCase(), "gc-avatar gc-avatar-fallback");
}

export default defineControlUiPlugin({
  id: contract.pluginId,
  activate(host) {
    host.ui.registerNavigation({
      id: "group",
      label: "Group",
      page: { id: "group" },
      icon: "messagesSquare",
    });
    host.ui.registerPage({
      id: "group",
      label: "Group",
      mount(container, context) {
        const feature = createFeatureClient<typeof contract>(browserContract, context.host);
        const shell = document.createElement("main");
        shell.className = "gc-shell";
        container.append(shell);

        let current: Snapshot | undefined;
        let discovered: Agent[] = [];
        let roomId: string | undefined;
        let search = "";
        let draft = "";
        let replyingTo: Message | undefined;
        let notice = "";
        let disposer: (() => void) | undefined;
        let debounce: ReturnType<typeof setTimeout> | undefined;
        let pending = false;

        const setNotice = (message: string) => {
          notice = message;
          render();
        };

        const refresh = async () => {
          if (context.signal.aborted) return;
          try {
            const result = await feature.invoke("snapshot", { roomId, search });
            if (context.signal.aborted) return;
            current = parseSnapshot(result.json);
            roomId = current.selectedRoomId;
            render();
          } catch (cause) {
            if (!context.signal.aborted) setNotice(`Could not load Group: ${String(cause)}`);
          }
        };

        const watch = () => {
          disposer?.();
          disposer = feature.watch("snapshot", { roomId, search }, {
            events: ["changed"],
            onChange(result) {
              if (!context.signal.aborted) {
                current = parseSnapshot(result.json);
                roomId = current.selectedRoomId;
                render();
              }
            },
            onError(cause) {
              if (!context.signal.aborted) setNotice(`Group refresh failed: ${String(cause)}`);
            },
          });
        };

        const runChange = async (action: ChangeName, data: Record<string, unknown>) => {
          if (pending) return undefined;
          pending = true;
          try {
            const result = await feature.invoke("change", { action, json: JSON.stringify(data) });
            const parsed: unknown = JSON.parse(result.json);
            await refresh();
            return object(parsed);
          } catch (cause) {
            setNotice(String(cause));
            return undefined;
          } finally {
            pending = false;
          }
        };

        const loadAgentDirectory = async () => {
          try {
            const response = await context.host.request("agents.list");
            if (!context.signal.aborted) {
              discovered = discoverAgents(response);
              render();
            }
          } catch (cause) {
            if (!context.signal.aborted) {
              discovered = [];
              setNotice(`Agent discovery needs Gateway permission: ${String(cause)}`);
            }
          }
        };

        const agentFor = (id: string): Agent | undefined =>
          discovered.find((agent) => agent.id === id);

        const makeElement = <K extends keyof HTMLElementTagNameMap>(
          tag: K,
          className?: string,
          label?: string,
        ): HTMLElementTagNameMap[K] => {
          const element = document.createElement(tag);
          if (className) element.className = className;
          if (label) element.textContent = label;
          return element;
        };

        const runInterrupt = async (agent: Agent) => {
          const result = await runChange("interrupt_agent", { agentId: agent.id });
          if (!result) return;
          try {
            await context.host.request("sessions.abort", {
              key: `agent:${agent.id}:main`,
              clearQueued: true,
            });
            setNotice(`${agent.name} was interrupted.`);
          } catch (cause) {
            setNotice(`Group wakes for ${agent.name} were stopped, but Gateway session interruption was denied or failed: ${String(cause)}`);
          }
        };

        const render = () => {
          if (!current) {
            shell.replaceChildren(makeElement("div", "gc-loading", notice || "Connecting to your OpenClaw Gateway…"));
            return;
          }
          const activeRoom = current.rooms.find((room) => room.id === (roomId ?? current?.selectedRoomId));
          const wrapper = makeElement("div", "gc-layout");
          const sidebar = makeElement("aside", "gc-sidebar");
          const brand = makeElement("div", "gc-brand");
          brand.append(makeElement("div", "gc-brand-mark", "G"), makeElement("div", "gc-brand-copy", "GROUP"));
          brand.append(makeElement("small", "", "OpenClaw civilization"));
          sidebar.append(brand);

          const roomHeading = makeElement("div", "gc-section-heading");
          roomHeading.append(text("ROOMS"), button("+", "gc-icon-button"));
          roomHeading.lastElementChild?.addEventListener("click", async () => {
            const name = window.prompt("Room name");
            if (!name?.trim()) return;
            const result = await runChange("create_room", { name: name.trim() });
            if (typeof result?.roomId === "string") {
              roomId = result.roomId;
              watch();
            }
          });
          sidebar.append(roomHeading);
          const roomList = makeElement("nav", "gc-room-list");
          for (const room of current.rooms) {
            const row = button("", `gc-room-link${room.id === activeRoom?.id ? " selected" : ""}`);
            row.append(text("#", "gc-room-hash"), text(room.name, "gc-room-name"));
            row.addEventListener("click", () => {
              roomId = room.id;
              watch();
              void refresh();
            });
            roomList.append(row);
          }
          sidebar.append(roomList);
          const newRoom = button("＋  Create room", "gc-subtle-button");
          newRoom.addEventListener("click", async () => {
            const name = window.prompt("Room name");
            if (!name?.trim()) return;
            const result = await runChange("create_room", { name: name.trim() });
            if (typeof result?.roomId === "string") {
              roomId = result.roomId;
              watch();
            }
          });
          sidebar.append(newRoom);

          const sidebarFooter = makeElement("div", "gc-sidebar-footer");
          const systemStatus = makeElement("div", `gc-status-line${current.paused ? " paused" : ""}`);
          systemStatus.append(makeElement("i", "gc-status-dot"), text(current.paused ? "Civilization paused" : "Civilization active"));
          sidebarFooter.append(systemStatus);
          const pauseAll = button(current.paused ? "Resume all agents" : "Pause all agents", "gc-subtle-button");
          pauseAll.addEventListener("click", async () => {
            const pausing = !current?.paused;
            const result = await runChange("pause_all", { paused: pausing });
            if (!result || !pausing) return;
            const failures: string[] = [];
            await Promise.all(discovered.map(async (agent) => {
              try {
                await context.host.request("sessions.abort", {
                  key: `agent:${agent.id}:main`,
                  clearQueued: true,
                });
              } catch (cause) {
                failures.push(`${agent.name} (${String(cause)})`);
              }
            }));
            setNotice(failures.length
              ? `Group is paused. Gateway could not interrupt these active sessions: ${failures.join(", ")}.`
              : "Group and all discovered agent sessions are paused.");
          });
          sidebarFooter.append(pauseAll);
          sidebar.append(sidebarFooter);

          const content = makeElement("section", "gc-content");
          const topbar = makeElement("header", "gc-topbar");
          const roomTitle = makeElement("div", "gc-title-block");
          roomTitle.append(makeElement("h1", "", activeRoom?.name ?? "Group"), makeElement("span", "gc-muted", "A place for your agents to work together"));
          topbar.append(roomTitle);
          topbar.append(makeElement(
            "span",
            "gc-usage",
            `${current.usage.wakesLastHour} wakes · ${current.usage.messagesLastHour} agent messages / hour · ${current.usage.queuedTasks} queued`,
          ));
          const searchInput = makeElement("input", "gc-search");
          searchInput.type = "search";
          searchInput.placeholder = "Search conversation…";
          searchInput.value = search;
          searchInput.setAttribute("aria-label", "Search conversation");
          searchInput.addEventListener("input", () => {
            search = searchInput.value;
            if (debounce) clearTimeout(debounce);
            debounce = setTimeout(() => {
              watch();
              void refresh();
            }, 250);
          });
          topbar.append(searchInput);
          if (activeRoom) {
            const roomMenu = button("•••", "gc-icon-button");
            roomMenu.title = "Room options";
            roomMenu.addEventListener("click", () => {
              const action = window.prompt("Type rename or delete");
              if (action === "rename") {
                const name = window.prompt("New room name", activeRoom.name);
                if (name?.trim()) void runChange("rename_room", { roomId: activeRoom.id, name: name.trim() });
              } else if (action === "delete" && window.confirm(`Delete #${activeRoom.name} and its history?`)) {
                void runChange("delete_room", { roomId: activeRoom.id }).then(() => {
                  roomId = undefined;
                  watch();
                });
              }
            });
            topbar.append(roomMenu);
          }
          content.append(topbar);

          const toolbar = makeElement("div", "gc-toolbar");
          toolbar.append(text(`${activeRoom?.agentIds.length ?? 0} agents`, "gc-member-count"));
          const manageAgents = button("Invite agent", "gc-small-button");
          manageAgents.disabled = !activeRoom;
          manageAgents.addEventListener("click", async () => {
            if (!activeRoom) return;
            const invited = new Set(activeRoom.agentIds);
            const available = discovered.filter((agent) => !invited.has(agent.id));
            if (!available.length) {
              setNotice("No additional agents are available. Agent discovery is based on your Gateway permissions.");
              return;
            }
            const choice = window.prompt(`Invite an agent by ID:\n${available.map((agent) => `${agent.id} — ${agent.name}`).join("\n")}`);
            const agent = available.find((item) => item.id === choice?.trim());
            if (agent) await runChange("invite_agent", { roomId: activeRoom.id, agentId: agent.id });
          });
          toolbar.append(manageAgents);
          content.append(toolbar);

          if (notice) {
            const banner = makeElement("div", "gc-notice", notice);
            const closeNotice = button("×", "gc-notice-close");
            closeNotice.addEventListener("click", () => {
              notice = "";
              render();
            });
            banner.append(closeNotice);
            content.append(banner);
          }

          const columns = makeElement("div", "gc-workspace");
          const conversation = makeElement("section", "gc-conversation");
          const transcript = makeElement("div", "gc-transcript");
          if (!current.messages.length) {
            const empty = makeElement("div", "gc-empty");
            empty.append(makeElement("div", "gc-empty-icon", "✦"), makeElement("h2", "", "A new conversation"), makeElement("p", "", "Share an idea, ask for help, or assign a task. Your agents can keep meaningful discussions moving on their own."));
            transcript.append(empty);
          }
          for (const message of current.messages) {
            const row = makeElement("article", `gc-message${message.authorId === "human" ? " human" : ""}`);
            const author = agentFor(message.authorId);
            row.append(avatar(author, message.authorName));
            const body = makeElement("div", "gc-message-body");
            const heading = makeElement("div", "gc-message-heading");
            heading.append(makeElement("strong", "", message.authorName));
            if (message.messageKind !== "message") heading.append(text(message.messageKind.replace("_", " "), `gc-kind gc-kind-${message.messageKind}`));
            heading.append(makeElement("time", "gc-time", new Date(message.createdAt).toLocaleString()));
            body.append(heading);
            if (message.replyToId) {
              const replied = current.messages.find((item) => item.id === message.replyToId);
              if (replied) body.append(makeElement("div", "gc-reply-context", `↪ ${replied.authorName}: ${replied.text.slice(0, 110)}`));
            }
            body.append(makeElement("p", "gc-message-text", message.text));
            const actions = makeElement("div", "gc-message-actions");
            const reply = button("Reply", "gc-message-action");
            reply.addEventListener("click", () => {
              replyingTo = message;
              render();
              shell.querySelector<HTMLTextAreaElement>(".gc-composer textarea")?.focus();
            });
            actions.append(reply);
            for (const emoji of reactions) {
              const count = message.reactions[emoji]?.length ?? 0;
              const react = button(`${emoji}${count ? ` ${count}` : ""}`, "gc-reaction");
              react.addEventListener("click", () => void runChange("react", { messageId: message.id, reaction: emoji }));
              actions.append(react);
            }
            body.append(actions);
            row.append(body);
            transcript.append(row);
          }
          conversation.append(transcript);

          const composer = makeElement("form", "gc-composer");
          composer.addEventListener("submit", async (event) => {
            event.preventDefault();
            const contentText = draft.trim();
            if (!contentText || !activeRoom || pending) return;
            const replyToId = replyingTo?.id;
            const mentions = discovered.filter((agent) => {
              const candidates = [agent.id, agent.name].map((candidate) => candidate.toLocaleLowerCase());
              return candidates.some((candidate) => new RegExp(`@${candidate.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}(?![\\w-])`, "iu").test(contentText));
            });
            const recipients = mentions.length > 0 ? mentions.map((agent) => agent.id) : activeRoom.agentIds;
            draft = "";
            replyingTo = undefined;
            await runChange("send_message", {
              roomId: activeRoom.id,
              text: contentText,
              replyToId,
              recipientIds: recipients,
            });
          });
          if (replyingTo) {
            const replyBar = makeElement("div", "gc-reply-bar", `Replying to ${replyingTo.authorName}: ${replyingTo.text.slice(0, 100)}`);
            const cancelReply = button("×", "gc-icon-button");
            cancelReply.addEventListener("click", () => {
              replyingTo = undefined;
              render();
            });
            replyBar.append(cancelReply);
            composer.append(replyBar);
          }
          const textarea = makeElement("textarea");
          textarea.placeholder = activeRoom ? `Message #${activeRoom.name} · use @name to route a mention` : "Select or create a room";
          textarea.value = draft;
          textarea.disabled = !activeRoom;
          textarea.rows = 3;
          textarea.setAttribute("aria-label", "Message the Group");
          textarea.addEventListener("input", () => {
            draft = textarea.value;
          });
          textarea.addEventListener("keydown", (event) => {
            if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
              event.preventDefault();
              composer.requestSubmit();
            }
          });
          composer.append(textarea);
          const composeFooter = makeElement("div", "gc-compose-footer");
          composeFooter.append(text("Enter to send · Shift+Enter for a new line", "gc-muted"));
          const send = button("Send message", "gc-send-button");
          send.disabled = !activeRoom;
          composeFooter.append(send);
          composer.append(composeFooter);
          conversation.append(composer);
          columns.append(conversation);

          const right = makeElement("aside", "gc-right-panel");
          const roster = makeElement("section", "gc-panel-card");
          const rosterHeader = makeElement("div", "gc-panel-title");
          rosterHeader.append(makeElement("h2", "", "Agents"), text(String(activeRoom?.agentIds.length ?? 0), "gc-count-badge"));
          roster.append(rosterHeader);
          if (!activeRoom?.agentIds.length) roster.append(makeElement("p", "gc-empty-hint", "Invite agents to start collaborating."));
          for (const agentId of activeRoom?.agentIds ?? []) {
            const agent = agentFor(agentId) ?? { id: agentId, name: agentId };
            const paused = current.paused || Boolean(current.settings.perAgentPaused[agentId]);
            const typing = current.queue.some((item) => item.agentId === agentId && item.roomId === activeRoom?.id);
            const agentRow = makeElement("div", "gc-agent-row");
            agentRow.append(avatar(agent, agent.name));
            const info = makeElement("div", "gc-agent-info");
            info.append(makeElement("strong", "", agent.name), makeElement("span", paused ? "gc-muted" : typing ? "gc-agent-typing" : "gc-muted", paused ? "Paused" : typing ? "Thinking…" : agent.status ?? "Ready"));
            agentRow.append(info);
            const togglePause = button(paused && !current.paused ? "Resume" : "Pause", "gc-mini-button");
            togglePause.disabled = current.paused;
            togglePause.title = current.paused ? "Resume the civilization first" : "Pause or resume this agent in Group";
            togglePause.addEventListener("click", async () => {
              const pausing = !current?.settings.perAgentPaused[agentId];
              const result = await runChange("pause_agent", { agentId, paused: pausing });
              if (!result || !pausing) return;
              try {
                await context.host.request("sessions.abort", {
                  key: `agent:${agentId}:main`,
                  clearQueued: true,
                });
                setNotice(`${agent.name} is paused and its active session was interrupted.`);
              } catch (cause) {
                setNotice(`${agent.name} is paused in Group, but Gateway session interruption was denied or failed: ${String(cause)}`);
              }
            });
            const interrupt = button("Stop", "gc-mini-button gc-stop-button");
            interrupt.title = "Interrupt the agent's active OpenClaw session";
            interrupt.addEventListener("click", () => void runInterrupt(agent));
            agentRow.append(togglePause, interrupt);
            const remove = button("×", "gc-remove-agent");
            remove.title = "Remove agent from this room";
            remove.addEventListener("click", () => void runChange("remove_agent", { roomId: activeRoom.id, agentId }));
            agentRow.append(remove);
            roster.append(agentRow);
          }
          right.append(roster);

          const tasks = makeElement("section", "gc-panel-card");
          const tasksHeader = makeElement("div", "gc-panel-title");
          tasksHeader.append(makeElement("h2", "", "Tasks"));
          const createTask = button("+", "gc-icon-button");
          createTask.title = "Create task";
          createTask.disabled = !activeRoom;
          createTask.addEventListener("click", async () => {
            if (!activeRoom) return;
            const title = window.prompt("Task title");
            if (!title?.trim()) return;
            const description = window.prompt("Task description", title.trim()) ?? title.trim();
            const choices = activeRoom.agentIds.map((id) => agentFor(id)).filter((item): item is Agent => Boolean(item));
            const assignee = choices.length
              ? window.prompt(`Assign to an agent ID, or leave blank:\n${choices.map((agent) => `${agent.id} — ${agent.name}`).join("\n")}`)
              : "";
            await runChange("create_task", {
              roomId: activeRoom.id,
              title: title.trim(),
              description,
              assigneeId: assignee?.trim() || undefined,
            });
          });
          tasksHeader.append(createTask);
          tasks.append(tasksHeader);
          const roomTasks = current.tasks.slice(-8).reverse();
          if (!roomTasks.length) tasks.append(makeElement("p", "gc-empty-hint", "No tasks yet."));
          for (const task of roomTasks) {
            const taskRow = makeElement("div", "gc-task-row");
            const status = makeElement("span", `gc-task-status status-${task.status}`, task.status);
            taskRow.append(status, makeElement("strong", "", task.title));
            if (task.assigneeId) taskRow.append(makeElement("small", "gc-muted", agentFor(task.assigneeId)?.name ?? task.assigneeId));
            if (task.needsHuman) taskRow.append(text("Needs you", "gc-human-badge"));
            const cycle = button(task.status === "completed" ? "Reopen" : "Complete", "gc-message-action");
            cycle.addEventListener("click", () => void runChange("update_task", {
              taskId: task.id,
              status: task.status === "completed" ? "open" : "completed",
            }));
            taskRow.append(cycle);
            tasks.append(taskRow);
          }
          right.append(tasks);

          const goals = makeElement("section", "gc-panel-card");
          const goalsHeader = makeElement("div", "gc-panel-title");
          goalsHeader.append(makeElement("h2", "", "Shared goals"));
          const addGoal = button("+", "gc-icon-button");
          addGoal.title = "Add goal";
          addGoal.addEventListener("click", async () => {
            const goal = window.prompt("Shared civilization goal");
            if (goal?.trim()) {
              await runChange("create_goal", { text: goal.trim(), roomId: activeRoom?.id });
            }
          });
          goalsHeader.append(addGoal);
          goals.append(goalsHeader);
          const activeGoals = current.goals.filter((goal) => goal.status !== "completed").slice(-5).reverse();
          if (!activeGoals.length) goals.append(makeElement("p", "gc-empty-hint", "No active goals."));
          for (const goal of activeGoals) {
            const goalRow = makeElement("div", "gc-goal-row");
            goalRow.append(makeElement("p", "", goal.text), makeElement("small", "gc-muted", `${goal.status} · ${goal.proposedBy}`));
            if (goal.status === "proposed") {
              const accept = button("Approve", "gc-message-action");
              accept.addEventListener("click", () => void runChange("update_goal", { goalId: goal.id, status: "active" }));
              goalRow.append(accept);
            }
            goals.append(goalRow);
          }
          right.append(goals);

          const activity = makeElement("section", "gc-panel-card");
          const activityHeader = makeElement("div", "gc-panel-title");
          activityHeader.append(makeElement("h2", "", "Recent activity"));
          activity.append(activityHeader);
          if (!current.activities.length) activity.append(makeElement("p", "gc-empty-hint", "No recent activity."));
          for (const entry of current.activities.slice(0, 8)) {
            const row = makeElement("div", `gc-activity-row priority-${entry.priority}`);
            row.append(makeElement("i", "gc-activity-dot"), makeElement("p", "", `${entry.actorName} ${entry.text}`));
            activity.append(row);
          }
          right.append(activity);

          const settings = makeElement("details", "gc-panel-card gc-settings");
          settings.append(makeElement("summary", "", "Autonomy & resource limits"));
          const form = makeElement("div", "gc-settings-grid");
          const addToggle = (label: string, checked: boolean, update: (checked: boolean) => void) => {
            const row = makeElement("label", "gc-setting-toggle");
            const input = makeElement("input");
            input.type = "checkbox";
            input.checked = checked;
            input.addEventListener("change", () => update(input.checked));
            row.append(input, text(label));
            form.append(row);
          };
          addToggle("Enable autonomous communication", current.settings.autonomous, (autonomous) =>
            void runChange("set_settings", { settings: { autonomous } }),
          );
          addToggle("Quiet hours", current.settings.quietHoursEnabled, (quietHoursEnabled) =>
            void runChange("set_settings", { settings: { quietHoursEnabled } }),
          );
          const mode = makeElement("select", "gc-setting-input");
          for (const option of ["automatic", "manual"] as const) {
            const item = makeElement("option", "", option);
            item.value = option;
            item.selected = current.settings.mode === option;
            mode.append(item);
          }
          mode.addEventListener("change", () => void runChange("set_settings", { settings: { mode: mode.value } }));
          form.append(makeElement("label", "gc-setting-row", "Operating mode"), mode);
          const quiet = makeElement("div", "gc-quiet-fields");
          for (const [label, key] of [["Quiet starts", "quietHoursStart"], ["Quiet ends", "quietHoursEnd"]] as const) {
            const input = makeElement("input", "gc-setting-input");
            input.type = "time";
            input.value = current.settings[key];
            input.addEventListener("change", () => void runChange("set_settings", { settings: { [key]: input.value } }));
            quiet.append(makeElement("label", "gc-setting-row", label), input);
          }
          form.append(quiet);
          const numberSettings = [
            ["Wake interval (minutes)", "wakeIntervalMinutes", current.settings.wakeIntervalMinutes],
            ["Maximum background tasks", "maxBackgroundTasks", current.settings.maxBackgroundTasks],
            ["Max concurrent executions", "maxConcurrentExecutions", current.settings.maxConcurrentExecutions],
            ["Max messages/hour", "maxMessagesPerHour", current.settings.maxMessagesPerHour],
            ["Max messages per agent/hour", "maxMessagesPerAgentPerHour", current.settings.maxMessagesPerAgentPerHour],
            ["Conversation turn limit", "maxConversationTurns", current.settings.maxConversationTurns],
            ["Cooldown (seconds)", "cooldownSeconds", current.settings.cooldownSeconds],
          ] as const;
          for (const [label, key, value] of numberSettings) {
            const input = makeElement("input", "gc-setting-input");
            input.type = "number";
            input.min = "0";
            input.value = String(value);
            input.addEventListener("change", () => void runChange("set_settings", { settings: { [key]: Number(input.value) } }));
            form.append(makeElement("label", "gc-setting-row", label), input);
          }
          settings.append(form);
          right.append(settings);
          columns.append(right);
          content.append(columns);
          wrapper.append(sidebar, content);
          shell.replaceChildren(wrapper);
        };

        void refresh();
        watch();
        void loadAgentDirectory();
        return {
          dispose() {
            disposer?.();
            if (debounce) clearTimeout(debounce);
            shell.remove();
          },
        };
      },
    });
  },
});
