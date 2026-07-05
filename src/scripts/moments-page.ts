/**
 * /moments 页面控制器：在线发布器与删除按钮。
 *
 * 仅当浏览器会话中已有 /write 页保存的 GitHub App 私钥时，
 * 发布器与删除按钮才会显示；游客看到的是纯静态时间线。
 */

import { writeConfig } from "../config/write";
import { clearCachedToken, hasAuth } from "./write-auth";
import { GitHubApiError } from "./write-github-client";
import {
  deleteArticle,
  type LocalImage,
  type WritePublishConfig,
} from "./write-publish";
import { publishMoment } from "./write-moments";

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

  const composer = root.querySelector<HTMLElement>("[data-moment-composer]");
  const contentInput = root.querySelector<HTMLTextAreaElement>(
    "[data-moment-content]",
  );
  const tagsInput = root.querySelector<HTMLInputElement>("[data-moment-tags]");
  const publishButton = root.querySelector<HTMLButtonElement>(
    "[data-moment-publish]",
  );
  const imageAddButton = root.querySelector<HTMLButtonElement>(
    "[data-moment-image-add]",
  );
  const imageInput = root.querySelector<HTMLInputElement>(
    "[data-moment-image-input]",
  );
  const imageList = root.querySelector<HTMLUListElement>(
    "[data-moment-image-list]",
  );
  const statusLine = root.querySelector<HTMLElement>("[data-moment-status]");
  const deleteButtons = Array.from(
    root.querySelectorAll<HTMLButtonElement>("[data-moment-delete]"),
  );

  let images: LocalImage[] = [];
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

  const renderImages = () => {
    if (!imageList) return;
    imageList.textContent = "";
    for (const image of images) {
      const item = document.createElement("li");
      item.className = "moment-composer__image-item";

      const name = document.createElement("span");
      name.textContent = image.file.name;

      const removeButton = document.createElement("button");
      removeButton.type = "button";
      removeButton.textContent = "Remove";
      removeButton.addEventListener(
        "click",
        () => {
          images = images.filter((entry) => entry.id !== image.id);
          renderImages();
        },
        { signal },
      );

      item.append(name, removeButton);
      imageList.append(item);
    }
  };

  imageAddButton?.addEventListener("click", () => imageInput?.click(), {
    signal,
  });

  imageInput?.addEventListener(
    "change",
    () => {
      for (const file of Array.from(imageInput.files || [])) {
        images.push({ id: crypto.randomUUID(), file });
      }
      imageInput.value = "";
      renderImages();
    },
    { signal },
  );

  publishButton?.addEventListener(
    "click",
    async () => {
      if (busy) return;
      busy = true;
      publishButton.disabled = true;
      try {
        const tags = (tagsInput?.value || "")
          .split(/[,，]/)
          .map((tag) => tag.trim())
          .filter(Boolean);
        await publishMoment(
          momentsConfig,
          { content: contentInput?.value ?? "", tags, images },
          (message) => setStatus(message),
        );
        if (contentInput) contentInput.value = "";
        if (tagsInput) tagsInput.value = "";
        images = [];
        renderImages();
        setStatus("Posted! It will appear after the site redeploys", "ok");
      } catch (error) {
        handleError(error);
      } finally {
        busy = false;
        publishButton.disabled = false;
      }
    },
    { signal },
  );

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

  // 已登录（/write 会话中有私钥）才显示发布器与删除按钮
  void hasAuth(momentsConfig.encryptKey).then((authed) => {
    if (!authed) return;
    composer?.removeAttribute("hidden");
    for (const button of deleteButtons) {
      button.removeAttribute("hidden");
    }
  });
}
