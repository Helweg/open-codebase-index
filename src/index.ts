import { v2Definition } from "./adapters/opencode-v2.js";
import v1Plugin from "./adapters/opencode.js";

export default {
  ...v2Definition,
  server: v1Plugin,
};
