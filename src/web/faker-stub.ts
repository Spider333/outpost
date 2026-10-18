// @farcaster/core bundles test-data factories that import @faker-js/faker (3.6 MB, with a
// security advisory in helpers.fake). Some factories run at import time, but the client never
// uses their output. The browser build swaps faker for this small stand-in with the same
// calls, so the bundle is ~3.5 MB smaller and ships no faker code.
const int = (o: { min?: number; max?: number } = {}) => {
  const min = o.min ?? 0;
  const max = o.max ?? 99999;
  return min + Math.floor(Math.random() * (max - min + 1));
};

export const faker = {
  datatype: {
    number: int,
    datetime: () => new Date(),
  },
  date: {
    between: (from: string | Date, to: string | Date) => {
      const a = new Date(from).getTime();
      const b = new Date(to).getTime();
      return new Date(a + Math.random() * (b - a));
    },
  },
  helpers: {
    arrayElement: <T>(arr: readonly T[]): T => arr[int({ max: arr.length - 1 })]!,
  },
  internet: { url: () => "https://example.org" },
  lorem: { sentence: () => "placeholder" },
  random: {
    alphaNumeric: (n = 1) => Array.from({ length: n }, () => "abcdefghijklmnopqrstuvwxyz0123456789"[int({ max: 35 })]).join(""),
  },
};
