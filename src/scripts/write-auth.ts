/**
 * 在线写作认证模块。
 *
 * 职责：GitHub App 私钥 (PEM) 的加密缓存（sessionStorage + AES-GCM），
 * 以及 Installation Token 的签发与缓存。
 *
 * 与 UI 无关：所有配置显式传入，失败抛出异常由调用方处理。
 */

import {
  createInstallationToken,
  getInstallationId,
  signAppJwt,
} from "./write-github-client";

const TOKEN_CACHE_KEY = "write_github_token";
const PEM_CACHE_KEY = "write_p_info";

export type WriteAuthConfig = {
  appId: string;
  owner: string;
  repo: string;
  encryptKey: string;
};

// ---------- AES-GCM 工具（密钥经 SHA-256 派生，iv 前置存储） ----------

async function deriveAesKey(
  secret: string,
  usage: "encrypt" | "decrypt",
): Promise<CryptoKey> {
  const keyData = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(secret),
  );
  return crypto.subtle.importKey("raw", keyData, { name: "AES-GCM" }, false, [
    usage,
  ]);
}

export async function encryptText(text: string, key: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cryptoKey = await deriveAesKey(key, "encrypt");
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    cryptoKey,
    new TextEncoder().encode(text),
  );
  const result = new Uint8Array(iv.length + encrypted.byteLength);
  result.set(iv, 0);
  result.set(new Uint8Array(encrypted), iv.length);
  let binary = "";
  for (const byte of result) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export async function decryptText(
  cipherText: string,
  key: string,
): Promise<string> {
  const data = Uint8Array.from(atob(cipherText), (c) => c.charCodeAt(0));
  const iv = data.slice(0, 12);
  const encrypted = data.slice(12);
  const cryptoKey = await deriveAesKey(key, "decrypt");
  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv },
    cryptoKey,
    encrypted,
  );
  return new TextDecoder().decode(decrypted);
}

// ---------- 缓存读写 ----------

function readSession(key: string): string | null {
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeSession(key: string, value: string): void {
  try {
    sessionStorage.setItem(key, value);
  } catch {
    // sessionStorage 不可用时静默降级：仅影响缓存，功能仍可用
  }
}

function removeSession(key: string): void {
  try {
    sessionStorage.removeItem(key);
  } catch {
    // 同上
  }
}

export function getCachedToken(): string | null {
  return readSession(TOKEN_CACHE_KEY);
}

/** Token 失效（401）时调用：仅清 Token，保留私钥以便自动重签 */
export function clearCachedToken(): void {
  removeSession(TOKEN_CACHE_KEY);
}

export async function savePem(pem: string, encryptKey: string): Promise<void> {
  writeSession(PEM_CACHE_KEY, await encryptText(pem, encryptKey));
}

export async function getPem(encryptKey: string): Promise<string | null> {
  const encrypted = readSession(PEM_CACHE_KEY);
  if (!encrypted) return null;
  try {
    return await decryptText(encrypted, encryptKey);
  } catch {
    return null;
  }
}

/** 退出登录：清空私钥与 Token */
export function clearAuth(): void {
  removeSession(TOKEN_CACHE_KEY);
  removeSession(PEM_CACHE_KEY);
}

export async function hasAuth(encryptKey: string): Promise<boolean> {
  return !!getCachedToken() || !!(await getPem(encryptKey));
}

// ---------- Token 签发 ----------

/**
 * 获取可用的 Installation Token：
 * 优先返回缓存；否则用缓存的私钥签 JWT → 查 Installation → 换 Token。
 * 无私钥时抛出异常，调用方应引导用户先粘贴私钥。
 */
export async function getAuthToken(config: WriteAuthConfig): Promise<string> {
  if (!config.appId.trim()) {
    throw new Error(
      "GitHub App ID is not configured. Set PUBLIC_GITHUB_APP_ID in the deployment environment and rebuild.",
    );
  }
  if (!config.owner.trim() || !config.repo.trim()) {
    throw new Error(
      "GitHub repository is not configured. Set PUBLIC_GITHUB_OWNER and PUBLIC_GITHUB_REPO in the deployment environment and rebuild.",
    );
  }

  const cached = getCachedToken();
  if (cached) return cached;

  const pem = await getPem(config.encryptKey);
  if (!pem) {
    throw new Error("GitHub App private key has not been set");
  }

  let jwt: string;
  try {
    jwt = signAppJwt(config.appId, pem);
  } catch {
    throw new Error(
      "Could not parse the private key — make sure the full PEM content was provided",
    );
  }
  const installationId = await getInstallationId(
    jwt,
    config.owner,
    config.repo,
  );
  const token = await createInstallationToken(jwt, installationId);
  writeSession(TOKEN_CACHE_KEY, token);
  return token;
}
