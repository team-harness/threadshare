import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import {
  EXPECTED_PACKAGE_FILES,
  assertPreparedIntegrity,
  compareStableVersions,
  decidePublish,
  fetchPackument,
  parseArguments,
  validatePackOutput,
  validatePublishedRelease,
  validateReleaseMetadata,
  writeOutputs,
} from "../scripts/verify-release.mjs";
import { validateSkillDirectory } from "../scripts/validate-skill.mjs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const expectedPackageFiles = [
  "LICENSE",
  "README.md",
  "README.zh-CN.md",
  "bin/threadshare.mjs",
  "package.json",
  "schema/session-facts-delta.v1.schema.json",
  "schema/threadshare-history.v1.schema.json",
  "skills/threadshare/SKILL.md",
  "skills/threadshare/agents/openai.yaml",
  "src/agent-transcript.mjs",
  "src/cli-contract.mjs",
  "src/history-selection.mjs",
  "src/paseo-session-bridge.mjs",
  "src/provider-evidence.mjs",
  "src/session-export.mjs",
  "src/session-facts.mjs",
  "src/session-files.mjs",
  "src/session-listing.mjs",
  "src/session-record-reader.mjs",
  "src/share-preflight.mjs",
  "src/share-read.mjs",
  "src/share-url.mjs",
];
const integrity = "sha512-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const allowedJobEnvContexts = new Set([
  "github",
  "inputs",
  "matrix",
  "needs",
  "secrets",
  "strategy",
  "vars",
]);

function expressionContextRoots(value) {
  const roots = [];
  for (const expressionMatch of value.matchAll(/\$\{\{([\s\S]*?)\}\}/g)) {
    for (const contextMatch of expressionMatch[1].matchAll(
      /(?:^|[^\w.])([A-Za-z_][A-Za-z0-9_]*)\s*(?=\.|\[|\s*$)/g,
    )) {
      roots.push(contextMatch[1].toLowerCase());
    }
  }
  return roots;
}

function packument({ latest = "0.4.1", versions = {} } = {}) {
  return {
    name: "@team-harness/threadshare",
    "dist-tags": { latest },
    versions: { [latest]: {}, ...versions },
  };
}

test("validates stable release metadata and numeric semver ordering", () => {
  assert.deepEqual(
    validateReleaseMetadata({
      tag: "0.4.2",
      packageJson: { name: "@team-harness/threadshare", version: "0.4.2" },
      packageLock: {
        name: "@team-harness/threadshare",
        version: "0.4.2",
        packages: { "": { name: "@team-harness/threadshare", version: "0.4.2" } },
      },
    }),
    { name: "@team-harness/threadshare", version: "0.4.2" },
  );
  assert.equal(compareStableVersions("0.10.0", "0.9.9"), 1);
  assert.equal(compareStableVersions("1.0.0", "1.0.0"), 0);
  assert.throws(
    () =>
      validateReleaseMetadata({
        tag: "v0.4.2",
        packageJson: { name: "@team-harness/threadshare", version: "0.4.2" },
        packageLock: { version: "0.4.2", packages: { "": { version: "0.4.2" } } },
      }),
    /stable semver/,
  );
});

test("locks npm pack to the exact twenty-two public files", () => {
  assert.deepEqual(EXPECTED_PACKAGE_FILES, expectedPackageFiles);
  const packed = {
    name: "@team-harness/threadshare",
    version: "0.4.2",
    integrity,
    entryCount: expectedPackageFiles.length,
    files: expectedPackageFiles.map((filePath) => ({ path: filePath })),
  };
  assert.deepEqual(
    validatePackOutput(
      { "@team-harness/threadshare": packed },
      { name: "@team-harness/threadshare", version: "0.4.2" },
    ),
    { integrity, files: expectedPackageFiles },
  );
  assert.deepEqual(
    validatePackOutput([packed], {
      name: "@team-harness/threadshare",
      version: "0.4.2",
    }),
    { integrity, files: expectedPackageFiles },
  );
  assert.throws(
    () =>
      validatePackOutput(
        [
          {
            name: "@team-harness/threadshare",
            version: "0.4.2",
            integrity,
            entryCount: expectedPackageFiles.length + 1,
            files: [...expectedPackageFiles, "scripts/verify-release.mjs"].map((filePath) => ({
              path: filePath,
            })),
          },
        ],
        { name: "@team-harness/threadshare", version: "0.4.2" },
      ),
    /package files/,
  );
});

test("publishes only above the highest stable version and skips identical existing content", () => {
  assert.deepEqual(
    decidePublish({
      packument: packument(),
      packageName: "@team-harness/threadshare",
      version: "0.4.2",
      integrity,
    }),
    { latest: "0.4.1", shouldPublish: true },
  );
  assert.throws(
    () =>
      decidePublish({
        packument: packument({ latest: "0.4.3" }),
        packageName: "@team-harness/threadshare",
        version: "0.4.2",
        integrity,
      }),
    /newer than highest published stable/,
  );
  assert.throws(
    () =>
      decidePublish({
        packument: packument({ latest: "0.4.1", versions: { "0.4.3": {} } }),
        packageName: "@team-harness/threadshare",
        version: "0.4.2",
        integrity,
      }),
    /highest published stable 0\.4\.3/,
  );
  assert.deepEqual(
    decidePublish({
      packument: packument({
        latest: "0.4.3",
        versions: { "0.4.2": { dist: { integrity } } },
      }),
      packageName: "@team-harness/threadshare",
      version: "0.4.2",
      integrity,
    }),
    { latest: "0.4.3", shouldPublish: false },
  );
  assert.throws(
    () =>
      decidePublish({
        packument: packument({
          versions: { "0.4.2": { dist: { integrity: "sha512-different" } } },
        }),
        packageName: "@team-harness/threadshare",
        version: "0.4.2",
        integrity,
      }),
    /integrity differs/,
  );
});

test("validates verifier arguments, GitHub outputs, and prepared integrity", async () => {
  assert.deepEqual(
    parseArguments(["prepare", "--tag", "0.4.2", "--github-output", "/tmp/output"]),
    {
      command: "prepare",
      options: { tag: "0.4.2", github_output: "/tmp/output" },
    },
  );
  assert.throws(
    () => parseArguments(["prepare", "--tag", "0.4.2", "--tag", "0.4.3"]),
    /Duplicate release verifier option/,
  );
  assert.throws(() => parseArguments(["confirm", "--tag", "0.4.2"]), /expected-integrity/);

  const fixture = await mkdtemp(path.join(os.tmpdir(), "threadshare-release-output-"));
  const outputPath = path.join(fixture, "github-output");
  try {
    await writeOutputs(outputPath, { integrity, should_publish: true, version: "0.4.2" });
    assert.equal(
      await readFile(outputPath, "utf8"),
      `integrity=${integrity}\nshould_publish=true\nversion=0.4.2\n`,
    );
    await assert.rejects(
      writeOutputs(outputPath, { unsafe: "value\nforged=true" }),
      /unsupported characters/,
    );
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }

  assert.doesNotThrow(() => assertPreparedIntegrity(integrity, integrity));
  assert.throws(
    () => assertPreparedIntegrity(integrity, "sha512-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB="),
    /changed between prepare and confirm/,
  );
});

test("requires SLSA provenance and never treats registry signatures as attestations", () => {
  const published = packument({
    latest: "0.4.2",
    versions: {
      "0.4.2": {
        dist: {
          integrity,
          attestations: {
            url: "https://registry.npmjs.org/-/npm/v1/attestations/threadshare@0.4.2",
            provenance: { predicateType: "https://slsa.dev/provenance/v1" },
          },
        },
      },
    },
  });
  assert.deepEqual(
    validatePublishedRelease({
      packument: published,
      packageName: "@team-harness/threadshare",
      version: "0.4.2",
      integrity,
    }),
    { latest: "0.4.2" },
  );
  published.versions["0.4.3"] = {};
  published["dist-tags"].latest = "0.4.3";
  assert.deepEqual(
    validatePublishedRelease({
      packument: published,
      packageName: "@team-harness/threadshare",
      version: "0.4.2",
      integrity,
    }),
    { latest: "0.4.3" },
  );
  published.versions["0.4.1"] = {};
  published["dist-tags"].latest = "0.4.1";
  assert.throws(
    () =>
      validatePublishedRelease({
        packument: published,
        packageName: "@team-harness/threadshare",
        version: "0.4.2",
        integrity,
      }),
    /older than published release/,
  );
  published["dist-tags"].latest = "0.4.2";
  published.versions["0.4.2"].dist = { integrity, signatures: [{ sig: "registry" }] };
  assert.throws(
    () =>
      validatePublishedRelease({
        packument: published,
        packageName: "@team-harness/threadshare",
        version: "0.4.2",
        integrity,
      }),
    /provenance/,
  );
});

test("registry probing accepts only a successful JSON packument", async () => {
  const valid = packument();
  let requestOptions;
  const result = await fetchPackument({
    packageName: "@team-harness/threadshare",
    maxAttempts: 1,
    fetchImpl: async (_url, options) => {
      requestOptions = options;
      return new Response(JSON.stringify(valid), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
    sleep: async () => {},
  });
  assert.deepEqual(result, valid);
  assert.equal(requestOptions.headers["cache-control"], "no-cache");
  for (const response of [
    new Response("missing", { status: 404 }),
    new Response("unavailable", { status: 503 }),
    new Response("not-json", {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  ]) {
    await assert.rejects(
      fetchPackument({
        packageName: "@team-harness/threadshare",
        maxAttempts: 1,
        fetchImpl: async () => response.clone(),
        sleep: async () => {},
      }),
      /registry packument/,
    );
  }
});

test("validates the bundled Skill and rejects metadata drift", async () => {
  await assert.doesNotReject(validateSkillDirectory(path.join(root, "skills", "threadshare")));
  const fixture = await mkdtemp(path.join(os.tmpdir(), "threadshare-skill-"));
  const skillDirectory = path.join(fixture, "threadshare");
  try {
    await mkdir(path.join(skillDirectory, "agents"), { recursive: true });
    await writeFile(
      path.join(skillDirectory, "SKILL.md"),
      "---\nname: wrong-name\ndescription: Share a thread safely.\n---\n\n# Test\n",
    );
    await writeFile(
      path.join(skillDirectory, "agents", "openai.yaml"),
      'interface:\n  display_name: "Threadshare"\n  short_description: "Share agent threads with teammates"\n  default_prompt: "Use $threadshare to share this session."\n',
    );
    await assert.rejects(validateSkillDirectory(skillDirectory), /match the skill directory/);

    await writeFile(
      path.join(skillDirectory, "SKILL.md"),
      "---\nname: threadshare\ndescription: Share a thread safely.\nunexpected: true\n---\n\n# Test\n",
    );
    await assert.rejects(validateSkillDirectory(skillDirectory), /unexpected keys/);

    await writeFile(
      path.join(skillDirectory, "SKILL.md"),
      "---\nname: threadshare\ndescription: Share a thread safely.\n---\n\n# Test\n",
    );
    await writeFile(
      path.join(skillDirectory, "agents", "openai.yaml"),
      'interface:\n  display_name: "Threadshare"\n  short_description: "Share agent threads with teammates"\n  default_prompt: "Share this session."\n',
    );
    await assert.rejects(validateSkillDirectory(skillDirectory), /must mention \$threadshare/);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("workflow separates unprivileged verification from the tokenless OIDC publisher", async () => {
  const source = await readFile(path.join(root, ".github", "workflows", "publish-npm.yml"), "utf8");
  const workflow = parseYaml(source);
  assert.deepEqual(workflow.on, { release: { types: ["published"] } });
  assert.deepEqual(workflow.concurrency, {
    group: "threadshare-npm-publish",
    "cancel-in-progress": false,
  });
  const verify = workflow.jobs.verify;
  const publish = workflow.jobs.publish;
  assert.match(verify.if, /release\.draft == false/);
  assert.match(verify.if, /release\.prerelease == false/);
  assert.match(publish.if, /needs\.verify\.result == 'success'/);
  assert.equal(publish.needs, "verify");
  assert.equal(verify["runs-on"], "ubuntu-latest");
  assert.equal(publish["runs-on"], "ubuntu-latest");
  assert.deepEqual(verify.permissions, { contents: "read" });
  assert.deepEqual(publish.permissions, { contents: "read", "id-token": "write" });
  assert.equal(verify.outputs.integrity, "${{ steps.release.outputs.integrity }}");

  for (const invalidValue of [
    "${{ runner.temp }}",
    "${{ RUNNER['temp'] }}",
    "${{ env.CACHE }}",
    "${{ steps.pack.outputs.integrity }}",
    "${{ job.status }}",
  ]) {
    assert.ok(
      expressionContextRoots(invalidValue).some((rootContext) =>
        !allowedJobEnvContexts.has(rootContext)
      ),
    );
  }

  for (const job of [verify, publish]) {
    const checkout = job.steps.find((step) => step.name === "Checkout release commit");
    assert.equal(checkout.uses, "actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803");
    assert.equal(checkout.with.ref, "${{ github.sha }}");
    assert.equal(checkout.with["fetch-depth"], 0);
    assert.equal(checkout.with["persist-credentials"], false);
    const setupNode = job.steps.find((step) => step.name === "Set up Node.js");
    assert.equal(setupNode.uses, "actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38");
    assert.equal(setupNode.with["node-version"], "22.22.3");
    assert.equal(Object.hasOwn(setupNode.with, "cache"), false);
    assert.equal(Object.hasOwn(job, "environment"), false);
    for (const [name, value] of Object.entries(job.env)) {
      for (const rootContext of expressionContextRoots(String(value))) {
        assert.ok(
          allowedJobEnvContexts.has(rootContext),
          `job env ${name} uses unsupported context ${rootContext}`,
        );
      }
    }
    assert.equal(Object.hasOwn(job.env, "NPM_CONFIG_CACHE"), false);
    const configureCache = job.steps.find((step) => step.name === "Configure npm cache");
    assert.equal(
      configureCache.run,
      "set -euo pipefail\nprintf 'NPM_CONFIG_CACHE=%s\\n' \"$RUNNER_TEMP/threadshare-npm-cache\" >> \"$GITHUB_ENV\"\n",
    );
  }

  const verifyCommands = verify.steps.map((step) => step.run ?? "").join("\n");
  const publishCommands = publish.steps.map((step) => step.run ?? "").join("\n");
  assert.match(verifyCommands, /npm ci/);
  assert.match(verifyCommands, /npm test/);
  assert.match(verifyCommands, /npm run build:cloudflare/);
  assert.match(verifyCommands, /npm run validate:skill/);
  assert.doesNotMatch(publishCommands, /npm ci|npm test|npm run build:cloudflare/);
  assert.match(publishCommands, /test "\$PUBLISH_INTEGRITY" = "\$VERIFIED_INTEGRITY"/);
  assert.match(source, /git merge-base --is-ancestor/);
  assert.match(source, /refs\/tags\/\$\{RELEASE_TAG\}\^\{commit\}/);
  assert.match(source, /npm install --global npm@12\.0\.2/);
  assert.match(source, /test "\$\(node --version\)" = "v22\.22\.3"/);
  assert.match(source, /npm run verify:release -- prepare/);
  const publishStep = publish.steps.find(
    (step) => step.name === "Publish package with npm Trusted Publishing",
  );
  assert.equal(publishStep.if, "steps.release.outputs.should_publish == 'true'");
  assert.match(
    publishStep.run,
    /npm publish --ignore-scripts --access public --provenance --registry=https:\/\/registry\.npmjs\.org/,
  );
  const confirmStep = publish.steps.find((step) => step.name === "Confirm registry release");
  assert.equal(Object.hasOwn(confirmStep, "if"), false);
  assert.match(confirmStep.run, /npm run verify:release -- confirm/);
  assert.doesNotMatch(
    source,
    /NPM_TOKEN|NODE_AUTH_TOKEN|_authToken|secrets\s*(?:\.|\[)/i,
  );
});
