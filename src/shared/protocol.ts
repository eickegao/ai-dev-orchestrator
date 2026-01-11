import { z } from "zod";

export const PlanStepSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("cmd"),
    command: z.string()
  }),
  z.object({
    type: z.literal("note"),
    message: z.string()
  }),
  z.object({
    type: z.literal("executor"),
    tool: z.enum(["codex", "claude_code"]),
    instructions: z.string()
  })
]);

export const TaskPlanSchema = z.object({
  plan_name: z.string(),
  steps: z.array(PlanStepSchema)
});

export type PlanStep = z.infer<typeof PlanStepSchema>;
export type TaskPlan = z.infer<typeof TaskPlanSchema>;
