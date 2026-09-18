import { CuberouterAuthInputSchema } from "@memmy/local-api-contracts";
import { describe, expect, it } from "vitest";
import { ApiRequestError } from "../../api/http.js";
import { toFeedbackText, validateCredentials } from "../use-account-auth.js";

const translate = (key: string) => `translated:${key}`;

describe("validateCredentials", () => {
  it("accepts an 8-20 char password with upper, lower and digit", () => {
    expect(validateCredentials({ username: "alice", password: "Passw0rd1" })).toEqual({
      ok: true,
      username: "alice",
      password: "Passw0rd1"
    });
  });

  it("accepts passwords at both length boundaries", () => {
    const shortest = "Passw0rd";
    const longest = "Passw0rd1Passw0rd1Pa";

    expect(shortest).toHaveLength(8);
    expect(longest).toHaveLength(20);
    expect(validateCredentials({ username: "alice", password: shortest })).toEqual({
      ok: true,
      username: "alice",
      password: shortest
    });
    expect(validateCredentials({ username: "alice", password: longest })).toEqual({
      ok: true,
      username: "alice",
      password: longest
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

  it("carries the email and code through when the instance requires them", () => {
    expect(
      validateCredentials({
        username: "alice",
        password: "Passw0rd1",
        email: " alice@example.com ",
        verificationCode: " 123456 ",
        emailVerificationRequired: true
      })
    ).toEqual({
      ok: true,
      username: "alice",
      password: "Passw0rd1",
      email: "alice@example.com",
      verificationCode: "123456"
    });
  });

  it("requires a well-formed address and a code when the instance verifies email", () => {
    const base = { username: "alice", password: "Passw0rd1", emailVerificationRequired: true };

    expect(validateCredentials({ ...base, email: "", verificationCode: "123456" })).toEqual({
      ok: false,
      reason: "email"
    });
    expect(validateCredentials({ ...base, email: "alice@example", verificationCode: "123456" })).toEqual({
      ok: false,
      reason: "email"
    });
    expect(validateCredentials({ ...base, email: "alice@example.com", verificationCode: "   " })).toEqual({
      ok: false,
      reason: "verificationCode"
    });
  });

  it("ignores both fields when the instance does not verify email", () => {
    // Login never shows them, and an instance without verification does not want them: a
    // stray value must not turn into a rejection.
    expect(validateCredentials({ username: "alice", password: "Passw0rd1" })).toEqual({
      ok: true,
      username: "alice",
      password: "Passw0rd1"
    });
  });
});

describe("toFeedbackText", () => {
  it("surfaces the server's own business message", () => {
    const error = new ApiRequestError("用户名或密码不正确", 400, "invalid_argument");

    expect(toFeedbackText(error, translate)).toBe("用户名或密码不正确");
  });

  it("falls back to translated copy for internal envelopes and transport failures", () => {
    const internalError = new ApiRequestError("database connection failed", 500, "internal");
    const transportError = new TypeError("Failed to fetch");

    expect(toFeedbackText(internalError, translate)).toBe("translated:account.error.requestFailed");
    expect(toFeedbackText(transportError, translate)).toBe("translated:account.error.requestFailed");
  });

  it("keeps a schema error's issue list out of the feedback text", () => {
    let schemaError: unknown;
    try {
      CuberouterAuthInputSchema.parse({ username: "alice", password: "short" });
    } catch (error) {
      schemaError = error;
    }

    expect(schemaError).toBeInstanceOf(Error);
    expect(toFeedbackText(schemaError, translate)).toBe("translated:account.error.requestFailed");
  });
});
