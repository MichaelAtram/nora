const test = require("node:test");
const assert = require("node:assert");
const table = require("./table");

test("table with empty rows prints (none)", () => {
  const logs = [];
  const originalLog = console.log;
  console.log = (msg) => logs.push(msg);

  try {
    table([], [{ header: "ID", value: (r) => r.id }]);
    assert.deepStrictEqual(logs, ["(none)"]);
  } finally {
    console.log = originalLog;
  }
});

test("table with rows formats output correctly", () => {
  const logs = [];
  const originalLog = console.log;
  console.log = (msg) => logs.push(msg);

  try {
    const rows = [
      { id: "1", name: "Alice" },
      { id: "100", name: "Bob" },
    ];
    table(rows, [
      { header: "ID", value: (r) => r.id },
      { header: "NAME", value: (r) => r.name },
    ]);
    assert.deepStrictEqual(logs, ["ID   NAME ", "---  -----", "1    Alice", "100  Bob  "]);
  } finally {
    console.log = originalLog;
  }
});
