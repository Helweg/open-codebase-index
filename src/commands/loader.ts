import { existsSync, readdirSync, readFileSync } from "fs";
import * as path from "path";

export interface CommandDefinition {
  description: string;
  template: string;
}

function parseFrontmatter(content: string): { frontmatter: Record<string, string>; body: string } {
  const frontmatterRegex = /^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/;
  const match = content.match(frontmatterRegex);
  
  if (!match) {
    return { frontmatter: {}, body: content.trim() };
  }

  const frontmatterLines = match[1].split("\n");
  const frontmatter: Record<string, string> = {};
  
  for (const line of frontmatterLines) {
    const colonIndex = line.indexOf(":");
    if (colonIndex > 0) {
      const key = line.slice(0, colonIndex).trim();
      const value = line.slice(colonIndex + 1).trim();
      frontmatter[key] = value;
    }
  }

  return { frontmatter, body: match[2].trim() };
}

export function loadCommandsFromDirectory(commandsDir: string): Map<string, CommandDefinition> {
  const commands = new Map<string, CommandDefinition>();

  if (!existsSync(commandsDir)) {
    return commands;
  }

  const files = readdirSync(commandsDir).filter((f) => f.endsWith(".md"));

  for (const file of files) {
    const filePath = path.join(commandsDir, file);
    let content: string;

    try {
      content = readFileSync(filePath, "utf-8");
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to load command file ${filePath}: ${message}`, { cause: error });
    }

    const { frontmatter, body } = parseFrontmatter(content);
    
    const name = path.basename(file, ".md");
    const description = frontmatter.description || `Run the ${name} command`;

    commands.set(name, {
      description,
      template: body,
    });
  }

  return commands;
}
