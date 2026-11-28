import kernel from "../kernel/config/kernel/eslint-rules.mjs";
import { rootedFileRules } from "./rooted-file-rules.mjs";
import { testRules } from "./test-rules.mjs";

export default {
  rules: {
    ...rootedFileRules,
    ...testRules,
    ...kernel.rules,
  },
};
