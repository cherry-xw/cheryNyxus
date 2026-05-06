import { tool } from "@langchain/core/tools";
import { z } from "zod";

export const read = tool(
  ({ path }: { path: string }) => {
    return { path, txt: "hello world" };
  },
  {
    name: "read",
    description: "read a file",
    schema: z.object({
      path: z.string().describe("path to the file to read"),
    }),
  },
);
