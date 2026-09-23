import * as vscode from 'vscode';

export interface LoadedCommand {
  name: string;
  description?: string;
  body: string;
}

const COMMANDS_RELATIVE_DIR = '.localagent/commands';

/** Parses simple `description: ...` frontmatter delimited by --- lines, if present. */
function parseFrontmatter(raw: string): { description?: string; body: string } {
  if (!raw.startsWith('---')) {
    return { body: raw };
  }
  const end = raw.indexOf('\n---', 3);
  if (end === -1) {
    return { body: raw };
  }
  const fm = raw.slice(3, end).trim();
  const body = raw.slice(end + 4).replace(/^\r?\n/, '');
  const match = fm.match(/description:\s*(.+)/i);
  return { description: match?.[1]?.trim(), body };
}

/** Loads every .md file under .localagent/commands/ as a slash command, keyed by filename (without extension). */
export async function loadCommands(): Promise<Map<string, LoadedCommand>> {
  const commands = new Map<string, LoadedCommand>();
  const root = vscode.workspace.workspaceFolders?.[0]?.uri;
  if (!root) {
    return commands;
  }

  const dir = vscode.Uri.joinPath(root, COMMANDS_RELATIVE_DIR);
  let entries: [string, vscode.FileType][];
  try {
    entries = await vscode.workspace.fs.readDirectory(dir);
  } catch {
    return commands; // No .localagent/commands directory — perfectly normal.
  }

  for (const [name, type] of entries) {
    if (type !== vscode.FileType.File || !name.endsWith('.md')) {
      continue;
    }
    const commandName = name.slice(0, -3);
    try {
      const bytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(dir, name));
      const { description, body } = parseFrontmatter(Buffer.from(bytes).toString('utf8'));
      commands.set(commandName, { name: commandName, description, body });
    } catch {
      // Unreadable file — skip it rather than failing the whole load.
    }
  }

  return commands;
}

/**
 * If the prompt starts with "/name ...", expands it using the matching command's body
 * ($ARGUMENTS is replaced with whatever followed the command name). Returns the prompt
 * unchanged if it doesn't start with "/" or doesn't match a loaded command.
 */
export function expandCommand(prompt: string, commands: Map<string, LoadedCommand>): string {
  const match = prompt.match(/^\/(\S+)\s*([\s\S]*)$/);
  if (!match) {
    return prompt;
  }
  const [, name, args] = match;
  const command = commands.get(name);
  if (!command) {
    return prompt;
  }
  return command.body.includes('$ARGUMENTS') ? command.body.replaceAll('$ARGUMENTS', args) : `${command.body}\n\n${args}`.trim();
}

/** Renders the listing shown when the user types "/commands". */
export function formatCommandList(commands: Map<string, LoadedCommand>): string {
  if (commands.size === 0) {
    return (
      'No custom commands found. Add `.md` files under `.localagent/commands/` in your workspace to define ' +
      'some — each file becomes `/<filename>`, and its body is sent as the prompt (with `$ARGUMENTS` replaced ' +
      'by anything typed after the command name).'
    );
  }
  const lines = [...commands.values()].map((c) => `- \`/${c.name}\`${c.description ? ` — ${c.description}` : ''}`);
  return `**Available commands:**\n\n${lines.join('\n')}`;
}
