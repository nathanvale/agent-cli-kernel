import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { ESLint } from "eslint";

export const root = resolve(import.meta.dir, "../..");
const eslint = new ESLint({ cwd: root });

export async function messages(filePath: string, code: string) {
  const [result] = await eslint.lintText(code, { filePath });
  return (result?.messages ?? []).map(({ ruleId, line, message }) => ({
    ruleId,
    line,
    message,
  }));
}

export const kernelPath = /^(kernel|tests\/kernel)\//;

export async function ruleOn(rule: string, filePath: string): Promise<boolean> {
  const config = (await eslint.calculateConfigForFile(filePath)) as
    | { rules?: Record<string, unknown> }
    | undefined;
  const setting = config?.rules?.[rule];
  const severity: unknown = Array.isArray(setting) ? setting[0] : setting;
  return severity !== undefined && severity !== 0 && severity !== "off";
}

export async function hits(rule: string, filePath: string, code: string) {
  if (kernelPath.test(filePath) || !existsSync(resolve(root, filePath)))
    throw new Error(`${filePath} is not a template file.`);
  if (!(await ruleOn(`repository/${rule}`, filePath)))
    throw new Error(`repository/${rule} is off for ${filePath}.`);
  return (await messages(filePath, code))
    .filter((message) => message.ruleId === `repository/${rule}`)
    .map(({ line, message }) => ({ line, message }));
}
