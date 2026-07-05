/**
 * /write 页面控制器：认证门、文章表单、瞬间发布、图片附件、文章管理列表。
 *
 * 仅负责 DOM 交互与状态展示；GitHub 通信与内容组装
 * 全部委托给 write-auth / write-publish / write-moments 模块。
 */

import { writeConfig } from "../config/write";
import { slugifyCategoryLabel } from "../utils/content-slug";
import { clearAuth, clearCachedToken, hasAuth, savePem } from "./write-auth";
import { GitHubApiError } from "./write-github-client";
import {
  deleteArticle,
  formatDateLocal,
  listArticles,
  loadArticle,
  localImagePlaceholder,
  publishArticle,
  type ArticleForm,
  type LocalImage,
  type WritePublishConfig,
} from "./write-publish";
import { publishMoment } from "./write-moments";

type WritePageWindow = Window & {
  __writePageCleanup?: () => void;
};

type StatusKind = "info" | "ok" | "error";

const publishConfig: WritePublishConfig = {
  appId: writeConfig.github.appId,
  owner: writeConfig.github.owner,
  repo: writeConfig.github.repo,
  branch: writeConfig.github.branch,
  encryptKey: writeConfig.github.encryptKey,
  contentDir: writeConfig.content.contentDir,
  imagesDir: writeConfig.content.imagesDir,
  imagesPublicBase: writeConfig.content.imagesPublicBase,
};

const momentsConfig: WritePublishConfig = {
  ...publishConfig,
  contentDir: writeConfig.moments.contentDir,
  imagesDir: writeConfig.moments.imagesDir,
  imagesPublicBase: writeConfig.moments.imagesPublicBase,
};

export function initWritePage() {
  const root = document.querySelector<HTMLElement>("[data-write-root]");
  if (!root) return;

  const browserWindow = window as WritePageWindow;
  browserWindow.__writePageCleanup?.();
  const controller = new AbortController();
  const { signal } = controller;
  browserWindow.__writePageCleanup = () => controller.abort();

  const query = <T extends HTMLElement>(selector: string) =>
    root.querySelector<T>(selector);

  const authPanel = query("[data-write-auth]");
  const editorPanel = query("[data-write-editor]");
  const pemInput = query<HTMLTextAreaElement>("[data-write-pem]");
  const authSaveButton = query<HTMLButtonElement>("[data-write-auth-save]");
  const pemImportButton = query<HTMLButtonElement>("[data-write-pem-import]");
  const pemFileInput = query<HTMLInputElement>("[data-write-pem-file]");
  const logoutButton = query<HTMLButtonElement>("[data-write-logout]");
  const form = query<HTMLFormElement>("[data-write-form]");
  const statusLine = query("[data-write-status]");
  const publishButton = query<HTMLButtonElement>("[data-write-publish]");
  const resetButton = query<HTMLButtonElement>("[data-write-reset]");
  const imageInput = query<HTMLInputElement>("[data-write-image-input]");
  const imageAddButton = query<HTMLButtonElement>("[data-write-image-add]");
  const imageList = query<HTMLUListElement>("[data-write-image-list]");
  const articleList = query<HTMLUListElement>("[data-write-article-list]");
  const refreshButton = query<HTMLButtonElement>("[data-write-refresh]");
  const momentContentInput = query<HTMLTextAreaElement>(
    "[data-write-moment-content]",
  );
  const momentTagsInput = query<HTMLInputElement>("[data-write-moment-tags]");
  const momentPublishButton = query<HTMLButtonElement>(
    "[data-write-moment-publish]",
  );
  const momentImageAddButton = query<HTMLButtonElement>(
    "[data-write-moment-image-add]",
  );
  const momentImageInput = query<HTMLInputElement>(
    "[data-write-moment-image-input]",
  );
  const momentImageList = query<HTMLUListElement>(
    "[data-write-moment-image-list]",
  );
  const tabButtons = Array.from(
    root.querySelectorAll<HTMLButtonElement>("[data-write-tab]"),
  );
  const panels = Array.from(
    root.querySelectorAll<HTMLElement>("[data-write-panel]"),
  );

  const field = <T extends HTMLElement>(name: string) =>
    root.querySelector<T>(`[data-write-field="${name}"]`);
  const titleInput = field<HTMLInputElement>("title");
  const slugInput = field<HTMLInputElement>("slug");
  const archiveDirInput = field<HTMLInputElement>("archiveDir");
  const createdAtInput = field<HTMLInputElement>("createdAt");
  const typeInput = field<HTMLInputElement>("type");
  const formatSelect = field<HTMLSelectElement>("fileFormat");
  const descriptionInput = field<HTMLTextAreaElement>("description");
  const coverInput = field<HTMLInputElement>("cover");
  const publishedInput = field<HTMLInputElement>("published");
  const bodyInput = field<HTMLTextAreaElement>("body");

  if (!form || !bodyInput || !titleInput || !slugInput) return;

  let images: LocalImage[] = [];
  let momentImages: LocalImage[] = [];
  let mode: "create" | "edit" = "create";
  let originalPath: string | undefined;
  let pendingDeletePath: string | null = null;
  let busy = false;

  // ---------- 状态与面板切换 ----------

  const setStatus = (message: string, kind: StatusKind = "info") => {
    if (!statusLine) return;
    statusLine.textContent = message;
    statusLine.dataset.kind = kind;
  };

  const setBusy = (value: boolean) => {
    busy = value;
    if (publishButton) publishButton.disabled = value;
    if (refreshButton) refreshButton.disabled = value;
    if (momentPublishButton) momentPublishButton.disabled = value;
  };

  const refreshAuthView = async () => {
    const authed = await hasAuth(publishConfig.encryptKey);
    authPanel?.toggleAttribute("hidden", authed);
    editorPanel?.toggleAttribute("hidden", !authed);
    logoutButton?.toggleAttribute("hidden", !authed);
  };

  const switchTab = (name: string) => {
    for (const button of tabButtons) {
      button.classList.toggle("is-active", button.dataset.writeTab === name);
    }
    for (const panel of panels) {
      panel.toggleAttribute("hidden", panel.dataset.writePanel !== name);
    }
    if (name === "manage" && articleList && !articleList.childElementCount) {
      void refreshArticleList();
    }
  };

  // ---------- 表单 ----------

  const setPublishLabel = () => {
    if (publishButton) {
      publishButton.textContent =
        mode === "edit" ? "Update post" : "Publish post";
    }
  };

  const resetForm = () => {
    mode = "create";
    originalPath = undefined;
    images = [];
    form.reset();
    if (createdAtInput) createdAtInput.value = formatDateLocal();
    if (archiveDirInput) {
      archiveDirInput.value = writeConfig.content.defaultArchiveDir;
    }
    if (publishedInput) publishedInput.checked = true;
    renderImages();
    setPublishLabel();
    setStatus("Reset to a new post");
  };

  const buildForm = (): ArticleForm => {
    let cover = coverInput?.value.trim() || undefined;
    if (cover?.startsWith(localImagePlaceholder(""))) {
      cover = cover.slice(localImagePlaceholder("").length);
    }
    return {
      slug: slugInput.value.trim(),
      archiveDir: archiveDirInput?.value.trim() ?? "",
      fileFormat: formatSelect?.value === "mdx" ? "mdx" : "md",
      title: titleInput.value.trim(),
      description: descriptionInput?.value.trim() ?? "",
      createdAt: createdAtInput?.value.trim() || formatDateLocal(),
      type: typeInput?.value.trim() || undefined,
      published: publishedInput?.checked ?? true,
      cover,
      body: bodyInput.value,
    };
  };

  // ---------- 图片附件 ----------

  const insertAtCursor = (text: string) => {
    const start = bodyInput.selectionStart ?? bodyInput.value.length;
    const end = bodyInput.selectionEnd ?? start;
    bodyInput.value =
      bodyInput.value.slice(0, start) + text + bodyInput.value.slice(end);
    bodyInput.focus();
    bodyInput.selectionStart = bodyInput.selectionEnd = start + text.length;
  };

  const renderImages = () => {
    if (!imageList) return;
    imageList.textContent = "";
    for (const image of images) {
      const item = document.createElement("li");
      item.className = "write-image-item";

      const name = document.createElement("span");
      name.className = "write-image-item__name";
      name.textContent = image.file.name;

      const insertButton = document.createElement("button");
      insertButton.type = "button";
      insertButton.textContent = "Insert";
      insertButton.addEventListener(
        "click",
        () => insertAtCursor(`![](${localImagePlaceholder(image.id)})`),
        { signal },
      );

      const coverButton = document.createElement("button");
      coverButton.type = "button";
      coverButton.textContent = "Use as cover";
      coverButton.addEventListener(
        "click",
        () => {
          if (coverInput) coverInput.value = localImagePlaceholder(image.id);
          setStatus(`Cover set to ${image.file.name}`);
        },
        { signal },
      );

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

      item.append(name, insertButton, coverButton, removeButton);
      imageList.append(item);
    }
  };

  const renderMomentImages = () => {
    if (!momentImageList) return;
    momentImageList.textContent = "";
    for (const image of momentImages) {
      const item = document.createElement("li");
      item.className = "write-image-item";

      const name = document.createElement("span");
      name.className = "write-image-item__name";
      name.textContent = image.file.name;

      const removeButton = document.createElement("button");
      removeButton.type = "button";
      removeButton.textContent = "Remove";
      removeButton.addEventListener(
        "click",
        () => {
          momentImages = momentImages.filter((entry) => entry.id !== image.id);
          renderMomentImages();
        },
        { signal },
      );

      item.append(name, removeButton);
      momentImageList.append(item);
    }
  };

  // ---------- 文章管理 ----------

  const fillFormFromArticle = (
    path: string,
    data: Record<string, string | boolean | string[]>,
    body: string,
  ) => {
    const filename = path.split("/").pop() || "";
    const extension = /\.mdx$/i.test(filename) ? "mdx" : "md";
    const fileSlug = filename.replace(/\.(md|mdx)$/i, "");
    const relative = path.startsWith(`${publishConfig.contentDir}/`)
      ? path.slice(publishConfig.contentDir.length + 1)
      : path;
    const dirParts = relative.split("/").slice(0, -1);

    titleInput.value = typeof data.title === "string" ? data.title : "";
    slugInput.value =
      typeof data.routeSlug === "string" && data.routeSlug
        ? data.routeSlug
        : fileSlug;
    if (archiveDirInput) archiveDirInput.value = dirParts.join("/");
    if (createdAtInput) {
      createdAtInput.value =
        typeof data.createdAt === "string" ? data.createdAt.slice(0, 10) : "";
    }
    if (typeInput)
      typeInput.value = typeof data.type === "string" ? data.type : "";
    if (formatSelect) formatSelect.value = extension;
    if (descriptionInput) {
      descriptionInput.value =
        typeof data.description === "string" ? data.description : "";
    }
    if (coverInput) {
      coverInput.value = typeof data.image === "string" ? data.image : "";
    }
    if (publishedInput) publishedInput.checked = data.published !== false;
    bodyInput.value = body;

    mode = "edit";
    originalPath = path;
    images = [];
    renderImages();
    setPublishLabel();
  };

  const refreshArticleList = async () => {
    if (!articleList) return;
    setBusy(true);
    setStatus("Loading posts...");
    try {
      const items = await listArticles(publishConfig);
      articleList.textContent = "";
      pendingDeletePath = null;

      for (const item of items) {
        const listItem = document.createElement("li");
        listItem.className = "write-article-item";

        const name = document.createElement("span");
        name.className = "write-article-item__name";
        name.textContent = item.archiveDir
          ? `${item.archiveDir}/${item.name}`
          : item.name;

        const editButton = document.createElement("button");
        editButton.type = "button";
        editButton.textContent = "Edit";
        editButton.addEventListener(
          "click",
          async () => {
            setBusy(true);
            setStatus(`Loading ${item.name} ...`);
            try {
              const article = await loadArticle(publishConfig, item.path);
              fillFormFromArticle(article.path, article.data, article.body);
              switchTab("edit");
              setStatus(`Loaded ${item.name} — ready to edit`, "ok");
            } catch (error) {
              handleError(error);
            } finally {
              setBusy(false);
            }
          },
          { signal },
        );

        const deleteButton = document.createElement("button");
        deleteButton.type = "button";
        deleteButton.textContent = "Delete";
        deleteButton.addEventListener(
          "click",
          async () => {
            if (pendingDeletePath !== item.path) {
              pendingDeletePath = item.path;
              deleteButton.textContent = "Confirm?";
              setStatus(`Click again to confirm deleting ${item.name}`);
              return;
            }
            setBusy(true);
            try {
              await deleteArticle(publishConfig, item.path, (message) =>
                setStatus(message),
              );
              setStatus(`Deleted ${item.name}`, "ok");
              await refreshArticleList();
            } catch (error) {
              handleError(error);
            } finally {
              setBusy(false);
            }
          },
          { signal },
        );

        listItem.append(name, editButton, deleteButton);
        articleList.append(listItem);
      }

      setStatus(`${items.length} posts found`, "ok");
    } catch (error) {
      handleError(error);
    } finally {
      setBusy(false);
    }
  };

  // ---------- 错误处理 ----------

  const handleError = (error: unknown) => {
    console.error(error);
    if (error instanceof GitHubApiError && error.isAuthError) {
      clearCachedToken();
      setStatus(
        "Authorization expired or the key is invalid — try again, or re-import the key",
        "error",
      );
      void refreshAuthView();
      return;
    }
    if (error instanceof GitHubApiError && error.isUnprocessable) {
      setStatus("Too many requests or a conflict — try again shortly", "error");
      return;
    }
    setStatus(
      error instanceof Error ? error.message : "An unknown error occurred",
      "error",
    );
  };

  // ---------- 事件绑定 ----------

  const savePemText = async (pem: string) => {
    if (!pem.includes("PRIVATE KEY")) {
      setStatus("Invalid key: paste a complete PEM private key", "error");
      return;
    }
    await savePem(pem, publishConfig.encryptKey);
    if (pemInput) pemInput.value = "";
    await refreshAuthView();
    setStatus("Key saved (kept for this session only)", "ok");
  };

  authSaveButton?.addEventListener(
    "click",
    () => void savePemText(pemInput?.value.trim() || ""),
    { signal },
  );

  pemImportButton?.addEventListener("click", () => pemFileInput?.click(), {
    signal,
  });

  pemFileInput?.addEventListener(
    "change",
    async () => {
      const file = pemFileInput.files?.[0];
      pemFileInput.value = "";
      if (!file) return;
      try {
        await savePemText((await file.text()).trim());
      } catch (error) {
        handleError(error);
      }
    },
    { signal },
  );

  logoutButton?.addEventListener(
    "click",
    async () => {
      clearAuth();
      await refreshAuthView();
      setStatus("Signed out; the local key has been cleared");
    },
    { signal },
  );

  for (const button of tabButtons) {
    button.addEventListener(
      "click",
      () => switchTab(button.dataset.writeTab || "edit"),
      { signal },
    );
  }

  titleInput.addEventListener(
    "blur",
    () => {
      if (!slugInput.value.trim() && titleInput.value.trim()) {
        slugInput.value = slugifyCategoryLabel(titleInput.value);
      }
    },
    { signal },
  );

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

  resetButton?.addEventListener("click", resetForm, { signal });

  refreshButton?.addEventListener("click", () => void refreshArticleList(), {
    signal,
  });

  form.addEventListener(
    "submit",
    async (event) => {
      event.preventDefault();
      if (busy) return;
      setBusy(true);
      try {
        await publishArticle({
          config: publishConfig,
          form: buildForm(),
          images,
          mode,
          originalPath,
          onProgress: (message) => setStatus(message),
        });
        setStatus(
          mode === "edit"
            ? "Updated! GitHub Actions is deploying"
            : "Published! GitHub Actions is deploying",
          "ok",
        );
        if (mode === "create") resetForm();
      } catch (error) {
        handleError(error);
      } finally {
        setBusy(false);
      }
    },
    { signal },
  );

  // ---------- 瞬间发布 ----------

  momentImageAddButton?.addEventListener(
    "click",
    () => momentImageInput?.click(),
    { signal },
  );

  momentImageInput?.addEventListener(
    "change",
    () => {
      for (const file of Array.from(momentImageInput.files || [])) {
        momentImages.push({ id: crypto.randomUUID(), file });
      }
      momentImageInput.value = "";
      renderMomentImages();
    },
    { signal },
  );

  momentPublishButton?.addEventListener(
    "click",
    async () => {
      if (busy) return;
      setBusy(true);
      try {
        const tags = (momentTagsInput?.value || "")
          .split(/[,，]/)
          .map((tag) => tag.trim())
          .filter(Boolean);
        await publishMoment(
          momentsConfig,
          {
            content: momentContentInput?.value ?? "",
            tags,
            images: momentImages,
          },
          (message) => setStatus(message),
        );
        if (momentContentInput) momentContentInput.value = "";
        if (momentTagsInput) momentTagsInput.value = "";
        momentImages = [];
        renderMomentImages();
        setStatus(
          "Moment posted! It will appear after the site redeploys",
          "ok",
        );
      } catch (error) {
        handleError(error);
      } finally {
        setBusy(false);
      }
    },
    { signal },
  );

  // ---------- 初始化 ----------

  if (createdAtInput && !createdAtInput.value) {
    createdAtInput.value = formatDateLocal();
  }
  if (archiveDirInput && !archiveDirInput.value) {
    archiveDirInput.value = writeConfig.content.defaultArchiveDir;
  }
  setPublishLabel();
  void refreshAuthView();
}
