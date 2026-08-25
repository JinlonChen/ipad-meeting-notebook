export function downsampleToPcm16(
  input: Float32Array,
  inputRate: number,
  outputRate = 16_000,
): Uint8Array {
  if (!Number.isFinite(inputRate) || !Number.isFinite(outputRate) || inputRate <= 0 || outputRate <= 0 || outputRate > inputRate) {
    throw new Error("INVALID_SAMPLE_RATE");
  }

  const ratio = inputRate / outputRate;
  const outputLength = Math.floor(input.length / ratio);
  const bytes = new Uint8Array(outputLength * 2);
  const view = new DataView(bytes.buffer);

  for (let index = 0; index < outputLength; index += 1) {
    const start = Math.floor(index * ratio);
    const end = Math.max(start + 1, Math.min(input.length, Math.floor((index + 1) * ratio)));
    let total = 0;
    for (let sourceIndex = start; sourceIndex < end; sourceIndex += 1) total += input[sourceIndex] ?? 0;
    const sample = Math.max(-1, Math.min(1, total / (end - start)));
    const pcm = Math.trunc(sample < 0 ? sample * 0x8000 : sample * 0x7fff);
    view.setInt16(index * 2, pcm, true);
  }

  return bytes;
}
