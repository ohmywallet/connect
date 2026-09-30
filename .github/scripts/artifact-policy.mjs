import { types as utilTypes } from "node:util";

export const CONNECT_FIXED_PACK_FILES = Object.freeze([
  "LICENSE",
  "README.ko.md",
  "README.md",
  "dist/index.d.ts",
  "dist/index.js",
  "dist/wagmi.d.ts",
  "dist/wagmi.js",
  "package.json",
]);
export const CONNECT_PACK_FILE_COUNT = CONNECT_FIXED_PACK_FILES.length + 1;
const declarationChunk = /^dist\/provider-[A-Za-z0-9_-]{8}\.d\.ts$/u;

export function isConnectPackFile(file) {
  return (
    typeof file === "string" &&
    (CONNECT_FIXED_PACK_FILES.includes(file) || declarationChunk.test(file))
  );
}

/** Exact public entrypoints plus one generated shared declaration; no arbitrary dist files. */
export function validateConnectPackFiles(value, { prefix = "", ordered = true } = {}) {
  const invalid = () => {
    throw new TypeError("Invalid Connect artifact files.");
  };
  if (
    !Array.isArray(value) ||
    utilTypes.isProxy(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length !== CONNECT_PACK_FILE_COUNT
  )
    invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).length !== value.length + 1) invalid();
  const files = [];
  for (let i = 0; i < value.length; i++) {
    const d = descriptors[String(i)];
    if (
      !d ||
      !Object.hasOwn(d, "value") ||
      !d.enumerable ||
      typeof d.value !== "string" ||
      !d.value.startsWith(prefix)
    )
      invalid();
    files.push(d.value.slice(prefix.length));
  }
  if (
    new Set(files).size !== CONNECT_PACK_FILE_COUNT ||
    files.some((f) => !isConnectPackFile(f)) ||
    CONNECT_FIXED_PACK_FILES.some((f) => !files.includes(f)) ||
    files.filter((f) => declarationChunk.test(f)).length !== 1
  )
    invalid();
  const sorted = files.toSorted().map((f) => prefix + f);
  if (ordered && sorted.some((f, i) => f !== value[i])) invalid();
  return Object.freeze(sorted);
}
