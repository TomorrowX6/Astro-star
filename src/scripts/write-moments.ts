/**
 * 瞬间（Moments）发布服务：将短内容与图片以单次 commit 推送到仓库，
 * push 后由 GitHub Actions 自动重建站点。
 *
 * 复用 write-github-client / write-auth 的认证与 Git Data API 链路；
 * 删除瞬间直接复用 write-publish 的 deleteArticle（同样清理图片目录）。
 */

import { getAuthToken } from "./write-auth";
import {
  createBlob,
  createCommit,
  createTree,
  getRef,
  toBase64Utf8,
  updateRef,
  type TreeItem,
} from "./write-github-client";
import { stringifyArticle } from "./write-frontmatter";
import {
  fileToBase64NoPrefix,
  getFileExt,
  hashFileSHA256,
  type LocalImage,
  type WritePublishConfig,
} from "./write-publish";

export type MomentDraft = {
  /** Markdown 正文 */
  content: string;
  tags: string[];
  images: LocalImage[];
};

/** 本地时区 YYYY-MM-DD HH:mm，用于瞬间的 createdAt */
export function formatDateTimeLocal(date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    ` ${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}

/** 时间戳形式的文件名 id，如 20260705-183042 */
function momentId(date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

export async function publishMoment(
  config: WritePublishConfig,
  draft: MomentDraft,
  onProgress?: (message: string) => void,
): Promise<void> {
  const progress = onProgress ?? (() => {});

  if (!draft.content.trim() && draft.images.length === 0) {
    throw new Error("Moment content is empty");
  }

  progress("Verifying identity...");
  const token = await getAuthToken(config);

  progress("Syncing branch info...");
  const refData = await getRef(
    token,
    config.owner,
    config.repo,
    `heads/${config.branch}`,
  );

  const now = new Date();
  const id = momentId(now);
  const treeItems: TreeItem[] = [];

  // 附件图片上传后以 Markdown 形式追加到正文末尾（同内容 hash 去重）
  const uploadedHashes = new Set<string>();
  const imageLines: string[] = [];
  let index = 1;
  for (const image of draft.images) {
    progress(`Uploading image (${index++}/${draft.images.length})...`);
    const hash = await hashFileSHA256(image.file);
    const ext = getFileExt(image.file.name) || ".png";
    const filename = `${hash}${ext}`;
    const publicPath = `${config.imagesPublicBase}/${id}/${filename}`;

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
        path: `${config.imagesDir}/${id}/${filename}`,
        mode: "100644",
        type: "blob",
        sha: blob.sha,
      });
      uploadedHashes.add(hash);
    }

    imageLines.push(`![](${publicPath})`);
  }

  progress("Preparing moment content...");
  const body = [draft.content.trim(), imageLines.join("\n")]
    .filter(Boolean)
    .join("\n\n");
  const finalContent = stringifyArticle(
    { createdAt: formatDateTimeLocal(now), tags: draft.tags },
    body,
  );

  const momentBlob = await createBlob(
    token,
    config.owner,
    config.repo,
    toBase64Utf8(finalContent),
    "base64",
  );
  treeItems.push({
    path: `${config.contentDir}/${id}.md`,
    mode: "100644",
    type: "blob",
    sha: momentBlob.sha,
  });

  progress("Committing changes...");
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
    `feat(moment): add moment ${id}`,
    tree.sha,
    [refData.sha],
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
