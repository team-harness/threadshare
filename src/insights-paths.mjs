import os from "node:os";
import path from "node:path";
import process from "node:process";

export const INSIGHTS_DATABASE_FILENAME = "insights.sqlite3";

function environmentPath(environment, name) {
  const value = environment?.[name];
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function absolutePath(pathApi, value, currentDirectory) {
  return pathApi.isAbsolute(value) ? pathApi.normalize(value) : pathApi.resolve(currentDirectory, value);
}

export function resolveInsightsPaths(options = {}) {
  const platform = options.platform ?? process.platform;
  const environment = options.environment ?? process.env;
  const environmentHome = platform === "win32"
    ? environmentPath(environment, "USERPROFILE")
    : environmentPath(environment, "HOME");
  const homeDirectory = options.homeDirectory ?? environmentHome ?? os.homedir();
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  const currentDirectory = options.currentDirectory ?? process.cwd();

  let stateDirectory;
  let configFile;
  if (platform === "win32") {
    const localAppData = environmentPath(environment, "LOCALAPPDATA") ??
      pathApi.join(homeDirectory, "AppData", "Local");
    const appData = environmentPath(environment, "APPDATA") ??
      pathApi.join(homeDirectory, "AppData", "Roaming");
    stateDirectory = pathApi.join(localAppData, "threadshare", "insights");
    configFile = pathApi.join(appData, "threadshare", "config.json");
  } else if (platform === "darwin") {
    const applicationSupport = pathApi.join(homeDirectory, "Library", "Application Support");
    stateDirectory = pathApi.join(applicationSupport, "threadshare", "insights");
    configFile = pathApi.join(applicationSupport, "threadshare", "config.json");
  } else {
    const stateHome = environmentPath(environment, "XDG_STATE_HOME") ??
      pathApi.join(homeDirectory, ".local", "state");
    const configHome = environmentPath(environment, "XDG_CONFIG_HOME") ??
      pathApi.join(homeDirectory, ".config");
    stateDirectory = pathApi.join(stateHome, "threadshare", "insights");
    configFile = pathApi.join(configHome, "threadshare", "config.json");
  }

  const stateOverride = environmentPath(environment, "THREADSHARE_INSIGHTS_HOME");
  const configOverride = environmentPath(environment, "THREADSHARE_CONFIG");
  if (stateOverride) stateDirectory = absolutePath(pathApi, stateOverride, currentDirectory);
  if (configOverride) configFile = absolutePath(pathApi, configOverride, currentDirectory);

  const resolved = {
    stateDirectory,
    configFile,
    databaseFile: pathApi.join(stateDirectory, INSIGHTS_DATABASE_FILENAME),
    originSecretFile: pathApi.join(stateDirectory, "origin-secret.json"),
    lockFile: pathApi.join(stateDirectory, "insights.lock"),
    tempDirectory: pathApi.join(stateDirectory, "tmp"),
  };
  Object.defineProperty(resolved, "configDirectoryManaged", {
    value: configOverride === undefined,
    enumerable: false,
  });
  return Object.freeze(resolved);
}
