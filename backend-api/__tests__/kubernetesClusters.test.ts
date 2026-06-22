// @ts-nocheck
const mockDb = { query: jest.fn() };
const mockLoadKubeconfigFromFile = jest.fn();
const mockListNamespace = jest.fn();
const mockListNamespacedDaemonSet = jest.fn();
const mockCreateSelfSubjectAccessReview = jest.fn();

jest.mock("../db", () => mockDb);
jest.mock("@kubernetes/client-node", () => {
  class KubeConfig {
    loadFromFile(path) {
      return mockLoadKubeconfigFromFile(path);
    }
    loadFromString() {}
    loadFromCluster() {}
    makeApiClient(api) {
      if (api === CoreV1Api) return { listNamespace: mockListNamespace };
      if (api === AppsV1Api) return { listNamespacedDaemonSet: mockListNamespacedDaemonSet };
      if (api === AuthorizationV1Api) {
        return { createSelfSubjectAccessReview: mockCreateSelfSubjectAccessReview };
      }
      return { listNamespace: mockListNamespace };
    }
  }

  class CoreV1Api {}
  class AppsV1Api {}
  class AuthorizationV1Api {}

  return { KubeConfig, CoreV1Api, AppsV1Api, AuthorizationV1Api, NetworkingV1Api: class {} };
});

const { rowToProfile, testKubernetesCluster } = require("../kubernetesClusters");

function kubernetesClusterRow(overrides = {}) {
  return {
    id: "aks-eastus2",
    label: "AKS East US 2",
    provider: "aks",
    cluster_name: "nora-dns-vjb9kjjz",
    enabled: true,
    is_default: true,
    credential_mode: "mounted_path",
    kubeconfig_path: "/kubeconfigs/aks-kubeconfig",
    kubeconfig_encrypted: null,
    kube_context: "",
    namespace: "nora-openclaw-agents",
    openclaw_namespace: "nora-openclaw-agents",
    hermes_namespace: "nora-hermes-agents",
    exposure_mode: "load-balancer",
    runtime_host: "",
    service_annotations: {},
    load_balancer_source_ranges: [],
    load_balancer_class: "",
    load_balancer_ready_timeout_ms: 1200000,
    load_balancer_ready_interval_ms: 5000,
    last_test_status: null,
    last_test_message: null,
    ...overrides,
  };
}

describe("kubernetes cluster registry", () => {
  beforeEach(() => {
    mockDb.query.mockReset();
    mockLoadKubeconfigFromFile.mockReset().mockReturnValue(undefined);
    mockListNamespace.mockReset().mockResolvedValue({});
    mockListNamespacedDaemonSet.mockReset().mockResolvedValue({
      items: [{ metadata: { name: "cilium" } }],
    });
    mockCreateSelfSubjectAccessReview.mockReset().mockResolvedValue({
      status: { allowed: true },
    });
  });

  it("exposes NetworkPolicy capability metadata on cluster profiles", () => {
    const profile = rowToProfile(
      kubernetesClusterRow({
        supports_network_policy: true,
        policy_engine: "cilium",
      }),
    );

    expect(profile.supportsNetworkPolicy).toBe(true);
    expect(profile.policyEngine).toBe("cilium");
    expect(profile.policySupportStatus).toBe("supported");
    expect(profile.policyIssue).toBeNull();
  });

  it("stores actionable connection-test failures for missing mounted kubeconfigs", async () => {
    const missing = new Error(
      "ENOENT: no such file or directory, open '/kubeconfigs/aks-kubeconfig'",
    );
    missing.code = "ENOENT";
    mockLoadKubeconfigFromFile.mockImplementationOnce(() => {
      throw missing;
    });
    const updated = kubernetesClusterRow({
      last_test_status: "failed",
      last_test_message:
        "AKS East US 2 mounted kubeconfig file was not found at /kubeconfigs/aks-kubeconfig. Make sure NORA_KUBECONFIGS_DIR is mounted with docker-compose.kubernetes.yml and contains this file, or update the Admin Kubeconfig path to the file visible inside the Nora containers.",
    });
    mockDb.query
      .mockResolvedValueOnce({ rows: [kubernetesClusterRow()] })
      .mockResolvedValueOnce({ rows: [updated] });

    const cluster = await testKubernetesCluster("aks-eastus2");

    expect(cluster.lastTestStatus).toBe("failed");
    expect(cluster.lastTestMessage).toMatch(/mounted kubeconfig file was not found/);
    expect(cluster.lastTestMessage).toMatch(/NORA_KUBECONFIGS_DIR/);
    expect(mockDb.query.mock.calls[1][1][2]).toBe(updated.last_test_message);
  });

  it("stores probed NetworkPolicy capability details during cluster tests", async () => {
    const updated = kubernetesClusterRow({
      last_test_status: "ok",
      last_test_message:
        "Kubernetes API is reachable and NetworkPolicy support was detected (cilium).",
      supports_network_policy: true,
      policy_engine: "cilium",
    });
    mockDb.query
      .mockResolvedValueOnce({ rows: [kubernetesClusterRow()] })
      .mockResolvedValueOnce({ rows: [updated] });

    const cluster = await testKubernetesCluster("aks-eastus2");

    expect(cluster.supportsNetworkPolicy).toBe(true);
    expect(cluster.policyEngine).toBe("cilium");
    expect(mockListNamespacedDaemonSet).toHaveBeenCalledWith({
      namespace: "kube-system",
      limit: 100,
    });
    expect(mockCreateSelfSubjectAccessReview).toHaveBeenCalled();
  });

  it("accepts wrapped Kubernetes client responses when probing policy support", async () => {
    mockListNamespacedDaemonSet.mockResolvedValueOnce({
      body: { items: [{ metadata: { name: "cilium" } }] },
    });
    mockCreateSelfSubjectAccessReview.mockResolvedValue({
      body: { status: { allowed: true } },
    });
    const updated = kubernetesClusterRow({
      last_test_status: "ok",
      last_test_message:
        "Kubernetes API is reachable and NetworkPolicy support was detected (cilium).",
      supports_network_policy: true,
      policy_engine: "cilium",
    });
    mockDb.query
      .mockResolvedValueOnce({ rows: [kubernetesClusterRow()] })
      .mockResolvedValueOnce({ rows: [updated] });

    const cluster = await testKubernetesCluster("aks-eastus2");

    expect(cluster.supportsNetworkPolicy).toBe(true);
    expect(cluster.policyEngine).toBe("cilium");
  });
});
