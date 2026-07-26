export const DEFAULT_INCLUDE = [
  "**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}",
  "**/*.{py,pyi}",
  "**/*.{go,rs,java,cs,kt,scala}",
  "**/*.{c,cpp,cc,cxx,h,hpp,hxx}",
  "**/*.{rb,php,inc,swift}",
  "**/*.{cls,trigger}",
  "**/*.{vue,svelte,astro}",
  "**/*.{sql,graphql,proto}",
  "**/*.{yaml,yml,toml}",
  "**/*.{md,mdx}",
  "**/*.{sh,bash,zsh}",
  "**/*.{txt,html,htm}",
  "**/*.zig",
  "**/*.gd",
];

export const DEFAULT_EXCLUDE = [
  "**/node_modules/**",
  "**/.git/**",
  "**/dist/**",
  "**/build/**",
  "**/*build*/**",
  "**/*.min.js",
  "**/*.bundle.js",
  "**/vendor/**",
  "**/__pycache__/**",
  "**/target/**",
  "**/coverage/**",
  "**/.next/**",
  "**/.nuxt/**",
  "**/.opencode/**",
  "**/.*",
  "**/.*/**",
];

export const EMBEDDING_MODELS = {
  "google": {
    // `text-embedding-004` is DEPRECATED - https://ai.google.dev/gemini-api/docs/deprecations
    "text-embedding-005": {
      provider: "google",
      model: "text-embedding-005",
      dimensions: 768,
      maxTokens: 2048,
      costPer1MTokens: 0.025,
      taskAble: false,
      // Note: on reality, this model allows for task-specific embeddings. See: https://docs.cloud.google.com/vertex-ai/generative-ai/docs/embeddings/task-types
    },
    "gemini-embedding-001": {
      provider: "google",
      model: "gemini-embedding-001",
      // Native output is 3072D, but we use Matryoshka truncation via outputDimensionality
      // to reduce to 1536D for better storage/search efficiency with minimal quality loss.
      // Google recommends 768, 1536, or 3072. See: https://ai.google.dev/gemini-api/docs/embeddings
      dimensions: 1536,
      maxTokens: 2048,
      costPer1MTokens: 0.15,
      taskAble: true,
    },
  },
  "openai": {
    "text-embedding-3-small": {
      provider: "openai",
      model: "text-embedding-3-small",
      dimensions: 1536,
      maxTokens: 8191,
      costPer1MTokens: 0.02,
    },
    "text-embedding-3-large": {
      provider: "openai",
      model: "text-embedding-3-large",
      dimensions: 3072,
      maxTokens: 8191,
      costPer1MTokens: 0.13,
    },
  },
  "ollama": {
    "nomic-embed-text": {
      provider: "ollama",
      model: "nomic-embed-text",
      dimensions: 768,
      maxTokens: 2048,
      costPer1MTokens: 0.00,
    },
    "mxbai-embed-large": {
      provider: "ollama",
      model: "mxbai-embed-large",
      dimensions: 1024,
      maxTokens: 512,
      costPer1MTokens: 0.00,
    },
  },
  "github-copilot": {
    "text-embedding-3-small": {
      provider: "github-copilot",
      model: "text-embedding-3-small",
      dimensions: 1536,
      maxTokens: 8191,
      costPer1MTokens: 0.00,
    },
  },
} as const;

export const DEFAULT_PROVIDER_MODELS = {
  "github-copilot": "text-embedding-3-small",
  "openai": "text-embedding-3-small",
  "google": "gemini-embedding-001",
  "ollama": "nomic-embed-text",
} as const;

export const AUTO_DETECT_PROVIDER_ORDER = [
  "ollama",
  "github-copilot",
  "openai",
  "google",
] as const;
