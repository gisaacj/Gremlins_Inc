import { useEffect, useState } from 'react';

/**
 * 订阅一个媒体查询。
 *
 * 移动端布局不只是 CSS 的事：**侧栏在手机上必须变成抽屉**，
 * 这需要 JS 知道当前是不是窄屏，才能决定"侧栏是留在文档流里（桌面三栏）
 * 还是浮在棋盘上（手机抽屉）"。
 *
 * 用 `window.matchMedia` 而不是监听 resize，性能更好也更准
 * （能识别真正的原因：视口变窄、旋转屏幕、外接键盘收起…）。
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return false;
    return window.matchMedia(query).matches;
  });

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mql = window.matchMedia(query);
    const onChange = () => setMatches(mql.matches);
    onChange();                       // 挂载时对齐一次（SSR/初始渲染可能不准）
    // 老安卓只支持 addListener，新浏览器用 addEventListener
    if (mql.addEventListener) {
      mql.addEventListener('change', onChange);
      return () => mql.removeEventListener('change', onChange);
    }
    mql.addListener(onChange);
    return () => mql.removeListener(onChange);
  }, [query]);

  return matches;
}

/**
 * 是否窄屏（手机/竖屏平板）。
 *
 * 900px 而不是 768px：窄屏手机上"棋盘 + 右侧 260px 侧栏"根本放不下，
 * 而 768~900 这一段横屏手机同样需要抽屉式布局。
 */
export const MOBILE_QUERY = '(max-width: 900px)';

export function useIsMobile(): boolean {
  return useMediaQuery(MOBILE_QUERY);
}
