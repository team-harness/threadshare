export const INSIGHTS_ENGINE_TARGETS = Object.freeze([
  Object.freeze({
    target: "darwin-arm64",
    platform: "darwin",
    arch: "arm64",
    os: "darwin",
    cpu: "arm64",
    rustTarget: "aarch64-apple-darwin",
    abi: "mach-o",
    minimumOs: "macOS 13",
  }),
  Object.freeze({
    target: "darwin-x64",
    platform: "darwin",
    arch: "x64",
    os: "darwin",
    cpu: "x64",
    rustTarget: "x86_64-apple-darwin",
    abi: "mach-o",
    minimumOs: "macOS 13",
  }),
  Object.freeze({
    target: "linux-arm64",
    platform: "linux",
    arch: "arm64",
    os: "linux",
    cpu: "arm64",
    rustTarget: "aarch64-unknown-linux-musl",
    abi: "musl-static",
    minimumOs: "Linux 4.14",
  }),
  Object.freeze({
    target: "linux-x64",
    platform: "linux",
    arch: "x64",
    os: "linux",
    cpu: "x64",
    rustTarget: "x86_64-unknown-linux-musl",
    abi: "musl-static",
    minimumOs: "Linux 4.14",
  }),
  Object.freeze({
    target: "win32-arm64",
    platform: "win32",
    arch: "arm64",
    os: "win32",
    cpu: "arm64",
    rustTarget: "aarch64-pc-windows-msvc",
    abi: "msvc",
    minimumOs: "Windows 10 1809",
  }),
  Object.freeze({
    target: "win32-x64",
    platform: "win32",
    arch: "x64",
    os: "win32",
    cpu: "x64",
    rustTarget: "x86_64-pc-windows-msvc",
    abi: "msvc",
    minimumOs: "Windows 10 1809",
  }),
]);

export function insightsEngineTarget(platform = process.platform, arch = process.arch) {
  return INSIGHTS_ENGINE_TARGETS.find((candidate) =>
    candidate.platform === platform && candidate.arch === arch
  ) ?? null;
}

export function insightsEnginePackageName(target) {
  const match = INSIGHTS_ENGINE_TARGETS.find((candidate) => candidate.target === target);
  if (!match) throw new TypeError(`unknown Insights Engine target: ${target}`);
  return `@team-harness/threadshare-${target}`;
}
