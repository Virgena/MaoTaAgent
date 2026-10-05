export const DEFAULT_SESSION = "cli";

export interface Launch {
  config?: string | undefined;
  kernel?: string | undefined;
  profile?: string | undefined;
  session: string;
}

export type Parsed =
  | { kind: "help" }
  | { kind: "version" }
  | ({ kind: "serve" } & Launch)
  | ({ kind: "check"; json: boolean } & Launch)
  | ({ kind: "jobs"; action: string; args: string[] } & Launch)
  | ({ kind: "cron"; action: string; args: string[] } & Launch)
  | ({ kind: "plugin"; action: string; args: string[] } & Launch)
  | ({ kind: "once"; question: string } & Launch)
  | ({ kind: "repl" } & Launch)
  | { kind: "usage"; message: string };

export function parseArgs(argv: string[]): Parsed {
  let config: string | undefined;
  let kernel: string | undefined;
  let profile: string | undefined;
  let session = DEFAULT_SESSION;
  let json = false;
  let help = false;
  let version = false;
  let subcommand: "serve" | "check" | "jobs" | "cron" | "plugin" | null = null;
  const words: string[] = [];

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]!;
    if (token === "--help" || token === "-h") {
      help = true;
      continue;
    }
    if (token === "--version" || token === "-v") {
      version = true;
      continue;
    }
    if (token === "--json") {
      json = true;
      continue;
    }
    if (token === "--config" || token === "--kernel" || token === "--profile" || token === "--session") {
      const value = argv[i + 1];
      if (value === undefined) return { kind: "usage", message: `option ${token} needs a value` };
      i += 1;
      if (token === "--config") config = value;
      else if (token === "--kernel") kernel = value;
      else if (token === "--profile") profile = value;
      else session = value;
      continue;
    }
    if (subcommand === "plugin") {
      words.push(token);
      continue;
    }
    if (token.startsWith("-") && token !== "-") return { kind: "usage", message: `unknown option: ${token}` };
    if (subcommand === "serve" || subcommand === "check") {
      return { kind: "usage", message: `${subcommand} takes no further arguments: ${token}` };
    }
    if (words.length === 0 && (token === "serve" || token === "check" || token === "jobs" || token === "cron" || token === "plugin")) {
      subcommand = token;
      continue;
    }
    words.push(token);
  }

  if (help) return { kind: "help" };
  if (version) return { kind: "version" };
  const launch: Launch = { config, kernel, profile, session };
  if (subcommand === "serve") return { kind: "serve", ...launch };
  if (subcommand === "check") return { kind: "check", json, ...launch };
  if (subcommand === "jobs") return { kind: "jobs", action: words[0] ?? "", args: words.slice(1), ...launch };
  if (subcommand === "cron") return { kind: "cron", action: words[0] ?? "", args: words.slice(1), ...launch };
  if (subcommand === "plugin") return { kind: "plugin", action: words[0] ?? "", args: words.slice(1), ...launch };
  const question = words.join(" ");
  return question === "" ? { kind: "repl", ...launch } : { kind: "once", question, ...launch };
}