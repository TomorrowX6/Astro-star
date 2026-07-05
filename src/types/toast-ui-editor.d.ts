/**
 * @toast-ui/editor 的 package.json exports 未暴露类型入口，
 * 这里声明本项目用到的最小 API 面。
 */
declare module "@toast-ui/editor" {
  export interface EditorOptions {
    el: HTMLElement;
    height?: string;
    initialEditType?: "markdown" | "wysiwyg";
    previewStyle?: "tab" | "vertical";
    initialValue?: string;
    usageStatistics?: boolean;
    autofocus?: boolean;
    theme?: string;
    hooks?: {
      addImageBlobHook?: (
        blob: File,
        callback: (url: string, text?: string) => void,
      ) => void;
    };
  }

  export default class Editor {
    constructor(options: EditorOptions);
    getMarkdown(): string;
    setMarkdown(markdown: string, cursorToEnd?: boolean): void;
    insertText(text: string): void;
    changeMode(mode: "markdown" | "wysiwyg", isWithoutFocus?: boolean): void;
    on(type: string, handler: (...args: unknown[]) => void): void;
    off(type: string): void;
    destroy(): void;
  }
}
