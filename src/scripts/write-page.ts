/**
 * /write 页面控制器：认证门、文章表单、瞬间发布、图片附件、文章管理列表。
 *
 * 正文与瞬间使用 Toast UI Editor（所见即所得，输出仍为 Markdown）。
 * Archive folder（当前年份）与 Created date（今天）自动生成，不再展示；
 * 编辑已有文章时保留其原目录、日期、description 与 published 状态。
 */

import Editor from "@toast-ui/editor";
import "@toast-ui/editor/dist/toastui-editor.css";
import "@toast-ui/editor/dist/theme/toastui-editor-dark.css";

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

type WriteDraft = {
  version: 1;
  activePanel: "edit" | "moment" | "manage";
  mode: "create" | "edit";
  originalPath?: string;
  editArchiveDir: string;
  editCreatedAt: string;
  editDescription: string;
  editPublished: boolean;
  title: string;
  slug: string;
  type: string;
  fileFormat: "md" | "mdx";
  cover: string;
  body: string;
  momentBody: string;
  momentTags: string[];
  momentTagsInput: string;
};

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

function getDraftStorageKey(config: WritePublishConfig): string {
  return [
    "write_draft_v1",
    config.owner,
    config.repo,
    config.branch,
    config.contentDir,
  ]
    .map(encodeURIComponent)
    .join(":");
}

function readStoredValue(key: string): string | null {
  for (const storage of [globalThis.localStorage, globalThis.sessionStorage]) {
    try {
      const value = storage?.getItem(key);
      if (value !== null && value !== undefined) return value;
    } catch {
      // Ignore storage failures and fall back to the next store.
    }
  }
  return null;
}

function writeStoredValue(key: string, value: string): void {
  let wrote = false;
  for (const storage of [globalThis.localStorage, globalThis.sessionStorage]) {
    try {
      storage?.setItem(key, value);
      wrote = true;
    } catch {
      // Ignore storage failures; the other store may still work.
    }
  }
  if (!wrote) {
    // Silently degrade when storage is unavailable.
  }
}

function removeStoredValue(key: string): void {
  for (const storage of [globalThis.localStorage, globalThis.sessionStorage]) {
    try {
      storage?.removeItem(key);
    } catch {
      // Ignore storage failures.
    }
  }
}

function createEditor(
  element: HTMLElement,
  height: string,
  onImageAdd: (file: File) => string,
) {
  return new Editor({
    el: element,
    height,
    initialEditType: "wysiwyg",
    previewStyle: "tab",
    usageStatistics: false,
    autofocus: false,
    theme: document.documentElement.dataset.theme === "dark" ? "dark" : "light",
    hooks: {
      // 工具栏插图/粘贴/拖拽的图片都进入上传管线，编辑器内先用本地预览
      addImageBlobHook: (blob, callback) => {
        callback(onImageAdd(blob), blob.name);
      },
    },
  });
}

export function initWritePage() {
  const root = document.querySelector<HTMLElement>("[data-write-root]");
  if (!root) return;

  const browserWindow = window as WritePageWindow;
  browserWindow.__writePageCleanup?.();

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
  const imageList = query<HTMLUListElement>("[data-write-image-list]");
  const articleList = query<HTMLUListElement>("[data-write-article-list]");
  const refreshButton = query<HTMLButtonElement>("[data-write-refresh]");
  const bodyEditorHost = query("[data-write-body-editor]");
  const momentEditorHost = query("[data-write-moment-editor]");
  const momentTagsInput = query<HTMLInputElement>("[data-write-moment-tags]");
  const momentTagsBox = query<HTMLElement>("[data-write-moment-tags-box]");
  const momentPublishButton = query<HTMLButtonElement>(
    "[data-write-moment-publish]",
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
  const typeInput = field<HTMLInputElement>("type");
  const formatSelect = field<HTMLSelectElement>("fileFormat");
  const coverInput = field<HTMLInputElement>("cover");

  if (!form || !titleInput || !slugInput || !bodyEditorHost) return;

  const controller = new AbortController();
  const { signal } = controller;

  // Toast UI 会把 height 写为宿主行内样式；拖拽 resize 时浏览器接管该行内高度
  const bodyEditor = createEditor(bodyEditorHost, "26rem", (file) => {
    const image: LocalImage = {
      id: crypto.randomUUID(),
      file,
      previewUrl: URL.createObjectURL(file),
    };
    images.push(image);
    renderImages();
    return image.previewUrl as string;
  });
  const momentEditor = momentEditorHost
    ? createEditor(momentEditorHost, "26rem", (file) => {
        const image: LocalImage = {
          id: crypto.randomUUID(),
          file,
          previewUrl: URL.createObjectURL(file),
        };
        momentImages.push(image);
        renderMomentImages();
        return image.previewUrl as string;
      })
    : null;

  browserWindow.__writePageCleanup = () => {
    controller.abort();
    // 路由切换后旧编辑器的 DOM 已被丢弃，destroy 可能抛错；
    // 必须吞掉，否则会中断下一次 initWritePage 的初始化
    try {
      bodyEditor.destroy();
    } catch {
      // ignore
    }
    try {
      momentEditor?.destroy();
    } catch {
      // ignore
    }
  };

  let images: LocalImage[] = [];
  let momentImages: LocalImage[] = [];
  let momentTags: string[] = [];
  let mode: "create" | "edit" = "create";
  let originalPath: string | undefined;
  // 编辑模式下保留原文章的隐藏字段，更新时原样写回
  let editArchiveDir = "";
  let editCreatedAt = "";
  let editDescription = "";
  let editPublished = true;
  let pendingDeletePath: string | null = null;
  let busy = false;
  let activePanel: "edit" | "moment" | "manage" = "edit";
  let draftSaveTimer: number | undefined;
  const draftStorageKey = getDraftStorageKey(publishConfig);

  const readDraft = (): WriteDraft | null => {
    const raw = readStoredValue(draftStorageKey);
    if (!raw) return null;
    try {
      const draft = JSON.parse(raw) as Partial<WriteDraft>;
      if (draft.version !== 1) return null;
      if (
        draft.activePanel !== "edit" &&
        draft.activePanel !== "moment" &&
        draft.activePanel !== "manage"
      ) {
        return null;
      }
      if (draft.mode !== "create" && draft.mode !== "edit") return null;
      return {
        version: 1,
        activePanel: draft.activePanel,
        mode: draft.mode,
        originalPath:
          typeof draft.originalPath === "string"
            ? draft.originalPath
            : undefined,
        editArchiveDir:
          typeof draft.editArchiveDir === "string" ? draft.editArchiveDir : "",
        editCreatedAt:
          typeof draft.editCreatedAt === "string" ? draft.editCreatedAt : "",
        editDescription:
          typeof draft.editDescription === "string"
            ? draft.editDescription
            : "",
        editPublished: draft.editPublished !== false,
        title: typeof draft.title === "string" ? draft.title : "",
        slug: typeof draft.slug === "string" ? draft.slug : "",
        type: typeof draft.type === "string" ? draft.type : "",
        fileFormat: draft.fileFormat === "mdx" ? "mdx" : "md",
        cover: typeof draft.cover === "string" ? draft.cover : "",
        body: typeof draft.body === "string" ? draft.body : "",
        momentBody:
          typeof draft.momentBody === "string" ? draft.momentBody : "",
        momentTags: Array.isArray(draft.momentTags)
          ? draft.momentTags.filter(
              (tag): tag is string => typeof tag === "string",
            )
          : [],
        momentTagsInput:
          typeof draft.momentTagsInput === "string"
            ? draft.momentTagsInput
            : "",
      };
    } catch {
      return null;
    }
  };

  const saveDraftNow = () => {
    const draft: WriteDraft = {
      version: 1,
      activePanel,
      mode,
      originalPath,
      editArchiveDir,
      editCreatedAt,
      editDescription,
      editPublished,
      title: titleInput.value,
      slug: slugInput.value,
      type: typeInput?.value || "",
      fileFormat: formatSelect?.value === "mdx" ? "mdx" : "md",
      cover: coverInput?.value || "",
      body: bodyEditor.getMarkdown(),
      momentBody: momentEditor?.getMarkdown() || "",
      momentTags: [...momentTags],
      momentTagsInput: momentTagsInput?.value || "",
    };
    writeStoredValue(draftStorageKey, JSON.stringify(draft));
  };

  const scheduleDraftSave = () => {
    if (draftSaveTimer) clearTimeout(draftSaveTimer);
    draftSaveTimer = window.setTimeout(() => {
      draftSaveTimer = undefined;
      saveDraftNow();
    }, 150);
  };

  const applyDraft = (draft: WriteDraft) => {
    activePanel = draft.activePanel;
    mode = draft.mode;
    originalPath = draft.originalPath;
    editArchiveDir = draft.editArchiveDir;
    editCreatedAt = draft.editCreatedAt;
    editDescription = draft.editDescription;
    editPublished = draft.editPublished;

    titleInput.value = draft.title;
    slugInput.value = draft.slug;
    if (typeInput) typeInput.value = draft.type;
    if (formatSelect) formatSelect.value = draft.fileFormat;
    if (coverInput) coverInput.value = draft.cover;

    bodyEditor.changeMode(
      draft.fileFormat === "mdx" ? "markdown" : "wysiwyg",
      true,
    );
    bodyEditor.setMarkdown(draft.body);

    if (momentEditor) {
      momentEditor.setMarkdown(draft.momentBody);
    }
    if (momentTagsInput) momentTagsInput.value = draft.momentTagsInput;
    momentTags = [...draft.momentTags];
    renderMomentTags();
    renderImages();
    setPublishLabel();
    switchTab(draft.activePanel);
  };

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
    activePanel = name === "moment" || name === "manage" ? name : "edit";
    for (const button of tabButtons) {
      button.classList.toggle(
        "is-active",
        button.dataset.writeTab === activePanel,
      );
    }
    for (const panel of panels) {
      panel.toggleAttribute("hidden", panel.dataset.writePanel !== activePanel);
    }
    scheduleDraftSave();
    if (
      activePanel === "manage" &&
      articleList &&
      !articleList.childElementCount
    ) {
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
    editArchiveDir = "";
    editCreatedAt = "";
    editDescription = "";
    editPublished = true;
    images = [];
    form.reset();
    bodyEditor.setMarkdown("");
    renderImages();
    setPublishLabel();
    setStatus("");
    saveDraftNow();
  };

  const buildForm = (): ArticleForm => {
    let cover = coverInput?.value.trim() || undefined;
    if (cover?.startsWith(localImagePlaceholder(""))) {
      cover = cover.slice(localImagePlaceholder("").length);
    }
    return {
      slug: slugInput.value.trim(),
      archiveDir:
        mode === "edit"
          ? editArchiveDir
          : writeConfig.content.defaultArchiveDir,
      fileFormat: formatSelect?.value === "mdx" ? "mdx" : "md",
      title: titleInput.value.trim(),
      description: editDescription,
      createdAt: mode === "edit" ? editCreatedAt : formatDateLocal(),
      type: typeInput?.value.trim() || undefined,
      published: editPublished,
      cover,
      body: bodyEditor.getMarkdown(),
    };
  };

  // ---------- 图片附件 ----------

  const renderImages = () => {
    if (!imageList) return;
    imageList.textContent = "";
    for (const image of images) {
      const item = document.createElement("li");
      item.className = "write-image-item";

      const name = document.createElement("span");
      name.className = "write-image-item__name";
      name.textContent = image.file.name;

      const coverButton = document.createElement("button");
      coverButton.type = "button";
      coverButton.textContent = "Use as cover";
      coverButton.addEventListener(
        "click",
        () => {
          if (coverInput) coverInput.value = localImagePlaceholder(image.id);
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

      item.append(name, coverButton, removeButton);
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

  // ---------- 瞬间标签（回车生成胶囊，可多个） ----------

  const renderMomentTags = () => {
    if (!momentTagsBox || !momentTagsInput) return;
    for (const chip of momentTagsBox.querySelectorAll(".write-tags__chip")) {
      chip.remove();
    }
    for (const tag of momentTags) {
      const chip = document.createElement("span");
      chip.className = "write-tags__chip";
      chip.textContent = tag;

      const removeButton = document.createElement("button");
      removeButton.type = "button";
      removeButton.className = "write-tags__remove";
      removeButton.setAttribute("aria-label", `Remove tag ${tag}`);
      removeButton.textContent = "×";
      removeButton.addEventListener(
        "click",
        () => {
          momentTags = momentTags.filter((entry) => entry !== tag);
          renderMomentTags();
        },
        { signal },
      );

      chip.append(removeButton);
      momentTagsBox.insertBefore(chip, momentTagsInput);
    }
    saveDraftNow();
  };

  const addMomentTag = (raw: string) => {
    const tag = raw.trim();
    if (!tag || momentTags.includes(tag)) return;
    momentTags.push(tag);
    renderMomentTags();
  };

  momentTagsInput?.addEventListener(
    "keydown",
    (event) => {
      if (event.key === "Enter" || event.key === "," || event.key === "、") {
        event.preventDefault();
        const tagInputValue = momentTagsInput.value;
        momentTagsInput.value = "";
        addMomentTag(tagInputValue);
        saveDraftNow();
        return;
      }
      if (event.key === "Backspace" && !momentTagsInput.value) {
        momentTags.pop();
        renderMomentTags();
      }
    },
    { signal },
  );

  momentTagsInput?.addEventListener(
    "blur",
    () => {
      if (momentTagsInput.value.trim()) {
        const tagInputValue = momentTagsInput.value;
        momentTagsInput.value = "";
        addMomentTag(tagInputValue);
        saveDraftNow();
      }
    },
    { signal },
  );

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
    if (typeInput)
      typeInput.value = typeof data.type === "string" ? data.type : "";
    if (formatSelect) formatSelect.value = extension;
    if (coverInput) {
      coverInput.value = typeof data.image === "string" ? data.image : "";
    }
    // MDX 的 JSX/指令语法会被 WYSIWYG 往返转换破坏，改用 Markdown 源码模式
    bodyEditor.changeMode(extension === "mdx" ? "markdown" : "wysiwyg", true);
    bodyEditor.setMarkdown(body);

    mode = "edit";
    originalPath = path;
    editArchiveDir = dirParts.join("/");
    editCreatedAt =
      typeof data.createdAt === "string" && data.createdAt
        ? data.createdAt
        : formatDateLocal();
    editDescription =
      typeof data.description === "string" ? data.description : "";
    editPublished = data.published !== false;
    images = [];
    renderImages();
    setPublishLabel();
    activePanel = "edit";
    saveDraftNow();
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
              setStatus("");
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
              setStatus("");
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

      setStatus("");
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

  const initialDraft = readDraft();
  if (initialDraft) {
    applyDraft(initialDraft);
  }

  const savePemText = async (pem: string) => {
    if (!pem.includes("PRIVATE KEY")) {
      setStatus("Invalid key: paste a complete PEM private key", "error");
      return;
    }
    await savePem(pem, publishConfig.encryptKey);
    if (pemInput) pemInput.value = "";
    await refreshAuthView();
    setStatus("");
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
      setStatus("");
    },
    { signal },
  );

  bodyEditor.on("change", scheduleDraftSave);
  momentEditor?.on("change", scheduleDraftSave);

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
        scheduleDraftSave();
      }
    },
    { signal },
  );

  // 选择 MDX 格式时切到 Markdown 源码模式，避免 WYSIWYG 破坏 MDX 语法
  formatSelect?.addEventListener(
    "change",
    () => {
      bodyEditor.changeMode(
        formatSelect.value === "mdx" ? "markdown" : "wysiwyg",
        true,
      );
      scheduleDraftSave();
    },
    { signal },
  );

  form.addEventListener("input", scheduleDraftSave, { signal });
  momentTagsInput?.addEventListener("input", scheduleDraftSave, { signal });
  browserWindow.addEventListener("pagehide", saveDraftNow, { signal });
  browserWindow.addEventListener("beforeunload", saveDraftNow, { signal });

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

  momentPublishButton?.addEventListener(
    "click",
    async () => {
      if (busy || !momentEditor) return;
      setBusy(true);
      try {
        if (momentTagsInput?.value.trim()) {
          addMomentTag(momentTagsInput.value);
          momentTagsInput.value = "";
        }
        const tags = [...momentTags];
        await publishMoment(
          momentsConfig,
          {
            content: momentEditor.getMarkdown(),
            tags,
            images: momentImages,
          },
          (message) => setStatus(message),
        );
        momentEditor.setMarkdown("");
        if (momentTagsInput) momentTagsInput.value = "";
        momentTags = [];
        renderMomentTags();
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

  setPublishLabel();
  void refreshAuthView();
}
