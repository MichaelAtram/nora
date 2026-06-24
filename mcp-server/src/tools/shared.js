// Result helpers shared by all Nora MCP tools. Tool output is the raw REST
// JSON, pretty-printed — the API's serializers are the contract, so the tools
// never reshape fields.

import { ApiError } from "../client.js";

export function jsonResult(data) {
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
  };
}

export function errorResult(error) {
  const message =
    error instanceof ApiError
      ? `Nora API error ${error.status}: ${error.message}${error.code ? ` (${error.code})` : ""}`
      : `Error: ${error?.message || String(error)}`;
  return {
    isError: true,
    content: [{ type: "text", text: message }],
  };
}

export function withApi(handler) {
  return async (args, extra) => {
    try {
      return await handler(args, extra);
    } catch (error) {
      return errorResult(error);
    }
  };
}
