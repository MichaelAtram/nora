function table(rows, columns) {
  if (rows.length === 0) {
    console.log("(none)");
    return;
  }
  const widths = columns.map((col) =>
    Math.max(col.header.length, ...rows.map((row) => String(col.value(row) ?? "").length)),
  );
  const fmt = (cells) => cells.map((cell, i) => String(cell ?? "").padEnd(widths[i])).join("  ");
  console.log(fmt(columns.map((c) => c.header)));
  console.log(fmt(widths.map((w) => "-".repeat(w))));
  for (const row of rows) console.log(fmt(columns.map((c) => c.value(row))));
}

module.exports = table;
