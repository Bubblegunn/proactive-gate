// Shared semantic version comparison used by the release and release-gate scripts.
// Keep this logic in one place so both scripts agree on version ordering.
export const compareVersions = (a, b) => {
  const x = a.split(".").map(Number);
  const y = b.split(".").map(Number);

  for (let i = 0; i < 3; i++) {
    if (x[i] !== y[i]) return x[i] - y[i];
  }

  return 0;
};