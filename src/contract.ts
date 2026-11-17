import { Type } from "typebox";
import { defineFeatureContract } from "openclaw/plugin-sdk/feature-contract";

const JsonText = Type.String({ maxLength: 900_000 });

export const contract = defineFeatureContract({
  pluginId: "group-chat",
  operations: {
    snapshot: {
      kind: "query",
      description: "Read Group rooms, selected room history, goals, tasks, activity, and coordination settings.",
      input: Type.Object(
        {
          roomId: Type.Optional(Type.String({ maxLength: 128 })),
          search: Type.Optional(Type.String({ maxLength: 200 })),
        },
        { additionalProperties: false },
      ),
      output: Type.Object({ json: JsonText }, { additionalProperties: false }),
    },
    change: {
      kind: "action",
      description: "Manage Group rooms, agents, messages, tasks, goals, reactions, and autonomous activity.",
      input: Type.Object(
        {
          action: Type.Union([
            Type.Literal("create_room"),
            Type.Literal("rename_room"),
            Type.Literal("delete_room"),
            Type.Literal("invite_agent"),
            Type.Literal("remove_agent"),
            Type.Literal("send_message"),
            Type.Literal("react"),
            Type.Literal("pause_all"),
            Type.Literal("set_settings"),
            Type.Literal("pause_agent"),
            Type.Literal("interrupt_agent"),
            Type.Literal("create_task"),
            Type.Literal("update_task"),
            Type.Literal("create_goal"),
            Type.Literal("update_goal"),
          ]),
          json: Type.String({ maxLength: 16_000 }),
        },
        { additionalProperties: false },
      ),
      output: Type.Object({ json: Type.String({ maxLength: 32_000 }) }, { additionalProperties: false }),
    },
    contribute: {
      kind: "action",
      description: "Post a useful Group contribution, request/offer help, delegate work, update a task, or propose a shared goal. Only available to the invoking agent with a live Group wake token.",
      input: Type.Object(
        {
          wakeId: Type.String({ minLength: 8, maxLength: 128 }),
          roomId: Type.String({ minLength: 1, maxLength: 128 }),
          kind: Type.Union([
            Type.Literal("message"),
            Type.Literal("no_contribution"),
            Type.Literal("help"),
            Type.Literal("offer"),
            Type.Literal("task"),
            Type.Literal("decision"),
            Type.Literal("goal"),
            Type.Literal("task_accept"),
            Type.Literal("task_reject"),
            Type.Literal("task_complete"),
          ]),
          text: Type.String({ minLength: 1, maxLength: 8_000 }),
          mentions: Type.Optional(Type.Array(Type.String({ maxLength: 128 }), { maxItems: 8 })),
          replyToId: Type.Optional(Type.String({ maxLength: 128 })),
          taskId: Type.Optional(Type.String({ maxLength: 128 })),
          taskTitle: Type.Optional(Type.String({ maxLength: 240 })),
        },
        { additionalProperties: false },
      ),
      output: Type.Object({ messageId: Type.String({ maxLength: 128 }) }, { additionalProperties: false }),
      tool: { name: "group_chat_contribute", label: "Contribute to Group" },
    },
  },
  events: {
    changed: Type.Object({ revision: Type.Integer() }, { additionalProperties: false }),
  },
});
