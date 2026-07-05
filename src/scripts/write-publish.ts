/**
 * 在线写作发布服务：将文章与图片以单次 commit 推送到 GitHub 仓库，
 * push 后由现有 GitHub Actions（deploy.yml）自动构建部署。
 *
 * 与 UI 无关：进度通过 onProgress 回调上报，错误直接抛出。
 */

import { getAuthToken, type WriteAuthConfig } from "./write-auth";
import {
  createBlob,
  createCommit,
  createTree,
  getRef,
  listRepoDir,
  readTextFileFromRepo,
  toBase64Utf8,
  updateRef,
  type TreeItem,
} from "./write-github-client";
import {
  parseArticle,
  stringifyArticle,
  type ArticleFrontmatter,
} from "./write-frontmatter";

export type WritePublishConfig = WriteAuthConfig & {
  branch: string;
  contentDir: string;
  imagesDir: string;
  imagesPublicBase: string;
};

export type LocalImage = {
  id: string;
  file: File;
  /** 编辑器内实时预览用的 object URL，发布时替换为仓库路径 */
  previewUrl?: string;
};

export type ArticleForm = {
  /** 文件名 slug（不含扩展名） */
  slug: string;
  /** 归档子目录；空字符串表示集合根目录 */
  archiveDir: string;
  fileFormat: "md" | "mdx";
  title: string;
  description: string;
  createdAt: string;
  updatedAt?: string;
  type?: string;
  published: boolean;
  /** 封面：http(s) URL 或 local-image 的 id */
  cover?: string;
  /** Markdown 正文，本地图片以 (local-image:{id}) 占位 */
  body: string;
};

export type PublishParams = {
  config: WritePublishConfig;
  form: ArticleForm;
  images: LocalImage[];
  mode: "create" | "edit";
  /** 编辑模式下原文件的仓库路径（slug/目录/格式变化时用于删除旧文件） */
  originalPath?: string;
  onProgress?: (message: string) => void;
};

export type ArticleListItem = {
  path: string;
  name: string;
  archiveDir: string;
};

const LOCAL_IMAGE_PREFIX = "local-image:";

// ---------- 文件工具 ----------

export async function hashFileSHA256(file: File): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    await file.arrayBuffer(),
  );
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export function fileToBase64NoPrefix(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || "");
      resolve(result.slice(result.indexOf(",") + 1));
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

export function getFileExt(filename: string): string {
  const dot = filename.lastIndexOf(".");
  return dot >= 0 ? filename.slice(dot).toLowerCase() : "";
}

/** 本地时区的 YYYY-MM-DD，与仓库既有文章的 createdAt 格式一致 */
export function formatDateLocal(date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function localImagePlaceholder(id: string): string {
  return `${LOCAL_IMAGE_PREFIX}${id}`;
}

function articlePath(config: WritePublishConfig, form: ArticleForm): string {
  const dir = form.archiveDir.trim().replace(/^\/+|\/+$/g, "");
  const filename = `${form.slug}.${form.fileFormat}`;
  return dir
    ? `${config.contentDir}/${dir}/${filename}`
    : `${config.contentDir}/${filename}`;
}

// ---------- 发布 ----------

export async function publishArticle(params: PublishParams): Promise<void> {
  const { config, form, images, mode, originalPath, onProgress } = params;
  const progress = onProgress ?? (() => {});

  if (!form.slug) throw new Error("Slug is required");
  if (!form.title) throw new Error("Title is required");

  progress("Verifying identity...");
  const token = await getAuthToken(config);

  progress("Syncing branch info...");
  const refData = await getRef(
    token,
    config.owner,
    config.repo,
    `heads/${config.branch}`,
  );
  const latestCommitSha = refData.sha;

  const treeItems: TreeItem[] = [];
  let body = form.body;
  let coverPath = form.cover?.trim() || undefined;

  // 上传正文与封面引用到的本地图片；同名内容（同 hash）只上传一次
  const usedImages = images.filter(
    (img) =>
      body.includes(localImagePlaceholder(img.id)) ||
      (img.previewUrl && body.includes(img.previewUrl)) ||
      form.cover === img.id,
  );
  const uploadedHashes = new Set<string>();
  let index = 1;
  for (const image of usedImages) {
    progress(`Uploading image (${index++}/${usedImages.length})...`);
    const hash = await hashFileSHA256(image.file);
    const ext = getFileExt(image.file.name) || ".png";
    const filename = `${hash}${ext}`;
    const publicPath = `${config.imagesPublicBase}/${form.slug}/${filename}`;

    if (!uploadedHashes.has(hash)) {
      const contentBase64 = await fileToBase64NoPrefix(image.file);
      const blob = await createBlob(
        token,
        config.owner,
        config.repo,
        contentBase64,
        "base64",
      );
      treeItems.push({
        path: `${config.imagesDir}/${form.slug}/${filename}`,
        mode: "100644",
        type: "blob",
        sha: blob.sha,
      });
      uploadedHashes.add(hash);
    }

    body = body
      .split(`(${localImagePlaceholder(image.id)})`)
      .join(`(${publicPath})`);
    if (image.previewUrl) {
      body = body.split(image.previewUrl).join(publicPath);
    }
    if (form.cover === image.id) {
      coverPath = publicPath;
    }
  }

  if (coverPath?.startsWith("blob:")) {
    throw new Error(
      "Cover is a temporary blob URL — upload the image or use an http(s) URL",
    );
  }

  progress("Preparing post content...");
  const frontmatter: ArticleFrontmatter = {
    routeSlug: form.slug,
    title: form.title,
    description: form.description || undefined,
    image: coverPath,
    createdAt: form.createdAt || formatDateLocal(),
    updatedAt: form.updatedAt || undefined,
    type: form.type || undefined,
    published: form.published ? undefined : false,
  };
  const finalContent = stringifyArticle(frontmatter, body);

  const targetPath = articlePath(config, form);
  const articleBlob = await createBlob(
    token,
    config.owner,
    config.repo,
    toBase64Utf8(finalContent),
    "base64",
  );
  treeItems.push({
    path: targetPath,
    mode: "100644",
    type: "blob",
    sha: articleBlob.sha,
  });

  // 编辑时若路径变化（slug/目录/格式任一变动），同一 commit 内删除旧文件
  if (mode === "edit" && originalPath && originalPath !== targetPath) {
    treeItems.push({
      path: originalPath,
      mode: "100644",
      type: "blob",
      sha: null,
    });
  }

  progress("Committing changes...");
  const tree = await createTree(
    token,
    config.owner,
    config.repo,
    treeItems,
    latestCommitSha,
  );
  const commitMessage =
    mode === "edit"
      ? `feat(blog): update post "${form.title}"`
      : `feat(blog): publish post "${form.title}"`;
  const commit = await createCommit(
    token,
    config.owner,
    config.repo,
    commitMessage,
    tree.sha,
    [latestCommitSha],
  );

  progress("Updating remote branch...");
  await updateRef(
    token,
    config.owner,
    config.repo,
    `heads/${config.branch}`,
    commit.sha,
  );
}

// ---------- 删除 ----------

export async function deleteArticle(
  config: WritePublishConfig,
  path: string,
  onProgress?: (message: string) => void,
): Promise<void> {
  const progress = onProgress ?? (() => {});

  progress("Verifying identity...");
  const token = await getAuthToken(config);

  progress("Syncing branch info...");
  const refData = await getRef(
    token,
    config.owner,
    config.repo,
    `heads/${config.branch}`,
  );

  const treeItems: TreeItem[] = [
    { path, mode: "100644", type: "blob", sha: null },
  ];

  // 一并清理该文章的图片目录，避免遗留孤儿资源
  const slug =
    path
      .replace(/\.(md|mdx)$/i, "")
      .split("/")
      .pop() || "";
  if (slug) {
    const imageEntries = await listRepoDir(
      token,
      config.owner,
      config.repo,
      `${config.imagesDir}/${slug}`,
      config.branch,
    );
    for (const entry of imageEntries) {
      if (entry.type === "file") {
        treeItems.push({
          path: entry.path,
          mode: "100644",
          type: "blob",
          sha: null,
        });
      }
    }
  }

  progress("Committing deletion...");
  const tree = await createTree(
    token,
    config.owner,
    config.repo,
    treeItems,
    refData.sha,
  );
  const commit = await createCommit(
    token,
    config.owner,
    config.repo,
    `feat(blog): remove post "${slug}"`,
    tree.sha,
    [refData.sha],
  );
  await updateRef(
    token,
    config.owner,
    config.repo,
    `heads/${config.branch}`,
    commit.sha,
  );
}

// ---------- 列表与加载 ----------

/** 列出集合下的全部文章（递归一层归档目录） */
export async function listArticles(
  config: WritePublishConfig,
): Promise<ArticleListItem[]> {
  const token = await getAuthToken(config);
  const rootEntries = await listRepoDir(
    token,
    config.owner,
    config.repo,
    config.contentDir,
    config.branch,
  );

  const items: ArticleListItem[] = [];
  for (const entry of rootEntries) {
    if (entry.type === "file" && /\.(md|mdx)$/i.test(entry.name)) {
      items.push({ path: entry.path, name: entry.name, archiveDir: "" });
    } else if (entry.type === "dir") {
      const nested = await listRepoDir(
        token,
        config.owner,
        config.repo,
        entry.path,
        config.branch,
      );
      for (const child of nested) {
        if (child.type === "file" && /\.(md|mdx)$/i.test(child.name)) {
          items.push({
            path: child.path,
            name: child.name,
            archiveDir: entry.name,
          });
        }
      }
    }
  }

  return items.sort((a, b) => a.path.localeCompare(b.path));
}

export type LoadedArticle = {
  path: string;
  data: Record<string, string | boolean | string[]>;
  body: string;
};

export async function loadArticle(
  config: WritePublishConfig,
  path: string,
): Promise<LoadedArticle> {
  const token = await getAuthToken(config);
  const raw = await readTextFileFromRepo(
    token,
    config.owner,
    config.repo,
    path,
    config.branch,
  );
  if (raw === null) throw new Error(`Post not found: ${path}`);
  const { data, body } = parseArticle(raw);
  return { path, data, body };
}
