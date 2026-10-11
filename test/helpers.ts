export const DAY = 24 * 60 * 60 * 1000;
export const T0 = Date.parse("2026-10-01T12:00:00.000Z");

/** Horário ISO a partir de T0 + deslocamento em ms. */
export const at = (ms: number) => new Date(T0 + ms).toISOString();

/** Relógio manual para testes. */
export function fakeClock(start = T0) {
  let current = start;
  return {
    now: () => new Date(current),
    set: (ms: number) => {
      current = T0 + ms;
    },
  };
}
