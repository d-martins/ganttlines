import { describe, expect, it } from "vitest";
import { CreateUserBody, LoginBody, SetupBody, UpdateProjectBody } from "../src/api";

describe("API schemas", () => {
  it("normalises emails to lower case", () => {
    expect(LoginBody.parse({ email: "Ana@Example.COM", password: "x" }).email).toBe("ana@example.com");
  });

  it("enforces password length and trims names", () => {
    expect(SetupBody.safeParse({ email: "a@b.co", name: "A", password: "short", setupCode: "X" }).success).toBe(false);
    expect(SetupBody.parse({ email: "a@b.co", name: "  Ana  ", password: "long enough", setupCode: "X" }).name).toBe("Ana");
    expect(SetupBody.safeParse({ email: "a@b.co", name: "A", password: "long enough" }).success).toBe(false); // the setup code is required
  });

  it("defaults createResource to true and rejects unknown roles", () => {
    expect(CreateUserBody.parse({ email: "a@b.co", name: "A", role: "viewer" }).createResource).toBe(true);
    expect(CreateUserBody.safeParse({ email: "a@b.co", name: "A", role: "owner" }).success).toBe(false);
  });

  it("rejects unknown fields", () => {
    expect(UpdateProjectBody.safeParse({ name: "P", colour: "red" }).success).toBe(false);
  });
});
