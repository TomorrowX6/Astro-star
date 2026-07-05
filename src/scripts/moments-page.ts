/**
 * /moments 页面控制器：删除按钮（发布在 /write 的 Moment 标签页完成）。
 *
 * 仅当浏览器会话中已有 /write 页保存的 GitHub App 私钥时，
 * 删除按钮才会显示；游客看到的是纯静态时间线。
 */

import { writeConfig } from "../config/write";
import { clearCachedToken, hasAuth } from "./write-auth";
import { GitHubApiError } from "./write-github-client";
import { deleteArticle, type WritePublishConfig } from "./write-publish";

type MomentsPageWindow = Window & {
  __momentsPageCleanup?: () => void;
};

const momentsConfig: WritePublishConfig = {
  appId: writeConfig.github.appId,
  owner: writeConfig.github.owner,
  repo: writeConfig.github.repo,
  branch: writeConfig.github.branch,
  encryptKey: writeConfig.github.encryptKey,
  contentDir: writeConfig.moments.contentDir,
  imagesDir: writeConfig.moments.imagesDir,
  imagesPublicBase: writeConfig.moments.imagesPublicBase,
};

export function initMomentsPage() {
  const root = document.querySelector<HTMLElement>("[data-moments-root]");
  if (!root) return;

  const browserWindow = window as MomentsPageWindow;
  browserWindow.__momentsPageCleanup?.();
  const controller = new AbortController();
  const { signal } = controller;
  browserWindow.__momentsPageCleanup = () => controller.abort();

  const statusLine = root.querySelector<HTMLElement>("[data-moment-status]");
  const deleteButtons = Array.from(
    root.querySelectorAll<HTMLButtonElement>("[data-moment-delete]"),
  );

  let pendingDeletePath: string | null = null;
  let busy = false;

  const setStatus = (
    message: string,
    kind: "info" | "ok" | "error" = "info",
  ) => {
    if (!statusLine) return;
    statusLine.textContent = message;
    statusLine.dataset.kind = kind;
  };

  const handleError = (error: unknown) => {
    console.error(error);
    if (error instanceof GitHubApiError && error.isAuthError) {
      clearCachedToken();
      setStatus("Authorization expired — sign in again at /write", "error");
      return;
    }
    setStatus(
      error instanceof Error ? error.message : "An unknown error occurred",
      "error",
    );
  };

  for (const button of deleteButtons) {
    button.addEventListener(
      "click",
      async () => {
        const path = button.dataset.momentFile || "";
        if (!path) return;
        if (pendingDeletePath !== path) {
          pendingDeletePath = path;
          button.textContent = "Confirm?";
          setStatus("Click again to confirm deleting this moment");
          return;
        }
        if (busy) return;
        busy = true;
        try {
          await deleteArticle(momentsConfig, path, (message) =>
            setStatus(message),
          );
          button.closest(".moment-card")?.remove();
          setStatus("Deleted; takes effect after the site redeploys", "ok");
        } catch (error) {
          handleError(error);
        } finally {
          busy = false;
          pendingDeletePath = null;
        }
      },
      { signal },
    );
  }

  // 已登录（/write 会话中有私钥）才显示删除按钮
  void hasAuth(momentsConfig.encryptKey).then((authed) => {
    if (!authed) return;
    for (const button of deleteButtons) {
      button.removeAttribute("hidden");
    }
  });
}
