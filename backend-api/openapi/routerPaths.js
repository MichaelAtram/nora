// @ts-nocheck
// Express router introspection for the OpenAPI drift test: extracts every
// (method, path) a router serves so the spec can be checked against reality.
// Express 4 keeps routes on router.stack as layers with a `route` property.

// Convert an Express path (/agents/:id/budget/:budgetId) to the OpenAPI
// template form (/agents/{id}/budget/{budgetId}).
function toOpenApiPath(expressPath) {
  return String(expressPath).replace(/:([A-Za-z0-9_]+)/g, "{$1}");
}

// List "<METHOD> <openapi path>" strings for a router, with an optional mount
// prefix (e.g. "/agents"). Skips middleware layers; `_all` is Express
// bookkeeping, not a method.
function listRouterPaths(router, mountPrefix = "") {
  const out = [];
  for (const layer of router.stack || []) {
    if (!layer.route) continue;
    const methods = Object.keys(layer.route.methods || {}).filter((m) => m !== "_all");
    const routePath = layer.route.path === "/" ? "" : layer.route.path;
    const fullPath = toOpenApiPath(`${mountPrefix}${routePath}`) || "/";
    for (const method of methods) {
      out.push(`${method.toUpperCase()} ${fullPath}`);
    }
  }
  return out;
}

module.exports = { toOpenApiPath, listRouterPaths };
