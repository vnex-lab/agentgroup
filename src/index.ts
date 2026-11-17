import { defineFeaturePlugin } from "openclaw/plugin-sdk/feature-plugin";
import { contract } from "./contract.js";
import { createGroupService } from "./service.js";

export default defineFeaturePlugin({
  contract,
  name: "Group",
  description: "A persistent, permission-aware multi-agent community with bounded autonomous coordination.",
  setup(api, events) {
    const service = createGroupService(api, events);
    api.registerService(service.backgroundService);
    return {
      snapshot: ({ roomId, search }) => service.snapshot(roomId, search),
      change: ({ action, json }) => service.applyChange(action, json),
      contribute: (input, context) =>
        service.addAgentContribution(
          input,
          context.source === "tool" ? context.tool.agentId : undefined,
        ),
    };
  },
});
