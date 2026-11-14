import { z } from "zod";

export const SetInput = z.strictObject({
  preview: z.boolean(),
  value: z.string().trim().min(1).max(128),
});

export const StateDocument = z.strictObject({
  value: z.string(),
});
