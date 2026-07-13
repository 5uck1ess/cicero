export interface CompiledShellCommand {
  /** Trusted operator-authored shell source with positional references in place of placeholders. */
  script: string;
  /** Runtime values passed after sh's $0, never parsed as shell source. */
  args: string[];
  /** Operator template plus escaped values, for logs/context only (never executed). */
  display: string;
}

type QuoteContext = "unquoted" | "single" | "double";
type ShellContext = {
  kind: "root" | "command-substitution" | "backtick";
  quote: QuoteContext;
  parenDepth: number;
  caseDepth: number;
};

function isWordChar(char: string | undefined): boolean {
  return char !== undefined && /[A-Za-z0-9_]/.test(char);
}

function keywordAt(template: string, index: number, keyword: string): boolean {
  return template.startsWith(keyword, index)
    && !isWordChar(template[index - 1])
    && !isWordChar(template[index + keyword.length]);
}

function startsShellCommand(template: string, index: number): boolean {
  let cursor = index - 1;
  while (cursor >= 0 && /[ \t\r]/.test(template[cursor]!)) cursor -= 1;
  return cursor < 0 || /[;|&\n(]/.test(template[cursor]!);
}

function displayValue(name: string, value: string): string {
  if (/(?:api[_-]?key|credential|pass(?:word)?|secret|token)/i.test(name)) {
    return JSON.stringify("[redacted]");
  }
  const bounded = value.length > 512 ? `${value.slice(0, 509)}...` : value;
  return JSON.stringify(bounded);
}

/**
 * Compile an action command without inserting runtime values into shell source.
 *
 * Placeholders become quoted positional parameters. The replacement varies with
 * the surrounding quote context so `{value}`, `"{value}"`, and `'{value}'` all
 * produce one literal shell word. Reusing a placeholder reuses its positional
 * argument, and unknown placeholders remain untouched for backwards compatibility.
 */
export function compileShellCommand(
  template: string,
  params: Readonly<Record<string, string>>,
): CompiledShellCommand {
  const args: string[] = [];
  const positions = new Map<string, number>();
  const contexts: ShellContext[] = [{ kind: "root", quote: "unquoted", parenDepth: 0, caseDepth: 0 }];
  const names: string[] = [];
  let script = "";

  for (let index = 0; index < template.length; index += 1) {
    const char = template[index]!;
    let context = contexts[contexts.length - 1]!;

    // A backslash protects the following character outside single quotes. Keep
    // both verbatim and do not interpret an escaped `{` as a placeholder.
    if (char === "\\" && context.quote !== "single" && index + 1 < template.length) {
      script += char + template[index + 1]!;
      index += 1;
      continue;
    }

    // Quotes inside command substitutions are independent from quotes around
    // the substitution. Track nested contexts so a parameter in
    // `"$(printf '%s' {value})"` is still expanded as one literal word.
    if (char === "$" && template[index + 1] === "(" && context.quote !== "single") {
      script += "$(";
      contexts.push({ kind: "command-substitution", quote: "unquoted", parenDepth: 0, caseDepth: 0 });
      index += 1;
      continue;
    }

    if (char === "`" && context.quote !== "single") {
      script += char;
      if (context.kind === "backtick" && context.quote === "unquoted") {
        contexts.pop();
      } else {
        contexts.push({ kind: "backtick", quote: "unquoted", parenDepth: 0, caseDepth: 0 });
      }
      continue;
    }

    if (context.kind === "command-substitution" && context.quote === "unquoted") {
      if (keywordAt(template, index, "case") && startsShellCommand(template, index)) {
        context.caseDepth += 1;
        script += "case";
        index += "case".length - 1;
        continue;
      }
      if (keywordAt(template, index, "esac") && startsShellCommand(template, index)) {
        context.caseDepth = Math.max(0, context.caseDepth - 1);
        script += "esac";
        index += "esac".length - 1;
        continue;
      }
      if (char === "(") {
        context.parenDepth += 1;
        script += char;
        continue;
      }
      if (char === ")") {
        script += char;
        if (context.parenDepth > 0) context.parenDepth -= 1;
        else if (context.caseDepth === 0) contexts.pop();
        // Otherwise `case value in pattern)` closes a pattern arm, not the
        // surrounding command substitution.
        continue;
      }
    }

    context = contexts[contexts.length - 1]!;
    if (char === "'" && context.quote !== "double") {
      context.quote = context.quote === "single" ? "unquoted" : "single";
      script += char;
      continue;
    }

    if (char === '"' && context.quote !== "single") {
      context.quote = context.quote === "double" ? "unquoted" : "double";
      script += char;
      continue;
    }

    // `${name}` belongs to the operator's shell program, not Cicero's `{name}`
    // action-template syntax.
    if (char !== "{" || template[index - 1] === "$") {
      script += char;
      continue;
    }

    const end = template.indexOf("}", index + 1);
    if (end === -1) {
      script += char;
      continue;
    }

    const key = template.slice(index + 1, end);
    if (!Object.hasOwn(params, key)) {
      script += char;
      continue;
    }

    let position = positions.get(key);
    if (position === undefined) {
      args.push(params[key]!);
      names.push(key);
      position = args.length;
      positions.set(key, position);
    }

    const reference = "${" + position + "}";
    if (context.quote === "double") {
      // The surrounding double quotes already make the expansion one literal word.
      script += reference;
    } else if (context.quote === "single") {
      // Leave the operator's single-quoted segment, expand safely, then reopen it.
      script += "'\"" + reference + "\"'";
    } else {
      script += '"' + reference + '"';
    }
    index = end;
  }

  const bindings = names.map((name, index) => `${name}=${displayValue(name, args[index]!)}`);
  return {
    script,
    args,
    display: bindings.length > 0 ? `${template} [params: ${bindings.join(", ")}]` : template,
  };
}
