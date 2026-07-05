/**
 * 在线写作（/write）功能配置。
 *
 * 认证采用 GitHub App 私钥方案：私钥仅在浏览器内使用，不进入仓库与服务器。
 * 以下均为可公开的标识信息（owner / repo / App ID），通过 PUBLIC_ 环境变量
 * 在构建时注入，未配置时回退到仓库默认值。
 */

export const writeConfig = {
  github: {
    owner: import.meta.env.PUBLIC_GITHUB_OWNER || "TomorrowX6",
    repo: import.meta.env.PUBLIC_GITHUB_REPO || "Astro-star",
    branch: import.meta.env.PUBLIC_GITHUB_BRANCH || "main",
    /** GitHub App 的 App ID（非密钥）；未配置时 /write 页面会提示先完成配置 */
    appId: import.meta.env.PUBLIC_GITHUB_APP_ID || "",
    /** sessionStorage 中私钥的 AES-GCM 混淆密钥（防止明文落盘，非强安全边界） */
    encryptKey: import.meta.env.PUBLIC_WRITE_ENCRYPT_KEY || "astro-star-write",
  },
  content: {
    /** 文章 Markdown 所在目录（相对仓库根） */
    contentDir: "src/content/blog",
    /** 上传图片的存放目录（相对仓库根） */
    imagesDir: "public/images/blog",
    /** 图片在站点上的公开路径前缀 */
    imagesPublicBase: "/images/blog",
    /** 新文章默认归档子目录（对应归档页分组）；空字符串表示直接放在集合根目录 */
    defaultArchiveDir: String(new Date().getFullYear()),
  },
  moments: {
    /** 瞬间 Markdown 所在目录（相对仓库根） */
    contentDir: "src/content/moment",
    /** 瞬间图片的存放目录（相对仓库根） */
    imagesDir: "public/images/moments",
    /** 瞬间图片在站点上的公开路径前缀 */
    imagesPublicBase: "/images/moments",
  },
} as const;

export type WriteConfig = typeof writeConfig;
