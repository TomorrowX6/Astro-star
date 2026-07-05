/**
 * 主页隐藏入口：在 1.5 秒内连续点击头像 3 次跳转到 /write。
 * 触发时头像播放旋转动画，随后经 ClientRouter 以路由过渡动画进入。
 * 页面上没有任何可见的写作入口，仅站长知晓。
 */

import { navigate } from "astro:transitions/client";

const CLICK_WINDOW_MS = 1500;
const CLICKS_REQUIRED = 3;
const SPIN_DURATION_MS = 520;

type HomeShellWriteEntranceWindow = Window & {
  __homeShellWriteEntranceCleanup?: () => void;
};

export function initHomeShellWriteEntrance() {
  const browserWindow = window as HomeShellWriteEntranceWindow;
  browserWindow.__homeShellWriteEntranceCleanup?.();

  const avatarWrap = document.querySelector<HTMLElement>(
    ".profile-avatar-wrap",
  );
  if (!avatarWrap) return;

  const controller = new AbortController();
  let spinTimer = 0;
  browserWindow.__homeShellWriteEntranceCleanup = () => {
    controller.abort();
    window.clearTimeout(spinTimer);
  };

  let clickTimes: number[] = [];
  let navigating = false;

  avatarWrap.addEventListener(
    "click",
    () => {
      if (navigating) return;
      const now = Date.now();
      clickTimes = clickTimes.filter((time) => now - time < CLICK_WINDOW_MS);
      clickTimes.push(now);
      if (clickTimes.length < CLICKS_REQUIRED) return;

      clickTimes = [];
      navigating = true;
      avatarWrap.classList.add("is-write-entrance");
      spinTimer = window.setTimeout(() => {
        avatarWrap.classList.remove("is-write-entrance");
        void navigate("/write/");
      }, SPIN_DURATION_MS);
    },
    { signal: controller.signal },
  );
}
