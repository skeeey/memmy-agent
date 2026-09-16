/** Providers module. */
import { createContext, useContext, useMemo, useState, type Dispatch, type ReactNode, type SetStateAction } from "react";
import type { AppClients } from "../api/client-types.js";
import { I18nProvider } from "../i18n/i18n-provider.js";
import type { ResolvedLanguage } from "../i18n/messages.js";
import { TaskBusProvider } from "../lib/task-bus.js";
import { AppStateProvider, useAppState } from "../state/app-state.js";
import { ThemeProvider } from "../theme/theme-provider.js";
import { useWindowFullScreenSync } from "../utils/window-fullscreen.js";

/** Contract for api clients context value. */
export interface ApiClientsContextValue {
  clients: AppClients | null;
  setClients: Dispatch<SetStateAction<AppClients | null>>;
}

const ApiClientsContext = createContext<ApiClientsContextValue | null>(null);

/** Handles app providers. */
export function AppProviders(props: { children: ReactNode }) {
  return (
    <AppStateProvider>
      <ApiClientsProvider>
        <TaskBusProvider>
          <VisualProviders>{props.children}</VisualProviders>
        </TaskBusProvider>
      </ApiClientsProvider>
    </AppStateProvider>
  );
}

/** Handles api clients provider. */
function ApiClientsProvider(props: { children: ReactNode }) {
  const [clients, setClients] = useState<AppClients | null>(null);
  const value = useMemo(() => ({ clients, setClients }), [clients]);

  return <ApiClientsContext.Provider value={value}>{props.children}</ApiClientsContext.Provider>;
}

/** Handles visual providers. */
function VisualProviders(props: { children: ReactNode }) {
  const { state } = useAppState();
  const language = resolveDisplayLanguage(state.bootstrap?.app.language);
  const theme = state.bootstrap?.app.theme ?? "system";
  useWindowFullScreenSync();

  return (
    <I18nProvider language={language}>
      <ThemeProvider theme={theme}>{props.children}</ThemeProvider>
    </I18nProvider>
  );
}

/** Handles use api clients. */
export function useApiClients(): ApiClientsContextValue {
  const value = useContext(ApiClientsContext);

  if (!value) {
    throw new Error("useApiClients must be used within AppProviders");
  }

  return value;
}

/** Handles use optional api clients. */
export function useOptionalApiClients(): ApiClientsContextValue {
  return useContext(ApiClientsContext) ?? { clients: null, setClients: () => undefined };
}

/**
 * Resolves the interface language.
 *
 * An explicit user choice wins; otherwise the packaged edition decides, so an
 * international build starts in English without the user picking a language.
 *
 * @param configuredLanguage The language stored in the app settings.
 * @returns The concrete language to render.
 */
function resolveDisplayLanguage(configuredLanguage: string | undefined): ResolvedLanguage {
  if (configuredLanguage === "zh-CN" || configuredLanguage === "en-US") {
    return configuredLanguage;
  }

  return import.meta.env.MEMMY_APP_EDITION === "intl" ? "en-US" : "zh-CN";
}
