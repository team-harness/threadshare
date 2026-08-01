const SHARE_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const INVALID_SHARE_URL = "Share URL must be a valid Threadshare viewer or API URL";

function normalizedReference(origin, basePath, id) {
  const normalizedId = id.toLowerCase();
  if (
    basePath !== "" &&
    (!basePath.startsWith("/") || basePath.endsWith("/") || basePath.includes("//"))
  ) {
    throw new Error(INVALID_SHARE_URL);
  }
  const api = new URL(origin);
  api.pathname = `${basePath}/api/v1/shares/${normalizedId}`;
  const viewer = new URL(origin);
  viewer.pathname = `${basePath}/`;
  viewer.searchParams.set("id", normalizedId);
  return { id: normalizedId, apiUrl: api.toString(), url: viewer.toString() };
}

export function parseShareReference(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(INVALID_SHARE_URL);
  }
  if (
    (parsed.protocol !== "https:" && parsed.protocol !== "http:") ||
    parsed.username !== "" ||
    parsed.password !== ""
  ) {
    throw new Error(INVALID_SHARE_URL);
  }

  const apiMatch = /^(.*)\/api\/v1\/shares\/([^/]+)$/.exec(parsed.pathname);
  if (apiMatch && parsed.search === "" && SHARE_ID_PATTERN.test(apiMatch[2])) {
    return normalizedReference(parsed.origin, apiMatch[1], apiMatch[2]);
  }

  if (parsed.pathname.endsWith("/") && parsed.searchParams.size === 1) {
    const id = parsed.searchParams.get("id");
    if (id && SHARE_ID_PATTERN.test(id)) {
      return normalizedReference(parsed.origin, parsed.pathname.slice(0, -1), id);
    }
  }

  throw new Error(INVALID_SHARE_URL);
}
