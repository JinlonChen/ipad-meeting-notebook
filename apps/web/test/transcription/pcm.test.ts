import { describe, expect, test } from "vitest";

import { downsampleToPcm16 } from "../../src/transcription/pcm.js";

function samples(bytes: Uint8Array): number[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return Array.from({ length: bytes.byteLength / 2 }, (_, index) => view.getInt16(index * 2, true));
}

describe("downsampleToPcm16", () => {
  test("averages source-rate windows into little-endian 16 kHz PCM16", () => {
    const input = new Float32Array([
      1, 1, 1,
      -1, -1, -1,
      0.5, 0.5, 0.5,
      -0.5, -0.5, -0.5,
    ]);

    expect(samples(downsampleToPcm16(input, 48_000))).toEqual([32_767, -32_768, 16_383, -16_384]);
  });

  test("clamps samples outside the Web Audio range", () => {
    const input = new Float32Array([2, 2, 2, -2, -2, -2]);

    expect(samples(downsampleToPcm16(input, 48_000, 16_000))).toEqual([32_767, -32_768]);
  });

  test("rejects upsampling and invalid rates", () => {
    expect(() => downsampleToPcm16(new Float32Array([0]), 8_000)).toThrow("INVALID_SAMPLE_RATE");
    expect(() => downsampleToPcm16(new Float32Array([0]), 0)).toThrow("INVALID_SAMPLE_RATE");
  });
});
