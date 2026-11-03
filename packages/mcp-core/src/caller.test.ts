import { describe, expect, it } from "vitest";

import { createCallerScope, CallerScopeError } from "./caller";

describe(createCallerScope, () => {
  it("throws when no caller is active", () => {
    expect(() => createCallerScope().require()).toThrow(CallerScopeError);
  });

  it("keeps overlapping calls from observing each other's token", async () => {
    const scope = createCallerScope();
    const seen: string[] = [];

    const first = scope.run(
      { subjectOpaque: "aaaa", token: "token-a" },
      async () => {
        await Promise.resolve();
        seen.push(scope.require().token);
        await Promise.resolve();
        seen.push(scope.require().token);

        return "a";
      }
    );

    const second = scope.run(
      { subjectOpaque: "bbbb", token: "token-b" },
      () => {
        seen.push(scope.require().token);

        return Promise.resolve("b");
      }
    );

    await expect(Promise.all([first, second])).resolves.toStrictEqual([
      "a",
      "b",
    ]);
    expect(seen).toStrictEqual(["token-a", "token-a", "token-b"]);
  });

  it("clears the caller and keeps the queue moving after a failure", async () => {
    const scope = createCallerScope();

    const failing = scope.run({ subjectOpaque: "aaaa", token: "a" }, () =>
      Promise.reject(new Error("boom"))
    );

    await expect(failing).rejects.toThrow("boom");
    await expect(
      scope.run({ subjectOpaque: "bbbb", token: "b" }, () =>
        Promise.resolve(scope.require().token)
      )
    ).resolves.toBe("b");
    expect(() => scope.require()).toThrow(CallerScopeError);
  });
});
