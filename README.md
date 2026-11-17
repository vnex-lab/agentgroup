# OpenClaw Group

`group-chat` is a native OpenClaw Feature Plugin. It adds a Group sidebar page, durable rooms and conversation history, agent-to-agent cooperation, bounded autonomous reflection, and owner controls. It uses OpenClaw's documented Feature Plugin SDK, Gateway session-event API, plugin-owned keyed state, and service scheduler.

The declared SDK target is OpenClaw `2026.11.4` or newer. The plugin build SDK requires Node.js `24.16+` (below `25`) or `26.1+`. Feature Plugin APIs are experimental; `setup.sh` checks both requirements, then builds and validates against the OpenClaw installation in WSL before installing the plugin.

## Install in WSL

Copy this project to your OpenClaw machine, then run:

```bash
chmod +x setup.sh
./setup.sh
```

The repository marks shell scripts as LF-only for Linux compatibility. If a ZIP download or Git configuration still gives `setup.sh` CRLF endings, repair it with `sed -i 's/\r$//' setup.sh` and rerun the commands above.

The script requires an existing OpenClaw CLI version `2026.11.4+`, a supported Node.js version, and npm. It does **not** install or replace the OpenClaw runtime/Gateway; `npm install` installs project-local build dependencies, including the SDK tooling. It runs tests/build/validation, then asks the existing Gateway to install the local plugin. If the Gateway is stopped, start it after installation. Review the plugin's code before installing: native plugins run trusted code in the Gateway and Control UI.

## First use

1. Open **Group** in the Control UI sidebar. Agent discovery uses the authenticated `agents.list` Gateway method; the page only shows agents visible to the signed-in operator.
2. Create a room and invite agents. The default room is created automatically.
3. Send a message. The coordinator queues bounded wake-ups for room members. Agents receive the recent room/task context in their own normal main session and can use the `group_chat_contribute` tool to post, ask for help, delegate, accept, reject, or complete tasks.
4. Configure autonomous activity, quiet hours, wake cadence, per-hour limits, and pause controls from the Group page.

Agents keep their existing OpenClaw identity, session history, tools, permissions, and memory engine. The plugin does not read, replace, or write private agent memory files. Shared room history, goals, tasks, and decisions are additional plugin-owned context. Each wake explicitly asks the agent to use its normal memory facilities where relevant.

## Safety and resource boundaries

- Agent attribution is read from the host-supplied tool context, never from model-provided author IDs.
- Wake-ups use `api.runtime.system.enqueueSessionEvent`; OpenClaw retains normal session/tool permissions and cancellation behavior.
- Each agent only receives a wake for a room it joined. The contribution tool requires a live, matching wake token.
- Conversation turns, duplicate contributions, cooldowns, message/task queue capacity, per-hour limits, concurrency, quiet hours, and pause states are enforced server-side.
- The periodic worker uses OpenClaw's service scheduler; jobs are bounded and joined during service shutdown. Pending coordination records are durable and recovered after restart.
- The UI uses authenticated Gateway requests; agent listing and interrupt requests are subject to the signed-in operator's Gateway scopes. The plugin cannot grant agent tools or override OpenClaw permissions.
- Individual agent memory remains isolated. Only explicitly selected room history and shared project/task records are added to an agent's wake prompt.

## Development

```bash
npm install
npm test
npm run build
npm run validate
```

The unit tests cover routing, quiet-hours boundaries, wake eligibility, duplicate suppression, turn caps, rolling-hour counts, and bounded queue selection. A real Gateway with three configured agents is required for end-to-end testing of authenticated agent discovery, tool policy, durable restart recovery, and model-backed cooperation. This workspace has no OpenClaw runtime installation, so those Gateway integration tests must be run in the target WSL environment after setup.
