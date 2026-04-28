import type { Plugin } from "@opencode-ai/plugin";
import { createTools } from "./tools.js";

const OpenTasksPlugin: Plugin = async (ctx) => {
  return {
    tool: createTools(ctx),
  };
};

export default OpenTasksPlugin;
