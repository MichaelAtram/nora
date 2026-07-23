// @ts-nocheck
const fs = require("fs");
const path = require("path");

const serverSrc = fs.readFileSync(path.join(__dirname, "..", "server.ts"), "utf8");
const schemaSrc = fs.readFileSync(path.join(__dirname, "..", "db_schema.sql"), "utf8");

describe("hermes profiles migration", () => {
  it("adds profile_name to hermes_runtime_state", () => {
    expect(serverSrc).toContain("ALTER TABLE hermes_runtime_state ADD COLUMN IF NOT EXISTS profile_name");
  });

  it("creates the hermes_profiles table in a migration", () => {
    expect(serverSrc).toContain("CREATE TABLE IF NOT EXISTS hermes_profiles");
  });

  it("backfills a default profile row for hermes agents", () => {
    expect(serverSrc).toContain("INSERT INTO hermes_profiles");
    expect(serverSrc).toContain("is_default");
  });

  it("keeps the fresh-install schema in sync", () => {
    expect(schemaSrc).toContain("CREATE TABLE IF NOT EXISTS hermes_profiles");
    expect(schemaSrc).toMatch(/hermes_runtime_state[\s\S]*profile_name/);
  });
});
