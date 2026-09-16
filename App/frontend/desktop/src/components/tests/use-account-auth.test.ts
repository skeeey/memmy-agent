import { describe, expect, it } from "vitest";
import { validateCredentials } from "../use-account-auth.js";

describe("validateCredentials", () => {
  it("accepts an 8-20 char password with upper, lower and digit", () => {
    expect(validateCredentials({ username: "alice", password: "Passw0rd1" })).toEqual({
      ok: true,
      username: "alice",
      password: "Passw0rd1"
    });
  });

  it("rejects a missing username", () => {
    expect(validateCredentials({ username: "   ", password: "Passw0rd1" })).toEqual({
      ok: false,
      reason: "username"
    });
  });

  it("rejects passwords shorter than 8 or longer than 20", () => {
    expect(validateCredentials({ username: "alice", password: "Pa0ss" })).toEqual({ ok: false, reason: "password" });
    expect(validateCredentials({ username: "alice", password: `Pa0${"x".repeat(20)}` })).toEqual({
      ok: false,
      reason: "password"
    });
  });

  it("rejects passwords missing an upper case, lower case or digit", () => {
    expect(validateCredentials({ username: "alice", password: "passw0rdd" })).toEqual({ ok: false, reason: "password" });
    expect(validateCredentials({ username: "alice", password: "PASSW0RDD" })).toEqual({ ok: false, reason: "password" });
    expect(validateCredentials({ username: "alice", password: "Passwordd" })).toEqual({ ok: false, reason: "password" });
  });

  it("rejects mismatched confirmation", () => {
    expect(
      validateCredentials({ username: "alice", password: "Passw0rd1", confirmPassword: "Passw0rd2" })
    ).toEqual({ ok: false, reason: "confirm" });
  });
});
