import http from "http";
import fs from "fs";

export const START_DELEGATION_TOOLS = [
  {
    name: "StartDelegation",
    description: "Start a Terminal 64 delegation group by providing shared context and a list of independent agent tasks. Use this instead of writing a delegation block.",
    annotations: {
      readOnlyHint: true,
    },
    inputSchema: {
      type: "object",
      properties: {
        context: {
          type: "string",
          description: "Shared context every delegated agent needs, including project constraints and the overall goal.",
        },
        tasks: {
          type: "array",
          description: "Independent tasks for parallel agents.",
          items: {
            type: "object",
            properties: {
              description: {
                type: "string",
                description: "Specific, independently completable task for one agent.",
              },
            },
            required: ["description"],
          },
          minItems: 2,
          maxItems: 8,
        },
      },
      required: ["context", "tasks"],
    },
  },
];

export const DELEGATION_TOOLS = [
  {
    name: "send_to_team",
    description: "Send a message to the delegation team chat. Use this to share progress updates, findings, or coordinate with other agents.",
    inputSchema: {
      type: "object",
      properties: {
        message: { type: "string", description: "The message to send to the team" },
      },
      required: ["message"],
    },
  },
  {
    name: "read_team",
    description: "Read recent messages from the delegation team chat to see what other agents have posted.",
    annotations: {
      readOnlyHint: true,
    },
    inputSchema: {
      type: "object",
      properties: {
        last: { type: "number", description: "Number of recent messages to retrieve (default: 20)" },
      },
    },
  },
  {
    name: "report_done",
    description: "Signal that your task is complete. Include a summary of what you accomplished.",
    inputSchema: {
      type: "object",
      properties: {
        summary: { type: "string", description: "Summary of what was accomplished" },
      },
      required: ["summary"],
    },
  },
];

function readDelegationContext(env) {
  const port = parseInt(env.T64_DELEGATION_PORT || "0", 10);
  const secret = env.T64_DELEGATION_SECRET || "";
  const groupId = env.T64_GROUP_ID || "";
  const agentLabel = env.T64_AGENT_LABEL || "Agent";

  return {
    port,
    secret,
    groupId,
    agentLabel,
    active: port > 0 && groupId.length > 0 && secret.length > 0,
  };
}

function writeStderr(prefix, message) {
  process.stderr.write(`[${prefix}] ${message}\n`);
}

function writeDebug(message) {
  const path = process.env.T64_MCP_DEBUG_FILE;
  if (!path) return;
  fs.appendFile(path, `${new Date().toISOString()} ${message}\n`, () => {});
}

function createHttpRequest(context) {
  return function httpRequest(method, path, body) {
    return new Promise((resolve, reject) => {
      const encoded = body ? JSON.stringify(body) : null;
      const headers = {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${context.secret}`,
      };
      if (encoded) headers["Content-Length"] = Buffer.byteLength(encoded);

      const req = http.request(
        {
          hostname: "127.0.0.1",
          port: context.port,
          path,
          method,
          headers,
        },
        (res) => {
          let data = "";
          res.on("data", (chunk) => (data += chunk));
          res.on("end", () => {
            if (res.statusCode >= 400) {
              reject(new Error(`HTTP ${res.statusCode}: ${data}`));
              return;
            }
            try {
              resolve(JSON.parse(data));
            } catch {
              resolve(data);
            }
          });
        },
      );

      req.on("error", reject);
      req.setTimeout(10000, () => {
        req.destroy(new Error("Request timeout"));
      });
      if (encoded) req.write(encoded);
      req.end();
    });
  };
}

function formatTeamMessages(messages) {
  return messages
    .map((message) => {
      const time = new Date(message.timestamp).toLocaleTimeString();
      const prefix = message.msg_type === "complete" ? "[DONE]" : "";
      return `[${time}] ${message.agent}: ${prefix}${message.message}`;
    })
    .join("\n");
}

function createDelegationToolHandler(context) {
  const httpRequest = createHttpRequest(context);

  return async function handleToolCall(name, args) {
    if (name === "StartDelegation") {
      const tasks = Array.isArray(args.tasks) ? args.tasks : [];
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            status: "received",
            context: args.context || "",
            taskCount: tasks.length,
          }),
        }],
      };
    }

    if (!context.active) {
      return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
    }

    switch (name) {
      case "send_to_team": {
        await httpRequest("POST", "/delegation/message", {
          group_id: context.groupId,
          agent: context.agentLabel,
          message: args.message || "",
        });
        return { content: [{ type: "text", text: "Message sent to team chat." }] };
      }
      case "read_team": {
        const last = Math.min(Math.max(Number.parseInt(String(args.last ?? 20), 10) || 20, 1), 100);
        const messages = await httpRequest(
          "GET",
          `/delegation/messages?group=${encodeURIComponent(context.groupId)}&last=${last}`,
        );
        if (!Array.isArray(messages) || messages.length === 0) {
          return { content: [{ type: "text", text: "No team messages yet." }] };
        }
        return { content: [{ type: "text", text: formatTeamMessages(messages) }] };
      }
      case "report_done": {
        await httpRequest("POST", "/delegation/complete", {
          group_id: context.groupId,
          agent: context.agentLabel,
          summary: args.summary || "",
        });
        return { content: [{ type: "text", text: "Task completion reported." }] };
      }
      default:
        return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
    }
  };
}

function createSender(outputFraming) {
  return function send(message) {
    const json = JSON.stringify(message);
    if (outputFraming === "content-length") {
      process.stdout.write(`Content-Length: ${Buffer.byteLength(json)}\r\n\r\n${json}`);
      return;
    }
    process.stdout.write(json + "\n");
  };
}

function startJsonRpcServer({ serverName, stderrPrefix, getTools, handleToolCall, outputFraming }) {
  const send = createSender(outputFraming);

  function handleMessage(message) {
    const { id, method, params } = message;
    writeDebug(`method=${method || ""} id=${id ?? ""}`);

    switch (method) {
      case "initialize":
        send({
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: "2024-11-05",
            capabilities: { tools: {} },
            serverInfo: { name: serverName, version: "1.0.0" },
          },
        });
        break;

      case "notifications/initialized":
        break;

      case "tools/list":
        send({ jsonrpc: "2.0", id, result: { tools: getTools() } });
        break;

      case "tools/call":
        handleToolCall(params?.name, params?.arguments || {})
          .then((result) => send({ jsonrpc: "2.0", id, result }))
          .catch((err) => {
            send({
              jsonrpc: "2.0",
              id,
              result: { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true },
            });
          });
        break;

      default:
        if (id !== undefined) {
          send({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } });
        }
    }
  }

  let buffer = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    buffer += chunk;

    while (buffer.length > 0) {
      if (/^\s*Content-Length:/i.test(buffer)) {
        const headerStart = buffer.search(/\S/);
        if (headerStart > 0) buffer = buffer.slice(headerStart);

        const headerEnd = buffer.indexOf("\r\n\r\n");
        if (headerEnd === -1) break;

        const header = buffer.slice(0, headerEnd);
        const match = header.match(/Content-Length:\s*(\d+)/i);
        if (!match) {
          buffer = buffer.slice(headerEnd + 4);
          continue;
        }

        const length = parseInt(match[1], 10);
        const bodyStart = headerEnd + 4;
        if (buffer.length < bodyStart + length) break;

        const body = buffer.slice(bodyStart, bodyStart + length);
        buffer = buffer.slice(bodyStart + length);
        try {
          handleMessage(JSON.parse(body));
        } catch (err) {
          writeStderr(stderrPrefix, `Parse error: ${err.message}`);
        }
        continue;
      }

      const newline = buffer.indexOf("\n");
      if (newline === -1) break;

      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;

      try {
        handleMessage(JSON.parse(line));
      } catch (err) {
        writeStderr(stderrPrefix, `Parse error: ${err.message}`);
      }
    }
  });
}

export function startDelegationMcpServer({
  serverName,
  stderrPrefix,
  requireDelegation = false,
  selfTest = false,
  outputFraming = process.env.T64_MCP_OUTPUT_FRAMING === "content-length" ? "content-length" : "newline",
  startupMessage,
}) {
  const context = readDelegationContext(process.env);
  if (requireDelegation && !context.active) {
    writeStderr(stderrPrefix, "Missing T64_DELEGATION_PORT, T64_DELEGATION_SECRET, or T64_GROUP_ID");
    process.exit(1);
  }

  const httpRequest = createHttpRequest(context);
  startJsonRpcServer({
    serverName,
    stderrPrefix,
    getTools: () => (context.active ? DELEGATION_TOOLS : START_DELEGATION_TOOLS),
    handleToolCall: createDelegationToolHandler(context),
    outputFraming,
  });

  if (selfTest && context.active) {
    httpRequest("GET", `/delegation/messages?group=${encodeURIComponent(context.groupId)}&last=1`)
      .then(() => writeStderr(stderrPrefix, "Delegation server reachable"))
      .catch((err) => writeStderr(stderrPrefix, `Delegation server UNREACHABLE: ${err.message}`));
  }

  const mode = context.active
    ? `delegation (group ${context.groupId.slice(0, 8)}, port ${context.port})`
    : "standalone";
  writeStderr(stderrPrefix, startupMessage ? startupMessage(context) : `MCP server started — ${mode}`);
}
