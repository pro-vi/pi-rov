import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { writeTextAtomic } from "../src/atomic-write.js";

void test("atomic text writes replace the target through an ignored temp sidecar", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-canvas-atomic-write-"));
  const target = join(dir, "nested", "receipt-browser-host-receipt.json");

  await writeTextAtomic(target, "first\n");
  await writeTextAtomic(target, "second\n");

  assert.equal(await readFile(target, "utf-8"), "second\n");
  assert.deepEqual(await readdir(join(dir, "nested")), ["receipt-browser-host-receipt.json"]);

  await rm(dir, { recursive: true, force: true });
});
