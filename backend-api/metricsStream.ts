// @ts-nocheck
const { WebSocketServer } = require("ws");
const jwt = require("jsonwebtoken");
const { buildAgentStatsResponse } = require("./agentTelemetry");
const { extractSessionTokenFromUpgrade } = require("./authCookie");
const { findAccessibleAgentForActor } = require("./middleware/ownership");

const STREAM_INTERVAL_MS = 5000;

/**
 * Attach a viewer-authorized metrics WebSocket endpoint that rechecks access
 * and publishes a current agent snapshot every five seconds.
 *
 * @param {Object} server - HTTP server receiving the upgrade handler.
 * @returns {Object} Attached WebSocket server.
 */
function attachMetricsStream(server) {
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url, `http://${request.headers.host}`);
    const match = url.pathname.match(/^\/ws\/metrics\/(.+)$/);
    if (!match) {
      return;
    }

    const token = extractSessionTokenFromUpgrade(request, url.searchParams);
    let payload;

    try {
      payload = jwt.verify(token, process.env.JWT_SECRET, {
        algorithms: ["HS256"],
      });
    } catch {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }

    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit("connection", ws, {
        agentId: match[1],
        user: { id: payload.id, role: payload.role },
      });
    });
  });

  wss.on("connection", async (ws, { agentId, user }) => {
    let closed = false;

    const sendSnapshot = async () => {
      const agent = await findAccessibleAgentForActor(agentId, user, "viewer");

      if (!agent) {
        if (ws.readyState === 1) {
          ws.send(JSON.stringify({ type: "error", message: "Agent not found" }));
        }
        ws.close();
        return;
      }

      const payload = await buildAgentStatsResponse(agent);
      if (ws.readyState === 1) {
        ws.send(JSON.stringify({ type: "snapshot", payload }));
      }
    };

    try {
      await sendSnapshot();
    } catch (error) {
      if (ws.readyState === 1) {
        ws.send(JSON.stringify({ type: "error", message: error.message }));
      }
    }

    const interval = setInterval(() => {
      sendSnapshot().catch((error) => {
        if (ws.readyState === 1) {
          ws.send(JSON.stringify({ type: "error", message: error.message }));
        }
      });
    }, STREAM_INTERVAL_MS);

    const teardown = () => {
      if (closed) return;
      closed = true;
      clearInterval(interval);
    };

    ws.on("close", teardown);
    ws.on("error", teardown);
  });

  return wss;
}

module.exports = { attachMetricsStream };
