import { describe, expect, test } from "vitest";

import { normalizeBasePath } from "../../src/app/base-path.js";

describe("normalizeBasePath", () => {
  test.each([
    [undefined, "/"],
    ["", "/"],
    ["/", "/"],
    ["ipad-meeting-notebook", "/ipad-meeting-notebook/"],
    ["//ipad-meeting-notebook//", "/ipad-meeting-notebook/"],
    [" /team/notebook/ ", "/team/notebook/"],
  ])("normalizes %j to %s", (value, expected) => {
    expect(normalizeBasePath(value)).toBe(expected);
  });
});
