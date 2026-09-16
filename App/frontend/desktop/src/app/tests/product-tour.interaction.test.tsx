// @vitest-environment happy-dom

/** Product tour interaction tests. */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n/i18n-provider.js";
import { ProductTourGuide, type ProductTourTab } from "../product-tour.js";
import { writeProductTourStep } from "../routes.js";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("ProductTourGuide interactions", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    window.sessionStorage.clear();
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.replaceChildren();
    window.sessionStorage.clear();
    vi.restoreAllMocks();
  });

  it("does not navigate again when its parent re-renders with a new callback", () => {
    const firstOnTabChange = vi.fn<(tab: ProductTourTab) => void>();
    const nextOnTabChange = vi.fn<(tab: ProductTourTab) => void>();

    act(() => {
      root.render(renderGuide(firstOnTabChange));
    });

    expect(firstOnTabChange).toHaveBeenCalledOnce();
    expect(firstOnTabChange).toHaveBeenCalledWith("logs");

    act(() => {
      root.render(renderGuide(nextOnTabChange));
    });

    expect(nextOnTabChange).not.toHaveBeenCalled();
  });

  it("falls back to the last shown step when a persisted tools step is filtered out", () => {
    const onTabChange = vi.fn<(tab: ProductTourTab) => void>();
    writeProductTourStep(window.sessionStorage, 4);

    act(() => {
      root.render(renderGuide(onTabChange, { includeTools: false }));
    });

    expect(onTabChange).toHaveBeenCalledWith("overview");
    expect(onTabChange).not.toHaveBeenCalledWith("tools");
  });

  it("keeps the tools step as the last step for an identity that can use it", () => {
    const onTabChange = vi.fn<(tab: ProductTourTab) => void>();
    writeProductTourStep(window.sessionStorage, 4);

    act(() => {
      root.render(renderGuide(onTabChange));
    });

    expect(onTabChange).toHaveBeenCalledWith("tools");
  });
});

function renderGuide(onTabChange: (tab: ProductTourTab) => void, options: { includeTools?: boolean } = {}) {
  return (
    <I18nProvider language="zh-CN">
      <ProductTourGuide
        onDismiss={() => undefined}
        onTabChange={onTabChange}
        includeTools={options.includeTools ?? true}
      />
    </I18nProvider>
  );
}
