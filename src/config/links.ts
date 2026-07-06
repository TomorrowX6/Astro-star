export interface FriendLinkItem {
  name: string;
  description: string;
  href: string;
  avatarSrc: string;
}

export interface LostLinkItem {
  name: string;
  description: string;
  href: string;
}

export interface LinkApplyOwner {
  name: string;
  description: string;
  href: string;
  avatarSrc: string;
}

export const linkApplyOwner = {
  name: "AzusaMoe",
  description: "Day before yesterday I saw a rabbit, and yesterday a deer, and today, you.",
  href: "https://000.moe",
  avatarSrc: "https://blog.000.moe/avatar.png",
} satisfies LinkApplyOwner;

export const friendLinks = [
  {
    name: "Ethan",
    description: "Astro-star template user's personal site.",
    href: "https://hanlife02.com",
    avatarSrc: "https://hanlife02.com/avatar.svg",
  },
  {
    name: "KoBariDev",
    description: "Ciallo～(∠・ω<)⌒★",
    href: "https://hub.131714.xyz",
    avatarSrc: "https://hub.131714.xyz/profile.png",
  },
] satisfies readonly FriendLinkItem[];

export const lostLinks = [
  {
    name: "Example Offline Site",
    description: "A placeholder entry for links that are temporarily offline.",
    href: "https://example.com/offline",
  },
] satisfies readonly LostLinkItem[];
