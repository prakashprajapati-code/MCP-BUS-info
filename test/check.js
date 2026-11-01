"use strict";

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const folders = [root, path.join(root, "scripts")];

const files = folders
  .flatMap((folder) =>
    fs.existsSync(folder)
      ? fs
          .readdirSync(folder)
          .filter((file) => file.endsWith(".js"))
          .map((file) => path.join(folder, file))
      : [],
  )
  .sort();

let failed = 0;

for (const file of files) {
  const result = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });

  if (result.status === 0) {
    console.log(`ok   ${path.relative(root, file)}`);
  } else {
    failed += 1;
    console.error(`FAIL ${path.relative(root, file)}\n${result.stderr.trim()}`);
  }
}

console.log(failed === 0 ? `\n${files.length} files OK` : `\n${failed} file(s) failed`);
process.exit(failed === 0 ? 0 : 1);
