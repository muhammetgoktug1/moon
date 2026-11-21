import { test } from "node:test";
import assert from "node:assert/strict";
import { isInternalCa } from "./checker.js";

test("Caddy iç CA'sı tanınır, genel CA tanınmaz", () => {
  assert.equal(isInternalCa({ issuer: "Caddy Local Authority - ECC Intermediate" }), true);
  assert.equal(isInternalCa({ issuer: "Let's Encrypt" }), false);
  assert.equal(isInternalCa({}), false);
  assert.equal(isInternalCa(undefined), false);
});
