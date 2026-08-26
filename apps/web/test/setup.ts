import "@testing-library/jest-dom/vitest";
import "fake-indexeddb/auto";
import { cleanup } from "@testing-library/react";
import { vi } from "vitest";
import { afterEach } from "vitest";

const canvasContext = {
  setTransform: vi.fn(), clearRect: vi.fn(), beginPath: vi.fn(), moveTo: vi.fn(),
  lineTo: vi.fn(), stroke: vi.fn(), lineCap: "round", lineJoin: "round",
  strokeStyle: "", lineWidth: 1, globalAlpha: 1,
};

Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
  configurable: true,
  value: vi.fn(() => canvasContext as unknown as CanvasRenderingContext2D),
});

afterEach(() => cleanup());
