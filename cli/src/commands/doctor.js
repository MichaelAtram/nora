const api = require("../client");

const SYMBOL = { ok: "✔", warn: "!", fail: "✖" };

async function run(args, flags) {
  let report;
  try {
    report = await api.get("/api/admin/doctor", {
      query: flags.fresh ? { fresh: "1" } : undefined,
    });
  } catch (err) {
    if (err.status === 403) {
      console.error(
        "nora doctor requires an admin API key (the issuing user must be a platform admin).",
      );
      return 1;
    }
    throw err;
  }

  if (flags.json) {
    console.log(JSON.stringify(report, null, 2));
    return report.overall === "fail" ? 2 : 0;
  }

  console.log(`Nora doctor — overall: ${SYMBOL[report.overall] || "?"} ${report.overall}`);
  console.log(`(${report.generatedAt})\n`);
  for (const check of report.checks) {
    const symbol = SYMBOL[check.status] || "?";
    console.log(`  ${symbol} ${check.label.padEnd(20)} ${check.detail || ""}`);
  }

  // Non-zero exit on failure so the command is usable in scripts / CI.
  return report.overall === "fail" ? 2 : 0;
}

module.exports = {
  describe: "Run a control-plane health check (admin)",
  run,
};
