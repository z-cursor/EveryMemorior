import assert from "node:assert/strict";
import test from "node:test";
import { publicationBlocker } from "./companion-publication-ui.ts";

const passed = { configVersionId: "draft-1", status: "completed", fatalCount: 0, averageScore: 85 };

test("publication guidance requires completed evidence for the exact version", () => {
  assert.ok(publicationBlocker("draft-1", []));
  assert.ok(publicationBlocker("draft-2", [passed]));
  assert.ok(publicationBlocker("draft-1", [{ ...passed, status: "running" }]));
  assert.ok(publicationBlocker("draft-1", [{ ...passed, status: "failed" }]));
});

test("publication guidance matches the existing score and fatal-issue boundary", () => {
  assert.equal(publicationBlocker("draft-1", [passed]), null);
  assert.ok(publicationBlocker("draft-1", [{ ...passed, averageScore: 84.99 }]));
  assert.ok(publicationBlocker("draft-1", [{ ...passed, fatalCount: 1 }]));
  assert.ok(publicationBlocker("draft-1", [{ ...passed, averageScore: Number.NaN }]));
});

test("any qualifying completed run satisfies the same server precondition", () => {
  assert.equal(publicationBlocker("draft-1", [{ ...passed, fatalCount: 1 }, passed]), null);
});
