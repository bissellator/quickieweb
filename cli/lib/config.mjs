// Loading this installation's config.json.
//
// Every script under cli/ and infra/ needs it, and a fresh clone does not have
// one: config.json is gitignored, because it carries bucket names, distribution
// and hosted-zone ids and an ACM ARN containing the AWS account number.
//
// Without this, the first command somebody runs after cloning fails with a raw
// ENOENT stack trace out of node:internal/fs/promises, which tells them nothing
// about what to do. Somebody's first two minutes with a project are not the
// place to make them read a stack trace.

import { readFile, access } from "node:fs/promises";
import path from "node:path";

export const CONFIG_NAME = "config.json";
export const EXAMPLE_NAME = "config.example.json";

export class ConfigError extends Error {
  constructor(message) { super(message); this.name = "ConfigError"; }
}

/**
 * @param root  the repository root
 * @returns the parsed config
 * @throws ConfigError with something a person can act on
 */
export async function loadConfig(root) {
  const at = path.join(root, CONFIG_NAME);
  const example = path.join(root, EXAMPLE_NAME);

  let raw;
  try {
    raw = await readFile(at, "utf8");
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
    const haveExample = await access(example).then(() => true, () => false);
    throw new ConfigError(
      `No ${CONFIG_NAME} in ${root}.\n\n` +
      (haveExample
        ? `  cp ${EXAMPLE_NAME} ${CONFIG_NAME}\n\n` +
          `  Then fill it in. It is gitignored on purpose: it carries your bucket\n` +
          `  names, distribution and hosted-zone ids, and a certificate ARN that\n` +
          `  contains your AWS account number.`
        : `  ${EXAMPLE_NAME} is missing too. Re-clone, or write a ${CONFIG_NAME}\n` +
          `  by hand -- see the README.`));
  }

  try {
    return JSON.parse(raw);
  } catch (err) {
    // A syntax error here stops every script, so say where rather than making
    // somebody bisect a JSON file by hand.
    throw new ConfigError(`${CONFIG_NAME} is not valid JSON: ${err.message}`);
  }
}

/**
 * Wrap a script's body so a ConfigError prints its message and exits, while any
 * other failure keeps its stack -- an unexpected error should still be loud.
 */
export function reportConfigError(err) {
  if (err instanceof ConfigError) {
    console.error(`FATAL: ${err.message}`);
    process.exit(1);
  }
  throw err;
}
