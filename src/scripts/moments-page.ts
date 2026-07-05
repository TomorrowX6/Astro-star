/**
 * /moments 页面控制器：时间线懒加载 + 删除按钮
 * （发布在 /write 的 Moment 标签页完成）。
 *
 * 懒加载：全部瞬间都在静态 HTML 里，超出首批的带 data-moment-lazy
 * 由 CSS 隐藏；滚动到底部哨兵时分批展开，锚点跳转前先展开到目标。
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

  // ---------- 时间线懒加载 ----------

  // 与 moments.astro 的 LAZY_INITIAL_COUNT 一致
  const LAZY_BATCH_SIZE = 10;
  const lazyItems = Array.from(
    root.querySelectorAll<HTMLElement>(".moment-card[data-moment-lazy]"),
  );
  const sentinel = root.querySelector<HTMLElement>("[data-moment-sentinel]");
  let revealedCount = 0;
  let lazyObserver: IntersectionObserver | null = null;

  browserWindow.__momentsPageCleanup = () => {
    controller.abort();
    lazyObserver?.disconnect();
  };

  const revealNextBatch = () => {
    const batch = lazyItems.slice(
      revealedCount,
      revealedCount + LAZY_BATCH_SIZE,
    );
    for (const item of batch) {
      item.removeAttribute("data-moment-lazy");
      // 整组隐藏的年份分组随第一条展开的卡片一起显示
      item
        .closest<HTMLElement>(".moment-year-group")
        ?.removeAttribute("data-moment-lazy");
    }
    revealedCount += batch.length;
    if (revealedCount >= lazyItems.length) {
      lazyObserver?.disconnect();
      sentinel?.remove();
    }
  };

  if (sentinel && lazyItems.length > 0) {
    lazyObserver = new IntersectionObserver(
      (observed) => {
        if (observed.some((entry) => entry.isIntersecting)) revealNextBatch();
      },
      // 提前一屏左右开始展开，滚动更顺滑
      { rootMargin: "600px 0px" },
    );
    lazyObserver.observe(sentinel);
  }

  // 锚点目标（热力图/TOC 的 #moment-x、#year-x）仍隐藏时先展开到该位置
  const revealForTarget = (id: string, scroll: boolean) => {
    if (!id) return;
    const target = document.getElementById(id);
    const hiddenContainer = target?.closest<HTMLElement>("[data-moment-lazy]");
    if (!target || !hiddenContainer) return;
    while (
      revealedCount < lazyItems.length &&
      hiddenContainer.hasAttribute("data-moment-lazy")
    ) {
      revealNextBatch();
    }
    if (scroll) target.scrollIntoView();
  };

  // 捕获阶段执行，先于 TOC 等既有的锚点滚动处理器展开目标
  document.addEventListener(
    "click",
    (event) => {
      const anchor = (event.target as HTMLElement | null)?.closest?.(
        'a[href*="#"]',
      );
      const href = anchor?.getAttribute("href") ?? "";
      const hashIndex = href.indexOf("#");
      if (hashIndex < 0) return;
      revealForTarget(decodeURIComponent(href.slice(hashIndex + 1)), false);
    },
    { signal, capture: true },
  );

  // 直接带 hash 打开页面：浏览器对隐藏元素滚动无效，展开后补一次滚动
  if (window.location.hash) {
    revealForTarget(decodeURIComponent(window.location.hash.slice(1)), true);
  }

  // ---------- 删除按钮 ----------

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
