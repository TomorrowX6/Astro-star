/**
 * 浏览器端 GitHub API 客户端（在线写作功能地基）。
 *
 * 认证链路：GitHub App 私钥 (PEM) → RS256 JWT → Installation Token。
 * 提交链路：Git Data API（blob → tree → commit → 更新 ref），
 * 单次 commit 可同时写入文章与图片。
 *
 * 本模块与框架无关：不依赖任何 UI 库，所有参数显式传入，
 * 错误统一抛出 GitHubApiError（携带 HTTP 状态码），由调用方决定提示方式。
 */

import { KJUR, KEYUTIL } from "jsrsasign";

export const GH_API = "https://api.github.com";

export class GitHubApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "GitHubApiError";
    this.status = status;
  }

  /** 401：Token 失效或私钥错误，调用方应清空认证缓存 */
  get isAuthError(): boolean {
    return this.status === 401;
  }

  /** 422：请求过快或参数冲突 */
  get isUnprocessable(): boolean {
    return this.status === 422;
  }
}

const JSON_HEADERS = {
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
} as const;

function authHeaders(token: string): HeadersInit {
  return { ...JSON_HEADERS, Authorization: `Bearer ${token}` };
}

async function assertOk(res: Response, action: string): Promise<void> {
  if (!res.ok) {
    throw new GitHubApiError(res.status, `${action} failed: ${res.status}`);
  }
}

/** UTF-8 字符串转 base64（GitHub contents/blob API 要求）；分块避免大文件栈溢出 */
export function toBase64Utf8(input: string): string {
  const bytes = new TextEncoder().encode(input);
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

/** base64 转 UTF-8 字符串（GitHub contents API 响应解码） */
function fromBase64Utf8(base64: string): string {
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/** 用 GitHub App 私钥签发 RS256 JWT（有效期 8 分钟） */
export function signAppJwt(appId: string, privateKeyPem: string): string {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const payload = { iat: now - 60, exp: now + 8 * 60, iss: appId };
  const prv = KEYUTIL.getKey(privateKeyPem) as unknown as string;
  return KJUR.jws.JWS.sign(
    "RS256",
    JSON.stringify(header),
    JSON.stringify(payload),
    prv,
  );
}

/** 查询 GitHub App 在目标仓库的 Installation ID */
export async function getInstallationId(
  jwt: string,
  owner: string,
  repo: string,
): Promise<number> {
  const res = await fetch(`${GH_API}/repos/${owner}/${repo}/installation`, {
    headers: { ...JSON_HEADERS, Authorization: `Bearer ${jwt}` },
  });
  await assertOk(res, "installation lookup");
  const data = await res.json();
  return data.id;
}

/** 用 App JWT 换取 Installation Token（约 1 小时有效） */
export async function createInstallationToken(
  jwt: string,
  installationId: number,
): Promise<string> {
  const res = await fetch(
    `${GH_API}/app/installations/${installationId}/access_tokens`,
    {
      method: "POST",
      headers: { ...JSON_HEADERS, Authorization: `Bearer ${jwt}` },
    },
  );
  await assertOk(res, "create token");
  const data = await res.json();
  return data.token as string;
}

export async function getRef(
  token: string,
  owner: string,
  repo: string,
  ref: string,
): Promise<{ sha: string }> {
  const res = await fetch(
    `${GH_API}/repos/${owner}/${repo}/git/ref/${encodeURIComponent(ref)}`,
    { headers: authHeaders(token) },
  );
  await assertOk(res, "get ref");
  const data = await res.json();
  return { sha: data.object.sha };
}

export async function getCommit(
  token: string,
  owner: string,
  repo: string,
  sha: string,
): Promise<{ tree: { sha: string } }> {
  const res = await fetch(
    `${GH_API}/repos/${owner}/${repo}/git/commits/${sha}`,
    { headers: authHeaders(token) },
  );
  await assertOk(res, "get commit");
  return res.json();
}

export type TreeItem = {
  path: string;
  mode: "100644" | "100755" | "040000" | "160000" | "120000";
  type: "blob" | "tree" | "commit";
  content?: string;
  /** null 表示从树中删除该文件 */
  sha?: string | null;
};

export async function createTree(
  token: string,
  owner: string,
  repo: string,
  tree: TreeItem[],
  baseTree?: string,
): Promise<{ sha: string }> {
  const res = await fetch(`${GH_API}/repos/${owner}/${repo}/git/trees`, {
    method: "POST",
    headers: { ...authHeaders(token), "Content-Type": "application/json" },
    body: JSON.stringify({ tree, base_tree: baseTree }),
  });
  await assertOk(res, "create tree");
  const data = await res.json();
  return { sha: data.sha };
}

export async function createCommit(
  token: string,
  owner: string,
  repo: string,
  message: string,
  tree: string,
  parents: string[],
): Promise<{ sha: string }> {
  const res = await fetch(`${GH_API}/repos/${owner}/${repo}/git/commits`, {
    method: "POST",
    headers: { ...authHeaders(token), "Content-Type": "application/json" },
    body: JSON.stringify({ message, tree, parents }),
  });
  await assertOk(res, "create commit");
  const data = await res.json();
  return { sha: data.sha };
}

export async function updateRef(
  token: string,
  owner: string,
  repo: string,
  ref: string,
  sha: string,
  force = false,
): Promise<void> {
  const res = await fetch(
    `${GH_API}/repos/${owner}/${repo}/git/refs/${encodeURIComponent(ref)}`,
    {
      method: "PATCH",
      headers: { ...authHeaders(token), "Content-Type": "application/json" },
      body: JSON.stringify({ sha, force }),
    },
  );
  await assertOk(res, "update ref");
}

export async function createBlob(
  token: string,
  owner: string,
  repo: string,
  content: string,
  encoding: "utf-8" | "base64" = "base64",
): Promise<{ sha: string }> {
  const res = await fetch(`${GH_API}/repos/${owner}/${repo}/git/blobs`, {
    method: "POST",
    headers: { ...authHeaders(token), "Content-Type": "application/json" },
    body: JSON.stringify({ content, encoding }),
  });
  await assertOk(res, "create blob");
  const data = await res.json();
  return { sha: data.sha };
}

/** 读取仓库中的文本文件；404 返回 null */
export async function readTextFileFromRepo(
  token: string | null | undefined,
  owner: string,
  repo: string,
  path: string,
  ref: string,
): Promise<string | null> {
  const headers: HeadersInit = token ? authHeaders(token) : { ...JSON_HEADERS };
  const res = await fetch(
    `${GH_API}/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}?ref=${encodeURIComponent(ref)}&t=${Date.now()}`,
    { headers, cache: "no-store" },
  );
  if (res.status === 404) return null;
  await assertOk(res, "read file");
  const data = await res.json();
  if (Array.isArray(data) || !data.content) return null;
  // contents API 的 base64 会包含换行符，解码前需去除
  const base64 = String(data.content).replace(/\s/g, "");
  try {
    return fromBase64Utf8(base64);
  } catch {
    return atob(base64);
  }
}

export type RepoDirEntry = {
  name: string;
  path: string;
  sha: string;
  type: "file" | "dir";
};

/** 列出仓库目录（单层）；404 返回空数组 */
export async function listRepoDir(
  token: string | null | undefined,
  owner: string,
  repo: string,
  path: string,
  ref: string,
): Promise<RepoDirEntry[]> {
  const headers: HeadersInit = token ? authHeaders(token) : { ...JSON_HEADERS };
  const res = await fetch(
    `${GH_API}/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}?ref=${encodeURIComponent(ref)}`,
    { headers },
  );
  if (res.status === 404) return [];
  await assertOk(res, "read directory");
  const data = await res.json();
  return Array.isArray(data) ? data : [data];
}
