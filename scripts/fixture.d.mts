export const fixture: {
  repository: string;
  tag: string;
  asset: string;
  sha256: string;
};
export function verifyFixture(file: string, expected?: { sha256: string }): string;
