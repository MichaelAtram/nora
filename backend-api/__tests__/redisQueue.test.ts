// @ts-nocheck
const queueInstances = new Map();

jest.mock("ioredis", () => {
  return jest.fn().mockImplementation(() => ({}));
});

jest.mock("bullmq", () => {
  class MockQueue {
    constructor(name) {
      this.name = name;
      this.add = jest.fn();
      this.getJob = jest.fn();
      queueInstances.set(name, this);
    }
  }

  return { Queue: MockQueue };
});

describe("addKubernetesPolicyReconcileJob", () => {
  let addKubernetesPolicyReconcileJob;
  let policySettingsQueue;

  beforeEach(() => {
    jest.resetModules();
    queueInstances.clear();
    ({ addKubernetesPolicyReconcileJob, policySettingsQueue } = require("../redisQueue"));
    policySettingsQueue.add.mockReset();
    policySettingsQueue.getJob.mockReset();
  });

  it("updates an in-flight job instead of re-enqueueing", async () => {
    const existingJob = {
      getState: jest.fn().mockResolvedValue("waiting"),
      updateData: jest.fn().mockResolvedValue(undefined),
      remove: jest.fn(),
    };
    policySettingsQueue.getJob.mockResolvedValue(existingJob);

    const result = await addKubernetesPolicyReconcileJob({
      clusterId: "aks-eastus2",
      desiredHash: "hash-1",
    });

    expect(existingJob.updateData).toHaveBeenCalledWith({
      clusterId: "aks-eastus2",
      desiredHash: "hash-1",
    });
    expect(existingJob.remove).not.toHaveBeenCalled();
    expect(policySettingsQueue.add).not.toHaveBeenCalled();
    expect(result).toBe(existingJob);
  });

  it("re-enqueues a fresh job when the previous job already completed", async () => {
    const existingJob = {
      getState: jest.fn().mockResolvedValue("completed"),
      updateData: jest.fn(),
      remove: jest.fn().mockResolvedValue(undefined),
    };
    const queuedJob = { id: "k8s-policy-aks-eastus2" };
    policySettingsQueue.getJob.mockResolvedValue(existingJob);
    policySettingsQueue.add.mockResolvedValue(queuedJob);

    const result = await addKubernetesPolicyReconcileJob({
      clusterId: "aks-eastus2",
      desiredHash: "hash-2",
    });

    expect(existingJob.remove).toHaveBeenCalled();
    expect(existingJob.updateData).not.toHaveBeenCalled();
    expect(policySettingsQueue.add).toHaveBeenCalledWith(
      "reconcile-kubernetes-policy-settings",
      { clusterId: "aks-eastus2", desiredHash: "hash-2" },
      { jobId: "k8s-policy-aks-eastus2" },
    );
    expect(result).toBe(queuedJob);
  });
});
