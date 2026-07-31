import { parseArgs } from "node:util";
import { Workspace } from "../../core/workspace/workspace.js";
import { emit, pad } from "../output.js";

/**
 * `env` with no argument lists what is declared; `env <name>` resolves one.
 *
 * The split is deliberate. Resolving an environment reads its secrets, so
 * listing must not do it — a missing `PROD_TOKEN` in the shell should not stop
 * you seeing that a `prod` environment exists.
 */

const HELP = `Usage:
  api-pilot env [name] [options]

Lists declared environments, or resolves one and shows its configuration.

Options:
      --dir <path>   directory to search upward from (default: cwd)
      --json         machine-readable output
  -h, --help         show this help

Secret values are never printed. A variable resolved from a \`\${env:...}\` or
\`\${file:...}\` reference is shown as [redacted].
`;

export async function env(argv: readonly string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: [...argv],
    options: {
      dir: { type: "string" },
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    allowPositionals: true,
  });

  if (values.help === true) {
    emit(false, undefined, () => HELP);
    return;
  }

  const workspace = await Workspace.find(values.dir);
  const name = positionals[0];

  if (name === undefined) {
    listEnvironments(workspace, values.json === true);
    return;
  }

  await showEnvironment(workspace, name, values.json === true);
}

function listEnvironments(workspace: Workspace, asJson: boolean): void {
  const defaultName = workspace.defaultEnvironmentName;
  const names = workspace.environmentNames;

  emit(
    asJson,
    {
      root: workspace.root,
      default: defaultName,
      environments: names,
      specs: workspace.specPaths,
      warnings: workspace.warnings,
    },
    () => {
      const lines = names.map((n) => `${n === defaultName ? "* " : "  "}${n}`);
      return [
        `workspace: ${workspace.root}`,
        "",
        ...(lines.length > 0 ? lines : ["  (no environments declared)"]),
        ...renderWarnings(workspace.warnings),
      ].join("\n");
    },
  );
}

async function showEnvironment(workspace: Workspace, name: string, asJson: boolean): Promise<void> {
  const { environment, redactor } = await workspace.resolveEnvironment(name);
  const secrets = new Set(environment.secretNames);

  // Masked by name *and* passed through the redactor: the first covers a
  // secret's own value, the second covers a plain variable that happens to
  // have been built out of one.
  const variables = [...environment.variables].map(([key, value]) => ({
    name: key,
    value: secrets.has(key) ? "[redacted]" : redactor.redact(value),
    secret: secrets.has(key),
  }));

  emit(
    asJson,
    {
      name: environment.name,
      classification: environment.classification,
      baseUrl: environment.baseUrl,
      allowedHosts: environment.allowedHosts,
      auth: environment.auth === undefined ? null : { type: environment.auth.type },
      variables,
      warnings: workspace.warnings,
    },
    () => {
      const width = Math.max(0, ...variables.map((v) => v.name.length)) + 2;
      return [
        `name:           ${environment.name}`,
        `classification: ${environment.classification}`,
        `baseUrl:        ${environment.baseUrl ?? "(none)"}`,
        `allowedHosts:   ${environment.allowedHosts.join(", ") || "(none — every request is refused)"}`,
        `auth:           ${environment.auth?.type ?? "(none)"}`,
        "",
        "variables:",
        ...(variables.length > 0
          ? variables.map((v) => `  ${pad(v.name, width)}${v.value}`)
          : ["  (none)"]),
        ...renderWarnings(workspace.warnings),
      ].join("\n");
    },
  );
}

function renderWarnings(warnings: readonly string[]): string[] {
  return warnings.length === 0 ? [] : ["", "warnings:", ...warnings.map((w) => `  ${w}`)];
}
