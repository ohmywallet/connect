import { validateConnectPackFiles } from "./artifact-policy.mjs";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { types as utilTypes } from "node:util";

const packageName = "@ohmywallet/connect";
const version = "0.9.2";
const developmentVersion = "0.9.3-dev.0";
function releaseVersion(value) {
  if (value !== version && value !== developmentVersion) throw invalid("public release version");
  return value;
}
const isDevelopment = (manifest) => manifest.version === developmentVersion;
const publicRepository = "https://github.com/ohmywallet/connect";
const publicRepositoryGit = `${publicRepository}.git`;
const publicWorkflow = ".github/workflows/publish.yml";
const provenancePredicate = "https://slsa.dev/provenance/v1";
const workflowBuildType = "https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1";
const runnerBuilder = "https://github.com/actions/runner/github-hosted";
const shaPattern = /^[0-9a-f]{40}$/u;
const digestPattern = /^[0-9a-f]{64}$/u;
const timestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const manifestKeys = Object.freeze([
  "schemaVersion",
  "kind",
  "version",
  "packageName",
  "sourceSha",
  "qualificationSha256",
  "artifactPath",
  "artifactSha256",
  "artifactIntegrity",
  "createdAt",
]);

const authKeys = Object.freeze([
  "NODE_AUTH_TOKEN",
  "NPM_TOKEN",
  "NPM_CONFIG__AUTH",
  "NPM_CONFIG_USERCONFIG",
]);
const publishEnvironmentKeys = Object.freeze([
  "ACTIONS_ID_TOKEN_REQUEST_TOKEN",
  "ACTIONS_ID_TOKEN_REQUEST_URL",
  "CI",
  "GITHUB_ACTION",
  "GITHUB_ACTIONS",
  "GITHUB_ACTOR",
  "GITHUB_API_URL",
  "GITHUB_ENV",
  "GITHUB_EVENT_NAME",
  "GITHUB_EVENT_PATH",
  "GITHUB_JOB",
  "GITHUB_REF",
  "GITHUB_REF_NAME",
  "GITHUB_REPOSITORY",
  "GITHUB_REPOSITORY_ID",
  "GITHUB_REPOSITORY_OWNER_ID",
  "GITHUB_RUN_ATTEMPT",
  "GITHUB_RUN_ID",
  "GITHUB_SERVER_URL",
  "GITHUB_SHA",
  "GITHUB_WORKFLOW_REF",
  "HOME",
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "LANG",
  "NO_PROXY",
  "NPM_CONFIG_CACHE",
  "PATH",
  "RUNNER_ARCH",
  "RUNNER_ENVIRONMENT",
  "RUNNER_OS",
  "RUNNER_TEMP",
  "TMPDIR",
]);

// Diagnostics contain only fixed categories and known public tool codes. Never
// forward a child message, stderr, command, path, or environment to the runner.
const failureDiagnostics = new WeakMap();
const publicToolCodes = new Set([
  "E2BIG",
  "E401",
  "E403",
  "E404",
  "E409",
  "E422",
  "E429",
  "E500",
  "E502",
  "E503",
  "E504",
  "EACCES",
  "EAI_AGAIN",
  "EBADENGINE",
  "ECONNREFUSED",
  "ECONNRESET",
  "EINTEGRITY",
  "EINVALIDPACKAGENAME",
  "EINVALIDTAGNAME",
  "ENEEDAUTH",
  "ENETUNREACH",
  "ENOENT",
  "ENOTFOUND",
  "EOTP",
  "EPERM",
  "EPRIVATE",
  "EPROVENANCE",
  "EPUBLISHCONFLICT",
  "ETIMEDOUT",
  "EUNSCOPED",
  "EUNSUPPORTEDPROTOCOL",
  "EUSAGE",
]);

function publicFailure(category, { stage, code, exitCode } = {}) {
  const error = new Error("Public release command failed.");
  failureDiagnostics.set(error, Object.freeze({ stage, category, code, exitCode }));
  return error;
}

async function atStage(stage, operation) {
  try {
    return await operation();
  } catch (error) {
    const diagnostic = failureDiagnostics.get(error);
    throw publicFailure(diagnostic?.category ?? "unclassified", { ...diagnostic, stage });
  }
}

function commandCode(command, stderr) {
  if (command !== "npm") return undefined;
  const match = /^npm (?:error|ERR!) code (E[A-Z0-9_]+)\r?$/mu.exec(stderr);
  return publicToolCodes.has(match?.[1]) ? match[1] : undefined;
}

function invalid(label) {
  const error = new TypeError(`Invalid ${label}.`);
  failureDiagnostics.set(error, Object.freeze({ category: "invalid-input" }));
  return error;
}

function plainObject(value, label) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    utilTypes.isProxy(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw invalid(label);
  }
  return value;
}

function exactObject(value, keys, label) {
  const object = plainObject(value, label);
  const actual = Reflect.ownKeys(object);
  if (
    actual.length !== keys.length ||
    actual.some((key, index) => typeof key !== "string" || key !== keys[index])
  ) {
    throw invalid(label);
  }
  const descriptors = Object.getOwnPropertyDescriptors(object);
  const normalized = {};
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (
      descriptor === undefined ||
      !Object.hasOwn(descriptor, "value") ||
      descriptor.enumerable !== true
    ) {
      throw invalid(label);
    }
    normalized[key] = descriptor.value;
  }
  return normalized;
}

function exactArray(value, maximum, label) {
  if (
    !Array.isArray(value) ||
    utilTypes.isProxy(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length > maximum
  ) {
    throw invalid(label);
  }
  const keys = Reflect.ownKeys(value);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    keys.length !== value.length + 1 ||
    keys.at(-1) !== "length" ||
    keys.slice(0, -1).some((key, index) => key !== String(index))
  ) {
    throw invalid(label);
  }
  return Array.from({ length: value.length }, (_, index) => {
    const descriptor = descriptors[String(index)];
    if (
      descriptor === undefined ||
      !Object.hasOwn(descriptor, "value") ||
      descriptor.enumerable !== true
    ) {
      throw invalid(label);
    }
    return descriptor.value;
  });
}

function validIntegrity(value) {
  if (typeof value !== "string" || !/^sha512-[A-Za-z0-9+/]+={0,2}$/u.test(value)) {
    return false;
  }
  const encoded = value.slice("sha512-".length);
  const bytes = Buffer.from(encoded, "base64");
  return bytes.byteLength === 64 && bytes.toString("base64") === encoded;
}

function normalizeManifest(value) {
  const label = "public release manifest";
  try {
    const manifest = exactObject(value, manifestKeys, label);
    if (
      manifest.schemaVersion !== 1 ||
      manifest.kind !== "connect-publication" ||
      ![version, developmentVersion].includes(manifest.version) ||
      manifest.packageName !== packageName ||
      typeof manifest.sourceSha !== "string" ||
      !shaPattern.test(manifest.sourceSha) ||
      typeof manifest.qualificationSha256 !== "string" ||
      !digestPattern.test(manifest.qualificationSha256) ||
      manifest.artifactPath !== `release/connect-${manifest.version}.tgz` ||
      typeof manifest.artifactSha256 !== "string" ||
      !digestPattern.test(manifest.artifactSha256) ||
      !validIntegrity(manifest.artifactIntegrity) ||
      typeof manifest.createdAt !== "string" ||
      !timestampPattern.test(manifest.createdAt) ||
      new Date(manifest.createdAt).toISOString() !== manifest.createdAt
    ) {
      throw invalid(label);
    }
    return Object.freeze({ ...manifest });
  } catch {
    throw invalid(label);
  }
}

function parseJson(text, maximum, label) {
  if (typeof text !== "string" || Buffer.byteLength(text) > maximum) throw invalid(label);
  try {
    return JSON.parse(text);
  } catch {
    throw invalid(label);
  }
}

function safeEnvironment(env) {
  const result = {};
  for (const key of publishEnvironmentKeys) {
    const value = env?.[key];
    if (typeof value === "string") result[key] = value;
  }
  return result;
}

export async function runPublicReleaseCommand(command, args, options = {}) {
  const timeoutMs = options.timeoutMs ?? 10 * 60 * 1000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw publicFailure("invalid-input");
  }
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let exceeded = false;
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    const append = (current, chunk, limit) => {
      const next = current + chunk.toString("utf8");
      if (Buffer.byteLength(next) > limit) {
        exceeded = true;
        child.kill("SIGKILL");
        return current;
      }
      return next;
    };
    child.stdout.on("data", (chunk) => {
      stdout = append(stdout, chunk, options.stdoutLimitBytes ?? 256 * 1024);
    });
    child.stderr.on("data", (chunk) => {
      stderr = append(stderr, chunk, options.stderrLimitBytes ?? 128 * 1024);
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(
        publicFailure("command-spawn", {
          code: publicToolCodes.has(error?.code) ? error.code : undefined,
        })
      );
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      if (timedOut || exceeded || code !== 0) {
        reject(
          publicFailure(
            timedOut ? "command-timeout" : exceeded ? "command-output-limit" : "command-exit",
            {
              code: timedOut || exceeded ? undefined : commandCode(command, stderr),
              exitCode:
                !timedOut && !exceeded && Number.isInteger(code) && code >= 0 && code <= 255
                  ? code
                  : undefined,
            }
          )
        );
      } else {
        resolve(Object.freeze({ stdout, stderr, exitCode: code }));
      }
    });
  });
}

function sha512Hex(integrity) {
  return Buffer.from(integrity.slice("sha512-".length), "base64").toString("hex");
}

export function validatePublicWorkflowContext(value, manifestValue) {
  const label = "public workflow context";
  try {
    const context = exactObject(
      value,
      ["eventName", "requestedTag", "ref", "refName", "head", "main", "tag"],
      label
    );
    const manifest = normalizeManifest(manifestValue);
    const expectedTag = `v${manifest.version}`;
    if (
      (context.eventName !== "push" && context.eventName !== "workflow_dispatch") ||
      context.requestedTag !== expectedTag ||
      context.refName !== expectedTag ||
      context.ref !== `refs/tags/${expectedTag}` ||
      typeof context.head !== "string" ||
      !shaPattern.test(context.head) ||
      context.main !== context.head ||
      context.tag !== context.head
    ) {
      throw invalid(label);
    }
    return Object.freeze({ tag: expectedTag, commit: context.head });
  } catch {
    throw invalid(label);
  }
}

function decodeStatement(attestation, label) {
  const bundle = plainObject(attestation.bundle, label);
  const envelope = plainObject(bundle.dsseEnvelope, label);
  if (
    envelope.payloadType !== "application/vnd.in-toto+json" ||
    typeof envelope.payload !== "string" ||
    envelope.payload.length > 512 * 1024
  ) {
    throw invalid(label);
  }
  const bytes = Buffer.from(envelope.payload, "base64");
  if (bytes.byteLength === 0 || bytes.toString("base64") !== envelope.payload) {
    throw invalid(label);
  }
  return parseJson(bytes.toString("utf8"), 256 * 1024, label);
}

export function normalizeProvenanceAttestations(value, { manifest: input, commit }) {
  const label = "provenance attestations";
  try {
    const manifest = normalizeManifest(input);
    if (typeof commit !== "string" || !shaPattern.test(commit)) throw invalid(label);
    const root = plainObject(value, label);
    if (Reflect.ownKeys(root).length !== 1 || !Object.hasOwn(root, "attestations")) {
      throw invalid(label);
    }
    const list = exactArray(root.attestations, 4, label);
    const matching = list.filter((entry) => {
      const object = plainObject(entry, label);
      return object.predicateType === provenancePredicate;
    });
    if (matching.length !== 1) throw invalid(label);
    const statement = plainObject(decodeStatement(matching[0], label), label);
    const subjects = exactArray(statement.subject, 4, label);
    const subject = subjects.find(
      (entry) =>
        plainObject(entry, label).name === `pkg:npm/%40ohmywallet/connect@${manifest.version}`
    );
    if (subject === undefined || subjects.length !== 1) throw invalid(label);
    const subjectDigest = plainObject(subject.digest, label);
    const predicate = plainObject(statement.predicate, label);
    const definition = plainObject(predicate.buildDefinition, label);
    const parameters = plainObject(definition.externalParameters, label);
    const workflow = plainObject(parameters.workflow, label);
    const dependencies = exactArray(definition.resolvedDependencies, 16, label);
    const dependency = dependencies.find((entry) => {
      const object = plainObject(entry, label);
      return object.uri === `git+${publicRepository}@refs/tags/v${manifest.version}`;
    });
    const dependencyDigest = plainObject(dependency?.digest, label);
    const details = plainObject(predicate.runDetails, label);
    const builder = plainObject(details.builder, label);
    if (
      statement._type !== "https://in-toto.io/Statement/v1" ||
      statement.predicateType !== provenancePredicate ||
      subjectDigest.sha512 !== sha512Hex(manifest.artifactIntegrity) ||
      definition.buildType !== workflowBuildType ||
      workflow.repository !== publicRepository ||
      workflow.path !== publicWorkflow ||
      workflow.ref !== `refs/tags/v${manifest.version}` ||
      dependencyDigest.gitCommit !== commit ||
      builder.id !== runnerBuilder
    ) {
      throw invalid(label);
    }
    return Object.freeze({
      repository: publicRepository,
      workflow: publicWorkflow,
      ref: workflow.ref,
      commit,
    });
  } catch {
    throw invalid(label);
  }
}

export function createDefaultPublicPublisherOperations({
  root,
  env = process.env,
  run = runPublicReleaseCommand,
  fetchImpl = globalThis.fetch,
  homeDirectory = os.homedir(),
}) {
  const repositoryRoot = path.resolve(root);
  const npmEnvironment = safeEnvironment(env);

  async function readText(file, maximum, label) {
    const stats = await lstat(file);
    if (!stats.isFile() || stats.isSymbolicLink() || stats.size > maximum) {
      throw invalid(label);
    }
    return readFile(file, "utf8");
  }

  return {
    async readRelease() {
      const selectedVersion =
        env.CONNECT_RELEASE_TAG === `v${developmentVersion}` ? developmentVersion : version;
      const manifestPath = path.join(repositoryRoot, `release/connect-${selectedVersion}.json`);
      const text = await readText(manifestPath, 64 * 1024, "public release manifest");
      const manifest = normalizeManifest(parseJson(text, 64 * 1024, "public release manifest"));
      if (manifest.version !== selectedVersion) throw invalid("public release manifest version");
      if (`${JSON.stringify(manifest, null, 2)}\n` !== text) {
        throw invalid("public release manifest");
      }
      const artifactPath = path.resolve(repositoryRoot, manifest.artifactPath);
      if (path.relative(repositoryRoot, artifactPath) !== manifest.artifactPath) {
        throw invalid("public release artifact path");
      }
      const stats = await lstat(artifactPath);
      if (
        !stats.isFile() ||
        stats.isSymbolicLink() ||
        stats.size <= 0 ||
        stats.size > 2 * 1024 * 1024
      ) {
        throw invalid("public release artifact");
      }
      return Object.freeze({ manifest, manifestPath, artifactPath });
    },

    async assertNoAuth() {
      for (const key of authKeys) {
        if (typeof env?.[key] === "string" && env[key].length > 0) throw invalid("npm auth");
      }
      for (const file of [
        path.join(repositoryRoot, ".npmrc"),
        path.join(homeDirectory, ".npmrc"),
      ]) {
        let text;
        try {
          text = await readFile(file, "utf8");
        } catch (error) {
          if (error?.code === "ENOENT") continue;
          throw invalid("npm auth");
        }
        if (/(?:_authToken|_auth|username|password)\s*=/iu.test(text)) {
          throw invalid("npm auth");
        }
      }
    },

    async readWorkflowContext() {
      const requestedTag = env.CONNECT_RELEASE_TAG;
      if (requestedTag !== `v${version}` && requestedTag !== `v${developmentVersion}`)
        throw invalid("public workflow tag");
      const tagResult = await run("git", ["rev-parse", `refs/tags/${requestedTag}^{commit}`], {
        cwd: repositoryRoot,
        env: npmEnvironment,
      });
      const mainResult = await run("git", ["rev-parse", "refs/remotes/origin/main^{commit}"], {
        cwd: repositoryRoot,
        env: npmEnvironment,
      });
      const headResult = await run("git", ["rev-parse", "HEAD"], {
        cwd: repositoryRoot,
        env: npmEnvironment,
      });
      return {
        eventName: env.GITHUB_EVENT_NAME,
        requestedTag,
        ref: env.GITHUB_REF,
        refName: requestedTag,
        head: headResult.stdout.trim(),
        main: mainResult.stdout.trim(),
        tag: tagResult.stdout.trim(),
      };
    },

    async verifyPayload({ manifest, artifactPath }) {
      const artifactBytes = await readFile(artifactPath);
      if (
        createHash("sha256").update(artifactBytes).digest("hex") !== manifest.artifactSha256 ||
        `sha512-${createHash("sha512").update(artifactBytes).digest("base64")}` !==
          manifest.artifactIntegrity
      ) {
        throw invalid("committed public release artifact");
      }
      const entries = await run("tar", ["-tzf", artifactPath], {
        cwd: repositoryRoot,
        env: npmEnvironment,
      });
      const files = entries.stdout
        .split(/\r?\n/u)
        .filter((entry) => entry.length > 0 && !entry.endsWith("/"));
      try {
        validateConnectPackFiles(files, { prefix: "package/", ordered: false });
      } catch {
        throw invalid("committed public release artifact entries");
      }
      const metadataResult = await run("tar", ["-xOf", artifactPath, "package/package.json"], {
        cwd: repositoryRoot,
        env: npmEnvironment,
      });
      const metadata = parseJson(metadataResult.stdout, 64 * 1024, "public release package");
      if (
        metadata?.name !== packageName ||
        metadata?.version !== manifest.version ||
        metadata?.repository?.type !== "git" ||
        metadata?.repository?.url !== publicRepositoryGit ||
        Reflect.ownKeys(metadata.repository).length !== 2
      ) {
        throw invalid("public release package");
      }
    },

    async readRegistryPublication({ manifest }) {
      const response = await fetchImpl(
        `https://registry.npmjs.org/%40ohmywallet%2Fconnect/${manifest.version}`,
        {
          headers: { accept: "application/json" },
          redirect: "error",
          signal: AbortSignal.timeout(30_000),
        }
      );
      if (response.status === 404) return null;
      if (!response.ok) throw new Error("Anonymous npm registry check failed.");
      const metadata = plainObject(
        parseJson(await response.text(), 1024 * 1024, "npm registry publication"),
        "npm registry publication"
      );
      const dist = plainObject(metadata.dist, "npm registry publication");
      const attestations = plainObject(dist.attestations, "npm registry publication");
      if (
        metadata.name !== packageName ||
        metadata.version !== manifest.version ||
        !validIntegrity(dist.integrity) ||
        typeof attestations.url !== "string" ||
        attestations.url !==
          `https://registry.npmjs.org/-/npm/v1/attestations/@ohmywallet%2fconnect@${manifest.version}` ||
        attestations.provenance?.predicateType !== provenancePredicate
      ) {
        throw invalid("npm registry publication");
      }
      return Object.freeze({ integrity: dist.integrity, attestationsUrl: attestations.url });
    },

    async readStableLatest() {
      const response = await fetchImpl(
        "https://registry.npmjs.org/-/package/@ohmywallet%2fconnect/dist-tags",
        {
          headers: { accept: "application/json" },
          redirect: "error",
          signal: AbortSignal.timeout(30_000),
        }
      );
      if (!response.ok) throw invalid("npm stable dist-tag observation");
      const tags = plainObject(
        parseJson(await response.text(), 64 * 1024, "npm dist-tags"),
        "npm dist-tags"
      );
      if (tags.latest !== version) throw invalid("npm stable dist-tag observation");
      return version;
    },

    async publishNpm({ artifactPath, manifest = { version } }) {
      const selected = releaseVersion(manifest.version);
      await run(
        "npm",
        [
          "publish",
          artifactPath,
          "--access",
          "public",
          "--provenance",
          ...(selected === developmentVersion ? ["--tag", "development"] : []),
        ],
        {
          cwd: repositoryRoot,
          env: npmEnvironment,
          stdoutLimitBytes: 256 * 1024,
          stderrLimitBytes: 128 * 1024,
        }
      );
    },

    async verifyExistingPublication({ manifest, publication, context }) {
      if (publication.integrity !== manifest.artifactIntegrity) {
        throw invalid("existing npm publication integrity");
      }
      const response = await fetchImpl(publication.attestationsUrl, {
        headers: { accept: "application/json" },
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) throw new Error("npm provenance observation failed.");
      normalizeProvenanceAttestations(
        parseJson(await response.text(), 2 * 1024 * 1024, "provenance attestations"),
        { manifest, commit: context.commit }
      );

      const auditRoot = await mkdtemp(path.join(os.tmpdir(), "connect-public-audit-"));
      try {
        await writeFile(
          path.join(auditRoot, "package.json"),
          `${JSON.stringify({ private: true, dependencies: { [packageName]: manifest.version } })}\n`,
          { encoding: "utf8", mode: 0o600 }
        );
        await run(
          "npm",
          [
            "install",
            "--ignore-scripts",
            "--package-lock=true",
            "--save-exact",
            "--audit=false",
            "--fund=false",
          ],
          { cwd: auditRoot, env: npmEnvironment }
        );
        await run("npm", ["audit", "signatures"], { cwd: auditRoot, env: npmEnvironment });
      } finally {
        await rm(auditRoot, { recursive: true, force: true });
      }
    },
  };
}

export async function publishCommittedRelease({
  root,
  operations = createDefaultPublicPublisherOperations({ root }),
}) {
  const release = await atStage("read-release", () => operations.readRelease());
  await atStage("auth-check", () => operations.assertNoAuth());
  const context = await atStage("workflow-context", async () =>
    validatePublicWorkflowContext(
      await operations.readWorkflowContext({ manifest: release.manifest }),
      release.manifest
    )
  );
  await atStage("payload-check", () => operations.verifyPayload({ ...release, context }));
  const stableLatest = isDevelopment(release.manifest)
    ? await atStage("stable-tag-before", () => operations.readStableLatest())
    : undefined;
  if (isDevelopment(release.manifest) && stableLatest !== version) throw invalid("stable dist-tag");
  const publication = await atStage("registry-check", () =>
    operations.readRegistryPublication({ manifest: release.manifest, context })
  );
  if (publication === null) {
    await atStage("npm-publish", () => operations.publishNpm({ ...release, context }));
    if (
      isDevelopment(release.manifest) &&
      (await atStage("stable-tag-after", () => operations.readStableLatest())) !== stableLatest
    )
      throw invalid("stable dist-tag changed");
    return Object.freeze({
      status: "published",
      version: release.manifest.version,
      commit: context.commit,
    });
  }
  await atStage("existing-publication-check", () =>
    operations.verifyExistingPublication({ ...release, publication, context })
  );
  if (
    isDevelopment(release.manifest) &&
    (await atStage("stable-tag-after", () => operations.readStableLatest())) !== stableLatest
  )
    throw invalid("stable dist-tag changed");
  return Object.freeze({
    status: "already-published",
    version: release.manifest.version,
    commit: context.commit,
  });
}

export async function runPublicReleaseMain({
  root = process.cwd(),
  operations,
  stdout = process.stdout,
  stderr = process.stderr,
} = {}) {
  try {
    const result = await publishCommittedRelease({ root, operations });
    stdout.write(`${JSON.stringify(result)}\n`);
    return 0;
  } catch (error) {
    const diagnostic = failureDiagnostics.get(error);
    const fields = [
      `stage=${diagnostic?.stage ?? "unknown"}`,
      `category=${diagnostic?.category ?? "unclassified"}`,
    ];
    if (diagnostic?.code !== undefined) fields.push(`code=${diagnostic.code}`);
    if (diagnostic?.exitCode !== undefined) fields.push(`exitCode=${diagnostic.exitCode}`);
    stderr.write(`Connect public publication failed. ${fields.join(" ")}\n`);
    return 1;
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  process.exitCode = await runPublicReleaseMain();
}
