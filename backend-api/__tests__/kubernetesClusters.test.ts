// @ts-nocheck
const mockDb = { query: jest.fn() };
const mockLoadKubeconfigFromFile = jest.fn();
const mockListNamespace = jest.fn();

jest.mock("../db", () => mockDb);
jest.mock("@kubernetes/client-node", () => {
  class KubeConfig {
    loadFromFile(path) {
      return mockLoadKubeconfigFromFile(path);
    }
    loadFromString() {}
    loadFromCluster() {}
    makeApiClient() {
      return { listNamespace: mockListNamespace };
    }
  }

  class CoreV1Api {}

  return { KubeConfig, CoreV1Api };
});

const { testKubernetesCluster } = require("../kubernetesClusters");

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
});
