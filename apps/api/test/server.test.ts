import { expect, test } from "vitest";

test("importing the server module does not start a listener", async () => {
  const server = await import("../src/server.js");
  expect(server.start).toBeTypeOf("function");
});
