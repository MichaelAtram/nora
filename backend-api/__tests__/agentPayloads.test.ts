// @ts-nocheck
const { serializeAgent } = require("../agentPayloads");

describe("serializeAgent", () => {
  it("maps network_policy_status to networkPolicyStatus", () => {
    const serialized = serializeAgent({
      id: "agent-1",
      runtime_family: "openclaw",
      deploy_target: "k8s",
      execution_target_id: "k8s:test-cluster",
      sandbox_profile: "standard",
      network_policy_status: {
        policyStatus: "supported",
        policyBundleAttempted: true,
        policyBundleApplied: true,
        policyIssue: null,
      },
    });

    expect(serialized.networkPolicyStatus).toEqual({
      policyStatus: "supported",
      policyBundleAttempted: true,
      policyBundleApplied: true,
      policyIssue: null,
    });
    expect(serialized).not.toHaveProperty("network_policy_status");
  });

  it("keeps networkPolicyStatus null when no policy state was persisted", () => {
    const serialized = serializeAgent({
      id: "agent-2",
      runtime_family: "openclaw",
      deploy_target: "docker",
      execution_target_id: "docker",
      sandbox_profile: "standard",
      network_policy_status: null,
    });

    expect(serialized.networkPolicyStatus).toBeNull();
  });
});
