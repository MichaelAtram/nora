// @ts-nocheck
const {
  buildKubernetesClusterExecutionTargetEntry,
} = require("../../agent-runtime/lib/backendCatalog");

describe("backend catalog kubernetes policy capability metadata", () => {
  it("surfaces supported NetworkPolicy metadata on Kubernetes execution targets", () => {
    const entry = buildKubernetesClusterExecutionTargetEntry("openclaw", {
      id: "test-cluster",
      executionTargetId: "k8s:test-cluster",
      label: "Test Cluster",
      enabled: true,
      configured: true,
      available: true,
      supportsNetworkPolicy: true,
      policyEngine: "cilium",
      policySupportStatus: "supported",
      policyIssue: null,
    });

    expect(entry.supportsNetworkPolicy).toBe(true);
    expect(entry.policyEngine).toBe("cilium");
    expect(entry.policySupportStatus).toBe("supported");
    expect(entry.policyIssue).toBeNull();
    expect(entry.sandboxProfiles.every((option) => option.supportsNetworkPolicy === true)).toBe(
      true,
    );
  });

  it("surfaces degraded NetworkPolicy metadata on Kubernetes execution targets", () => {
    const entry = buildKubernetesClusterExecutionTargetEntry("openclaw", {
      id: "test-cluster",
      executionTargetId: "k8s:test-cluster",
      label: "Test Cluster",
      enabled: true,
      configured: true,
      available: true,
      supportsNetworkPolicy: false,
      policyEngine: null,
    });

    expect(entry.supportsNetworkPolicy).toBe(false);
    expect(entry.policyEngine).toBeNull();
    expect(entry.policySupportStatus).toBe("degraded");
    expect(entry.policyIssue).toMatch(/degraded mode/i);
    expect(entry.sandboxProfiles.every((option) => option.policySupportStatus === "degraded")).toBe(
      true,
    );
  });
});
