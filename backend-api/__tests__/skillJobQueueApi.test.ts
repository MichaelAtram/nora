// @ts-nocheck
// Unit-tests the shared skill-job queue API against stub queues, covering the
// ClawHub (slug-keyed) and Hermes (name-keyed) instantiations without Redis.

jest.mock("bullmq", () => ({
  Queue: jest.fn().mockImplementation((name) => ({ name })),
}));
jest.mock("ioredis", () => jest.fn());
jest.mock("../lib/connectionConfig", () => ({
  createRedisClient: jest.fn(() => ({})),
  buildPostgresConfig: jest.fn(() => ({})),
}));

const { createSkillJobQueueApi } = require("../redisQueue");

function buildStubQueue() {
  return {
    add: jest.fn(async (jobName, data, opts) => ({ id: opts.jobId, name: jobName, data })),
    getJobs: jest.fn(async () => []),
    getJob: jest.fn(async () => null),
  };
}

describe("createSkillJobQueueApi", () => {
  it("addJob defaults the operation, stamps a jobId, and names the job", async () => {
    const queue = buildStubQueue();
    const api = createSkillJobQueueApi(queue, { identityField: "name" });

    const job = await api.addJob({ agentId: "a1", name: "github" });

    expect(queue.add).toHaveBeenCalledTimes(1);
    const [jobName, data, opts] = queue.add.mock.calls[0];
    expect(jobName).toBe("install-skill");
    expect(data).toEqual(
      expect.objectContaining({ agentId: "a1", name: "github", operation: "install" }),
    );
    expect(data.jobId).toBe(opts.jobId);
    expect(job.id).toBe(opts.jobId);
  });

  it("findInFlightJob matches on the configured identity field", async () => {
    const jobs = [
      { data: { agentId: "a1", slug: "github", operation: "install" } },
      { data: { agentId: "a1", name: "github", operation: "install" } },
    ];
    const slugQueue = { ...buildStubQueue(), getJobs: jest.fn(async () => jobs) };
    const nameQueue = { ...buildStubQueue(), getJobs: jest.fn(async () => jobs) };

    const slugApi = createSkillJobQueueApi(slugQueue, { identityField: "slug" });
    const nameApi = createSkillJobQueueApi(nameQueue, { identityField: "name" });

    expect(await slugApi.findInFlightJob("a1", "github", "install")).toBe(jobs[0]);
    expect(await nameApi.findInFlightJob("a1", "github", "install")).toBe(jobs[1]);
    expect(await nameApi.findInFlightJob("a1", "github", "delete")).toBeNull();
    expect(await nameApi.findInFlightJob("a2", "github")).toBeNull();
    expect(await nameApi.findInFlightJob("", "github")).toBeNull();
  });

  it("getJobStatus shapes the identity field and maps BullMQ states", async () => {
    const job = {
      id: "j1",
      data: { agentId: "a1", name: "notion", operation: "delete" },
      failedReason: "  boom  ",
      finishedOn: Date.parse("2026-04-12T12:00:00.000Z"),
      getState: jest.fn(async () => "failed"),
    };
    const queue = { ...buildStubQueue(), getJob: jest.fn(async () => job) };
    const api = createSkillJobQueueApi(queue, { identityField: "name" });

    expect(await api.getJobStatus("j1")).toEqual({
      jobId: "j1",
      agentId: "a1",
      name: "notion",
      operation: "delete",
      status: "failed",
      error: "boom",
      completedAt: "2026-04-12T12:00:00.000Z",
    });
    expect(await api.getJobStatus("")).toBeNull();

    job.getState = jest.fn(async () => "waiting");
    job.failedReason = null;
    const pending = await api.getJobStatus("j1");
    expect(pending.status).toBe("pending");
    expect(pending.error).toBeNull();
  });
});
