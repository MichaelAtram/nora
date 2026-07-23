// @ts-nocheck
process.env.NODE_ENV = "test";
const HermesBackend = require("../hermes");

// buildHermesStartCommand is module-internal; assert via a tiny re-export.
const { __buildHermesStartCommandForTest } = require("../hermes");

describe("hermes start command", () => {
  it("launches named-profile gateways before exec-ing the default gateway", () => {
    const cmd = __buildHermesStartCommandForTest();
    expect(cmd).toContain("/opt/data/profiles/");
    expect(cmd).toContain("gateway run");
    // default gateway is still the exec'd primary
    expect(cmd).toContain('exec "$HERMES_BIN" gateway run');
    // profile loop precedes the exec of the primary gateway
    expect(cmd.indexOf("/opt/data/profiles/")).toBeLessThan(cmd.lastIndexOf('exec "$HERMES_BIN" gateway run'));
  });
});
