import {
  command,
  contractFor,
  runProcess,
} from "../../../../kernel/src/kernel/index.ts";
import { programsAddon } from "../../../../kernel/src/addons/programs/index.ts";
import { emptyInput, unchanged } from "../../kernel-repair/shapes.ts";

const bounds = {
  timeoutMilliseconds: 3_000,
  outputLimitBytes: 1024,
  shutdownMilliseconds: 200,
} as const;

const feed = command({
  identity: "pi.feed",
  route: ["feed"],
  summary: "Feed one program its input.",
  input: emptyInput,
  capabilities: { programs: true },
  run: async (_input, context) => {
    const result = await context.programs.inspect({
      executable: cli.boundary.path("/bin/cat"),
      args: [],
      input: new TextEncoder().encode("from-command\n"),
      ...bounds,
    });
    return context.result(
      { commandIdentity: "pi.feed", causeCode: "SUCCESS_UNCHANGED" },
      {
        message: "The program read its input.",
        data: { stdout: result.stdout, exitCode: result.exitCode },
        effects: unchanged,
      },
    );
  },
});

const drain = command({
  identity: "pi.drain",
  route: ["drain"],
  summary: "Run one program with no input.",
  input: emptyInput,
  capabilities: { programs: true },
  run: async (_input, context) => {
    const result = await context.programs.inspect({
      executable: cli.boundary.path("/bin/sh"),
      args: ["-c", '/bin/cat | /usr/bin/wc -c | /usr/bin/tr -d " \\n"'],
      ...bounds,
    });
    return context.result(
      { commandIdentity: "pi.drain", causeCode: "SUCCESS_UNCHANGED" },
      {
        message: "The program read nothing.",
        data: { stdout: result.stdout, exitCode: result.exitCode },
        effects: unchanged,
      },
    );
  },
});

const cli = contractFor({
  cli: "pi",
  commands: [feed, drain],
  installedAddons: ["programs"],
});

await runProcess(cli, { addons: { programs: programsAddon() } })(
  process.argv.slice(2),
);
