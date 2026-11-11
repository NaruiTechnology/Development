import test from "node:test";
import assert from "node:assert/strict";
import {accountIdentity} from "../src/accountIdentity";
import type {AdminUser} from "../src/adminDbRepository";

test("DB outage does not report an existing sign-in as unregistered", async () => {
  const offline = async (): Promise<AdminUser | null> => { throw new Error("DB timeout"); };
  await assert.rejects(accountIdentity(offline, () => null), error =>
    (error as {status?: number}).status === 503);
  const user = {id: 10, login_name: "operator"} as AdminUser;
  assert.equal(await accountIdentity(offline, () => user), user);
  assert.equal(await accountIdentity(async () => user, () => null), user);
  assert.equal(await accountIdentity(async () => null, () => null), null,
    "a confirmed missing account remains distinct from an outage");
});
