// Shim for node:os — only EOL is used by the agents package.
// Avoids the bare node:os import that fails Cloudflare upload validation.
export const EOL = "\n";
