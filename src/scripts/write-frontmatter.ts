/**
 * 在线写作的 frontmatter 序列化与解析。
 *
 * 面向本项目 baseContentSchema 的扁平结构（字符串 / 布尔标量），
 * 不支持嵌套对象与数组——集合 schema 变复杂时应替换为完整 YAML 库。
 */

export type ArticleFrontmatter = {
  routeSlug?: string;
  title?: string;
  description?: string;
  image?: string;
  createdAt?: string;
  updatedAt?: string;
  type?: string;
  published?: boolean;
  tags?: string[];
};

/** frontmatter 字段的固定输出顺序，与仓库既有文章保持一致 */
const FIELD_ORDER: Array<keyof ArticleFrontmatter> = [
  "routeSlug",
  "title",
  "description",
  "image",
  "createdAt",
  "updatedAt",
  "type",
  "published",
  "tags",
];

function serializeValue(value: string | boolean | string[]): string {
  if (typeof value === "boolean") return String(value);
  // JSON.stringify 产生带双引号的安全标量 / 行内数组，均兼容 YAML
  return JSON.stringify(value);
}

/** 组装完整文章内容：frontmatter 块 + 正文 */
export function stringifyArticle(
  frontmatter: ArticleFrontmatter,
  body: string,
): string {
  const lines: string[] = ["---"];
  for (const key of FIELD_ORDER) {
    const value = frontmatter[key];
    if (value === undefined || value === "") continue;
    if (Array.isArray(value) && value.length === 0) continue;
    lines.push(`${key}: ${serializeValue(value)}`);
  }
  lines.push("---", "");
  return `${lines.join("\n")}\n${body.replace(/^\n+/, "")}`;
}

function parseValue(raw: string): string | boolean | string[] {
  const trimmed = raw.trim();
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) return parsed.map(String);
    } catch {
      // 非 JSON 行内数组时按普通标量处理
    }
  }
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    try {
      if (trimmed.startsWith('"')) return JSON.parse(trimmed);
    } catch {
      // 引号内容不合法时回退为去引号的原文
    }
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/** 拆解文章内容为 frontmatter 与正文；无 frontmatter 时 data 为空对象 */
export function parseArticle(raw: string): {
  data: Record<string, string | boolean | string[]>;
  body: string;
} {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) {
    return { data: {}, body: raw };
  }

  const data: Record<string, string | boolean | string[]> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const separator = line.indexOf(":");
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1);
    if (!key || /^\s/.test(line)) continue;
    data[key] = parseValue(value);
  }

  return { data, body: raw.slice(match[0].length).replace(/^\r?\n/, "") };
}
