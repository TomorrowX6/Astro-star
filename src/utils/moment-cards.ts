/**
 * 瞬间链接卡片（构建期，仅服务端）：
 * 从瞬间正文中提取受支持平台的链接（Bangumi / bilibili / GitHub /
 * Steam / 网易云音乐 / 豆瓣 / IMDb / YouTube），在构建时调用各平台
 * 公开 API（豆瓣、IMDb 解析页面内嵌的 schema.org ld+json）拉取元数据，
 * 归一化为统一的 MomentCardData 供 MomentLinkCard.astro 渲染。
 *
 * 链接从正文中移除，卡片渲染在正文之后；API 失败时降级为
 * 只含链接本身的极简卡片，构建不会因此失败。
 */

export type MomentCardData = {
  url: string;
  /** 平台徽标文字，如 "Bangumi" / "bilibili" */
  site: string;
  title: string;
  subtitle?: string;
  description?: string;
  cover?: string;
  /** 元信息（评分、播放量、价格等），已格式化为展示文本 */
  metas: string[];
};

type CardMatcher = {
  site: string;
  /** 匹配裸链接或 [text](url) 形式；捕获组 1 为链接本身 */
  pattern: RegExp;
  resolve: (url: string) => Promise<MomentCardData | null>;
};

const FETCH_TIMEOUT_MS = 10_000;
const USER_AGENT = "TomorrowX6/Astro-star (moment cards; https://blog.000.moe)";
/** 豆瓣 / IMDb 的页面抓取需要浏览器 UA，否则会被反爬拦截 */
const BROWSER_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
/** 豆瓣移动端 rexxar API 需要移动端 UA */
const MOBILE_USER_AGENT =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";

async function fetchJson(
  url: string,
  headers: Record<string, string> = {},
): Promise<unknown> {
  const response = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${url}`);
  }
  return response.json();
}

/**
 * 抓取页面并解析内嵌的 schema.org ld+json（豆瓣 / IMDb 均无公开 API）。
 * 豆瓣的 ld+json 字符串里常含未转义的控制字符，解析前先清洗。
 */
async function fetchLdJson(
  url: string,
  headers: Record<string, string> = {},
): Promise<Record<string, unknown> | null> {
  const response = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${url}`);
  }
  const html = await response.text();

  for (const match of html.matchAll(
    /<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi,
  )) {
    try {
      const parsed = JSON.parse(
        match[1].replace(/[\u0000-\u001F]+/g, " "),
      ) as Record<string, unknown>;
      if (typeof parsed.name === "string" && parsed.name) return parsed;
    } catch {
      // 尝试下一个 ld+json 块
    }
  }
  return null;
}

/** ld+json 里的人员字段（director/author 等）取名字列表 */
function ldNames(value: unknown, limit = 3): string {
  if (!Array.isArray(value)) return "";
  return value
    .map((item) =>
      item && typeof item === "object" && "name" in item
        ? String((item as { name: unknown }).name || "")
        : "",
    )
    .filter(Boolean)
    .slice(0, limit)
    .join(" / ");
}

/** ISO 8601 时长（PT2H22M）→ "2h 22m" */
function formatIsoDuration(value: string): string {
  const match = value.match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/i);
  if (!match) return "";
  const [, hours, minutes, seconds] = match;
  const parts: string[] = [];
  if (hours) parts.push(`${hours}h`);
  if (minutes) parts.push(`${minutes}m`);
  if (!hours && !minutes && seconds) parts.push(`${seconds}s`);
  return parts.join(" ");
}

function formatCount(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
}

function formatSeconds(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = Math.floor(totalSeconds % 60);
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

// ---------- Bangumi ----------

const BANGUMI_TYPE_LABELS: Record<number, string> = {
  1: "Book",
  2: "Anime",
  3: "Music",
  4: "Game",
  6: "Real",
};

type BangumiSubject = {
  name?: string;
  name_cn?: string;
  summary?: string;
  date?: string;
  eps?: number;
  type?: number;
  images?: { common?: string; large?: string };
  rating?: { score?: number; total?: number };
};

async function resolveBangumi(url: string): Promise<MomentCardData | null> {
  const id = url.match(/(?:bgm|bangumi)\.tv\/subject\/(\d+)/i)?.[1];
  if (!id) return null;

  // Bangumi API 要求携带能标识调用方的 User-Agent
  const subject = (await fetchJson(`https://api.bgm.tv/v0/subjects/${id}`, {
    "User-Agent": USER_AGENT,
  })) as BangumiSubject;
  if (!subject.name && !subject.name_cn) return null;

  const metas: string[] = [];
  if (subject.rating?.score) {
    metas.push(
      `★ ${subject.rating.score.toFixed(1)} (${subject.rating.total ?? 0})`,
    );
  }
  const typeLabel = subject.type
    ? BANGUMI_TYPE_LABELS[subject.type]
    : undefined;
  if (typeLabel) metas.push(typeLabel);
  if (subject.date) metas.push(subject.date);
  if (subject.eps) metas.push(`${subject.eps} eps`);

  return {
    url: `https://bgm.tv/subject/${id}`,
    site: "Bangumi",
    title: subject.name_cn || subject.name || "",
    subtitle: subject.name_cn ? subject.name : undefined,
    description: subject.summary || undefined,
    cover: subject.images?.common || subject.images?.large,
    metas,
  };
}

// ---------- bilibili ----------

type BilibiliView = {
  code?: number;
  data?: {
    title?: string;
    pic?: string;
    duration?: number;
    owner?: { name?: string };
    stat?: { view?: number; danmaku?: number };
  };
};

async function resolveBilibili(url: string): Promise<MomentCardData | null> {
  const id = url.match(/bilibili\.com\/video\/(BV[0-9A-Za-z]+|av\d+)/i)?.[1];
  if (!id) return null;

  const query = id.toLowerCase().startsWith("av")
    ? `aid=${id.slice(2)}`
    : `bvid=${id}`;
  const payload = (await fetchJson(
    `https://api.bilibili.com/x/web-interface/view?${query}`,
    { "User-Agent": USER_AGENT, Referer: "https://www.bilibili.com/" },
  )) as BilibiliView;
  const video = payload.code === 0 ? payload.data : undefined;
  if (!video?.title) return null;

  const metas: string[] = [];
  if (video.stat?.view) metas.push(`▶ ${formatCount(video.stat.view)}`);
  if (video.stat?.danmaku) metas.push(`💬 ${formatCount(video.stat.danmaku)}`);
  if (video.duration) metas.push(formatSeconds(video.duration));

  return {
    url: `https://www.bilibili.com/video/${id}`,
    site: "bilibili",
    title: video.title,
    subtitle: video.owner?.name,
    cover: video.pic,
    metas,
  };
}

// ---------- GitHub ----------

type GitHubRepo = {
  full_name?: string;
  description?: string | null;
  language?: string | null;
  stargazers_count?: number;
  forks_count?: number;
  html_url?: string;
};

async function resolveGitHub(url: string): Promise<MomentCardData | null> {
  const match = url.match(
    /github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/i,
  );
  if (!match) return null;
  const [, owner, repo] = match;

  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": USER_AGENT,
  };
  // CI 构建时用 GITHUB_TOKEN 提高速率限制
  const token =
    typeof process !== "undefined" ? process.env.GITHUB_TOKEN : undefined;
  if (token) headers.Authorization = `Bearer ${token}`;

  const data = (await fetchJson(
    `https://api.github.com/repos/${owner}/${repo}`,
    headers,
  )) as GitHubRepo;
  if (!data.full_name) return null;

  const metas: string[] = [];
  if (typeof data.stargazers_count === "number") {
    metas.push(`★ ${formatCount(data.stargazers_count)}`);
  }
  if (typeof data.forks_count === "number") {
    metas.push(`⑂ ${formatCount(data.forks_count)}`);
  }
  if (data.language) metas.push(data.language);

  return {
    url: data.html_url || url,
    site: "GitHub",
    title: data.full_name,
    description: data.description || undefined,
    metas,
  };
}

// ---------- Steam ----------

type SteamAppDetails = Record<
  string,
  {
    success?: boolean;
    data?: {
      name?: string;
      short_description?: string;
      header_image?: string;
      is_free?: boolean;
      price_overview?: { final_formatted?: string; discount_percent?: number };
      genres?: Array<{ description?: string }>;
    };
  }
>;

async function resolveSteam(url: string): Promise<MomentCardData | null> {
  const appId = url.match(/store\.steampowered\.com\/app\/(\d+)/i)?.[1];
  if (!appId) return null;

  const payload = (await fetchJson(
    `https://store.steampowered.com/api/appdetails?appids=${appId}&l=schinese&cc=cn`,
    { "User-Agent": USER_AGENT },
  )) as SteamAppDetails;
  const app = payload[appId]?.success ? payload[appId].data : undefined;
  if (!app?.name) return null;

  const metas: string[] = [];
  if (app.is_free) {
    metas.push("Free to Play");
  } else if (app.price_overview?.final_formatted) {
    const discount = app.price_overview.discount_percent;
    metas.push(
      discount
        ? `${app.price_overview.final_formatted} (-${discount}%)`
        : app.price_overview.final_formatted,
    );
  }
  const genres = (app.genres ?? [])
    .map((genre) => genre.description)
    .filter((genre): genre is string => Boolean(genre))
    .slice(0, 3);
  if (genres.length > 0) metas.push(genres.join(" / "));

  return {
    url: `https://store.steampowered.com/app/${appId}/`,
    site: "Steam",
    title: app.name,
    description: app.short_description || undefined,
    cover: app.header_image,
    metas,
  };
}

// ---------- 网易云音乐 ----------

type NeteaseSongDetail = {
  songs?: Array<{
    name?: string;
    duration?: number;
    artists?: Array<{ name?: string }>;
    album?: { name?: string; picUrl?: string };
  }>;
};

async function resolveNetease(url: string): Promise<MomentCardData | null> {
  const id = url.match(/music\.163\.com\/\S*?[?&]id=(\d+)/i)?.[1];
  if (!id) return null;

  const payload = (await fetchJson(
    `https://music.163.com/api/song/detail/?id=${id}&ids=[${id}]`,
    { "User-Agent": USER_AGENT, Referer: "https://music.163.com/" },
  )) as NeteaseSongDetail;
  const song = payload.songs?.[0];
  if (!song?.name) return null;

  const artists = (song.artists ?? [])
    .map((artist) => artist.name)
    .filter((name): name is string => Boolean(name))
    .join(" / ");
  const subtitleParts = [artists, song.album?.name].filter(Boolean);

  return {
    url: `https://music.163.com/#/song?id=${id}`,
    site: "NetEase Music",
    title: song.name,
    subtitle: subtitleParts.join(" · ") || undefined,
    cover: song.album?.picUrl,
    metas: song.duration ? [formatSeconds(song.duration / 1000)] : [],
  };
}

// ---------- 豆瓣（电影 / 读书 / 音乐） ----------

const DOUBAN_TYPE_LABELS: Record<string, string> = {
  movie: "Movie",
  book: "Book",
  music: "Music",
};

type LdAggregateRating = { ratingValue?: unknown; ratingCount?: unknown };

type DoubanRexxarSubject = {
  title?: string;
  card_subtitle?: string;
  intro?: string;
  year?: string | number;
  pic?: { normal?: string; large?: string };
  rating?: { value?: number; count?: number };
};

async function resolveDouban(url: string): Promise<MomentCardData | null> {
  const match = url.match(/(movie|book|music)\.douban\.com\/subject\/(\d+)/i);
  if (!match) return null;
  const section = match[1].toLowerCase();
  const id = match[2];
  const subjectUrl = `https://${section}.douban.com/subject/${id}/`;
  const typeLabel = DOUBAN_TYPE_LABELS[section];

  // 首选移动端 rexxar API（支持 movie/book；电影桌面站有反爬页拦截）
  try {
    const data = (await fetchJson(
      `https://m.douban.com/rexxar/api/v2/${section}/${id}`,
      { "User-Agent": MOBILE_USER_AGENT, Referer: "https://m.douban.com/" },
    )) as DoubanRexxarSubject;
    if (data.title) {
      const metas: string[] = [];
      const score = Number(data.rating?.value);
      if (score > 0) {
        const count = Number(data.rating?.count);
        metas.push(
          `★ ${score.toFixed(1)}${count > 0 ? ` (${formatCount(count)})` : ""}`,
        );
      }
      if (typeLabel) metas.push(typeLabel);
      if (data.year) metas.push(String(data.year));

      return {
        url: subjectUrl,
        site: "Douban",
        title: data.title,
        subtitle: data.card_subtitle || undefined,
        description: data.intro || undefined,
        cover: data.pic?.normal || data.pic?.large,
        metas,
      };
    }
  } catch {
    // 回退到桌面站 ld+json（music 没有 rexxar 接口）
  }

  const data = await fetchLdJson(subjectUrl, {
    "User-Agent": BROWSER_USER_AGENT,
    Referer: "https://www.douban.com/",
  });
  if (!data) return null;

  const metas: string[] = [];
  const rating = data.aggregateRating as LdAggregateRating | undefined;
  const score = Number(rating?.ratingValue);
  if (score > 0) {
    const count = Number(rating?.ratingCount);
    metas.push(`★ ${score.toFixed(1)}${count > 0 ? ` (${count})` : ""}`);
  }
  if (typeLabel) metas.push(typeLabel);
  if (typeof data.datePublished === "string" && data.datePublished) {
    metas.push(data.datePublished);
  }

  const people =
    ldNames(data.director) || ldNames(data.author) || ldNames(data.byArtist);

  return {
    url: subjectUrl,
    site: "Douban",
    title: String(data.name),
    subtitle: people || undefined,
    description:
      typeof data.description === "string" && data.description
        ? data.description
        : undefined,
    cover: typeof data.image === "string" ? data.image : undefined,
    metas,
  };
}

// ---------- IMDb ----------

type ImdbSuggestion = {
  d?: Array<{
    id?: string;
    l?: string;
    y?: number;
    s?: string;
    i?: { imageUrl?: string };
  }>;
};

async function resolveImdb(url: string): Promise<MomentCardData | null> {
  const id = url.match(/imdb\.com\/title\/(tt\d+)/i)?.[1];
  if (!id) return null;
  const titleUrl = `https://www.imdb.com/title/${id}/`;

  // 首选条目页 ld+json（含评分/时长/类型）
  try {
    const data = await fetchLdJson(titleUrl, {
      "User-Agent": BROWSER_USER_AGENT,
      "Accept-Language": "en-US,en;q=0.9",
    });
    if (data) {
      const metas: string[] = [];
      const rating = data.aggregateRating as LdAggregateRating | undefined;
      const score = Number(rating?.ratingValue);
      if (score > 0) {
        const count = Number(rating?.ratingCount);
        metas.push(
          `★ ${score.toFixed(1)}${count > 0 ? ` (${formatCount(count)})` : ""}`,
        );
      }
      if (typeof data.datePublished === "string" && data.datePublished) {
        metas.push(data.datePublished.slice(0, 4));
      }
      const genres = Array.isArray(data.genre)
        ? data.genre.filter((g): g is string => typeof g === "string")
        : [];
      if (genres.length > 0) metas.push(genres.slice(0, 3).join(" / "));
      if (typeof data.duration === "string") {
        const duration = formatIsoDuration(data.duration);
        if (duration) metas.push(duration);
      }

      return {
        url: titleUrl,
        site: "IMDb",
        title: String(data.name),
        subtitle:
          typeof data.alternateName === "string" && data.alternateName
            ? data.alternateName
            : undefined,
        description:
          typeof data.description === "string" && data.description
            ? data.description
            : undefined,
        cover: typeof data.image === "string" ? data.image : undefined,
        metas,
      };
    }
  } catch {
    // 页面抓取被拦截时退回 suggestion 接口
  }

  const payload = (await fetchJson(
    `https://v2.sg.media-imdb.com/suggestion/t/${id}.json`,
    { "User-Agent": USER_AGENT },
  )) as ImdbSuggestion;
  const item = payload.d?.find((entry) => entry.id === id) ?? payload.d?.[0];
  if (!item?.l) return null;

  return {
    url: titleUrl,
    site: "IMDb",
    title: item.l,
    subtitle: item.s || undefined,
    cover: item.i?.imageUrl,
    metas: item.y ? [String(item.y)] : [],
  };
}

// ---------- YouTube ----------

type YouTubeOembed = {
  title?: string;
  author_name?: string;
  thumbnail_url?: string;
};

async function resolveYouTube(url: string): Promise<MomentCardData | null> {
  const id = url.match(
    /(?:youtube\.com\/watch\?[^#\s]*?v=|youtu\.be\/)([\w-]{11})/i,
  )?.[1];
  if (!id) return null;
  const videoUrl = `https://www.youtube.com/watch?v=${id}`;

  // oEmbed 无需 API key
  const data = (await fetchJson(
    `https://www.youtube.com/oembed?url=${encodeURIComponent(videoUrl)}&format=json`,
    { "User-Agent": USER_AGENT },
  )) as YouTubeOembed;
  if (!data.title) return null;

  return {
    url: videoUrl,
    site: "YouTube",
    title: data.title,
    subtitle: data.author_name,
    cover: data.thumbnail_url,
    metas: [],
  };
}

// ---------- 提取与解析 ----------

/** 裸链接或 [text](url)；捕获组 1/2 之一为链接 */
function linkPattern(urlSource: string): RegExp {
  return new RegExp(
    `(?:\\[[^\\]]*\\]\\((${urlSource})\\)|(${urlSource}))`,
    "gi",
  );
}

const MATCHERS: CardMatcher[] = [
  {
    site: "Bangumi",
    pattern: linkPattern(
      String.raw`https?://(?:bgm|bangumi)\.tv/subject/\d+[^\s)]*`,
    ),
    resolve: resolveBangumi,
  },
  {
    site: "bilibili",
    pattern: linkPattern(
      String.raw`https?://(?:www\.)?bilibili\.com/video/(?:BV[0-9A-Za-z]+|av\d+)[^\s)]*`,
    ),
    resolve: resolveBilibili,
  },
  {
    site: "GitHub",
    // 只匹配仓库首页（owner/repo），不匹配 issues/PR 等子路径
    pattern: linkPattern(
      String.raw`https?://(?:www\.)?github\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+/?(?![^\s)])`,
    ),
    resolve: resolveGitHub,
  },
  {
    site: "Steam",
    pattern: linkPattern(
      String.raw`https?://store\.steampowered\.com/app/\d+[^\s)]*`,
    ),
    resolve: resolveSteam,
  },
  {
    site: "NetEase Music",
    pattern: linkPattern(
      String.raw`https?://(?:y\.)?music\.163\.com/[^\s)]*id=\d+[^\s)]*`,
    ),
    resolve: resolveNetease,
  },
  {
    site: "Douban",
    pattern: linkPattern(
      String.raw`https?://(?:movie|book|music)\.douban\.com/subject/\d+[^\s)]*`,
    ),
    resolve: resolveDouban,
  },
  {
    site: "IMDb",
    pattern: linkPattern(
      String.raw`https?://(?:www\.|m\.)?imdb\.com/title/tt\d+[^\s)]*`,
    ),
    resolve: resolveImdb,
  },
  {
    site: "YouTube",
    pattern: linkPattern(
      String.raw`https?://(?:(?:www\.|m\.)?youtube\.com/watch\?[^\s)]*?v=[\w-]{11}[^\s)]*|youtu\.be/[\w-]{11}[^\s)]*)`,
    ),
    resolve: resolveYouTube,
  },
];

/** 同一链接在多条瞬间/多次构建阶段中只请求一次 */
const cardCache = new Map<string, Promise<MomentCardData | null>>();

function resolveCard(matcher: CardMatcher, url: string) {
  let cached = cardCache.get(url);
  if (!cached) {
    cached = matcher.resolve(url).catch((error: unknown) => {
      console.warn(
        `[moment-cards] Failed to resolve ${url}:`,
        error instanceof Error ? error.message : error,
      );
      return null;
    });
    cardCache.set(url, cached);
  }
  return cached;
}

export type MomentCardsResult = {
  /** 移除卡片链接后的正文 */
  cleanedBody: string;
  cards: MomentCardData[];
};

export async function extractMomentCards(
  body: string,
): Promise<MomentCardsResult> {
  let cleanedBody = body;
  const pending: Array<Promise<MomentCardData | null>> = [];
  const fallbacks: MomentCardData[] = [];

  for (const matcher of MATCHERS) {
    matcher.pattern.lastIndex = 0;
    for (const match of body.matchAll(matcher.pattern)) {
      const url = match[1] || match[2];
      if (!url) continue;
      cleanedBody = cleanedBody.replace(match[0], "");
      pending.push(resolveCard(matcher, url));
      fallbacks.push({ url, site: matcher.site, title: url, metas: [] });
    }
  }

  const resolved = await Promise.all(pending);
  const cards = resolved.map((card, index) => card ?? fallbacks[index]);

  cleanedBody = cleanedBody.replace(/\n{3,}/g, "\n\n").trim();
  return { cleanedBody, cards };
}
