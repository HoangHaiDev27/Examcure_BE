import { spawnSync } from "node:child_process";

export function requireIntegrationEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value || value.includes("YOUR_") || value.includes("USER:PASSWORD")) {
    throw new Error(`Missing integration environment variable: ${name}`);
  }
  return value;
}

function commandAvailable(name: string, fallback: string, args: string[]): boolean {
  const command = process.env[name]?.trim() || fallback;
  if (!command || command.includes("YOUR_")) return false;
  const result = spawnSync(command, args, {
    stdio: "ignore",
    windowsHide: true,
    timeout: 3000,
  });
  return !result.error;
}

export function integrationStatus() {
  const configured = (name: string) => {
    const value = process.env[name]?.trim();
    return Boolean(value && !value.includes("YOUR_") && !value.includes("USER:PASSWORD"));
  };
  return {
    supabase: configured("SUPABASE_URL") && configured("SUPABASE_SERVICE_ROLE_KEY"),
    mongodb: configured("MONGODB_URI"),
    openai:
      configured("OPENAI_API_KEY") &&
      configured("OPENAI_EMBEDDING_MODEL") &&
      configured("OPENAI_QUESTION_MODEL"),
    converter:
      commandAvailable("LIBREOFFICE_BIN", "soffice", ["--version"]) &&
      commandAvailable("PDFTOPPM_BIN", "pdftoppm", ["-v"]) &&
      commandAvailable("PDFTOTEXT_BIN", "pdftotext", ["-v"]),
    pptxTextExtraction: true,
  };
}
