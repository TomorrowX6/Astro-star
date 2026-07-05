/**
 * 发布前的 MDX 语法校验：用与 Astro 构建管线同源的解析器
 * （remark-parse + remark-mdx）解析正文，把会导致部署构建失败的
 * 语法错误（如正文裸写 <类型> 被当作未闭合的 JSX 标签、
 * 裸 { } 被当作表达式）拦截在发布之前。
 *
 * 解析器体积较大，按需动态加载，不进入 /write 页首屏 chunk。
 */

type PositionedError = { line?: unknown };

export async function assertValidMdxBody(body: string): Promise<void> {
  const [{ unified }, { default: remarkParse }, { default: remarkMdx }] =
    await Promise.all([
      import("unified"),
      import("remark-parse"),
      import("remark-mdx"),
    ]);

  try {
    unified().use(remarkParse).use(remarkMdx).parse(body);
  } catch (error) {
    const line = (error as PositionedError).line;
    const position = typeof line === "number" ? ` at body line ${line}` : "";
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `MDX syntax error${position}: ${reason} — wrap literal <...> or { } in backticks or a code block, or switch File format to md`,
    );
  }
}
