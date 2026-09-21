
export const extractPackedFiles = (packed, packageName) => {
  // npm 10/11 returns pack metadata as an array.
  if (Array.isArray(packed)) {
    if (packed.length > 0 && Array.isArray(packed[0]?.files)) {
      return packed[0].files;
    }
  }

  // npm 12 returns pack metadata as an object keyed by package name.
  if (
    packed &&
    typeof packed === "object" &&
    packageName in packed &&
    Array.isArray(packed[packageName]?.files)
  ) {
    return packed[packageName].files;
  }

  // Fail loudly instead of silently checking an empty or arbitrary file list.
  throw new Error(
    `unexpected npm pack output shape: ${
      Array.isArray(packed) ? "array" : typeof packed
    }`,
  );
};