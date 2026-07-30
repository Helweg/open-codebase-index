import identityCatalogJson from "./identity-catalog.json";

export interface ProductIdentity {
  productName: string;
  packageName: string;
  repository: string;
  mcpBinary: string;
  mcpServerName: string;
}

export interface ProductIdentityCollection {
  current: ProductIdentity;
  future: ProductIdentity;
}

export interface NativeIdentity {
  binaryName: string;
}

export interface IdentityCatalog {
  product: ProductIdentityCollection;
  native: NativeIdentity;
}

export const IDENTITY_CATALOG = identityCatalogJson as IdentityCatalog;

export const CURRENT_PRODUCT = IDENTITY_CATALOG.product.current;
export const FUTURE_PRODUCT = IDENTITY_CATALOG.product.future;

export const MCP_SERVER_CURRENT_NAME = CURRENT_PRODUCT.mcpServerName;
export const MCP_BINARY_CURRENT_NAME = CURRENT_PRODUCT.mcpBinary;
export const STABLE_NATIVE_BINARY_NAME = IDENTITY_CATALOG.native.binaryName;
