import * as os from "node:os";
import * as path from "node:path";
import * as module from "node:module";
import { fileURLToPath } from "node:url";

function getNativeBinding() {
  const platform = os.platform();
  const arch = os.arch();

  let bindingName: string;

  if (platform === "darwin" && arch === "arm64") {
    bindingName = "codebase-index-native.darwin-arm64.node";
  } else if (platform === "darwin" && arch === "x64") {
    bindingName = "codebase-index-native.darwin-x64.node";
  } else if (platform === "linux" && arch === "x64") {
    bindingName = "codebase-index-native.linux-x64-gnu.node";
  } else if (platform === "linux" && arch === "arm64") {
    bindingName = "codebase-index-native.linux-arm64-gnu.node";
  } else if (platform === "win32" && arch === "x64") {
    bindingName = "codebase-index-native.win32-x64-msvc.node";
  } else {
    throw new Error(`Unsupported platform: ${platform}-${arch}`);
  }

  // Determine the current directory - handle ESM, CJS, and bundled contexts
  let currentDir: string;
  let requireTarget: string;

  // Check for ESM context with valid import.meta.url
  if (typeof import.meta !== "undefined" && import.meta.url) {
    currentDir = path.dirname(fileURLToPath(import.meta.url));
    requireTarget = import.meta.url;
  }
  // Fallback to __dirname for CJS/bundled contexts
  else if (typeof __dirname !== "undefined") {
    currentDir = __dirname;
    requireTarget = __filename;
  }
  // Last resort: use process.cwd() - shouldn't normally hit this
  else {
    currentDir = process.cwd();
    requireTarget = path.join(currentDir, "index.js");
  }

  // The native module is in the 'native' folder at package root
  // From dist/index.js, we go up one level to package root, then into native/
  // From src/native/index.ts (dev/test), we go up two levels to package root
  const normalizedDir = currentDir.replace(/\\/g, "/");
  const isDevMode = normalizedDir.includes("/src/native") || currentDir.includes(path.join("src", "native"));
  const packageRoot = isDevMode
    ? path.resolve(currentDir, "../..")
    : path.resolve(currentDir, "..");
  const nativePath = path.join(packageRoot, "native", bindingName);

  // Load the native module - use standard require for .node files
  const require = module.createRequire(requireTarget);
  return require(nativePath);
}

function createMockNativeBinding() {
  const error = new Error("Native module not available. Please rebuild with 'npm run build:native'.");

  return {
    parseFile: () => {
      throw error;
    },
    parseFiles: () => {
      throw error;
    },
    hashContent: () => {
      throw error;
    },
    hashFile: () => {
      throw error;
    },
    extractCalls: () => {
      throw error;
    },
    VectorStore: class {
      constructor() {
        throw error;
      }
    },
    InvertedIndex: class {
      constructor() {
        throw error;
      }
      serialize() {
        throw error;
      }
      deserialize() {
        throw error;
      }
    },
    Database: class {
      constructor() {
        throw error;
      }
      static openReadOnly() {
        throw error;
      }
      static createEmptyReadOnly() {
        throw error;
      }
      close() {
        throw error;
      }
      getTransitiveReachability() {
        throw error;
      }
      detectCommunities() {
        throw error;
      }
      computeCentrality() {
        throw error;
      }
    },
  };
}

let native: any;
try {
  native = getNativeBinding();
} catch (e) {
  console.error("[codebase-index] Failed to load native module:", e);
  native = createMockNativeBinding();
}

export { native };
