import { createAgent, tool } from "langchain";
import * as z from "zod";

const add = tool(({ x, y }: { x: number; y: number }) => x + y, {
  name: "add",
  description: "Adds two numbers together",
  schema: z.object({
    x: z.number().describe("The first number to add"),
    y: z.number().describe("The second number to add"),
  }),
});

