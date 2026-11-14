/** A plotted path includes the sample at the end of the stay. */
export function skylineWindow(count: number, start: number, hours: number) {
  const a = Math.max(0, Math.min(count - 1, Math.round(start)))
  const b = Math.min(count - 1, a + Math.max(0, Math.round(hours)))
  return { a, b }
}

/** Keep fractional positions in the final hour, with a valid interpolation pair. */
export function skylineSample(count: number, a: number, b: number, cursor: number) {
  const index = Math.max(a, Math.min(b, cursor))
  const k0 = Math.min(Math.floor(index), count - 2)
  return { index, k0, t: index - k0 }
}
